'use strict';

// End-to-end: the update notice and the update itself, against a fake GitHub
// release feed on 127.0.0.1 that always has a release one major version ahead.
// On macOS it goes all the way: download the DMG, swap a stand-in app bundle
// for the one inside it, and reopen it. Screenshots land in test/e2e/shots/.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./harness');

const CURRENT = require('../../package.json').version;
const NEXT = `${Number(CURRENT.split('.')[0]) + 1}.0.0`;
const isMac = process.platform === 'darwin';
const ASSET = {
  'darwin-arm64': `GitDonkey-${NEXT}-mac-arm64.dmg`,
  'darwin-x64': `GitDonkey-${NEXT}-mac-x64.dmg`,
  'win32-x64': `GitDonkey-Setup-${NEXT}-x64.exe`,
}[`${process.platform}-${process.arch}`];
const FEED_PATH = '/repos/NathanCart/gitdonkey/releases/latest';
const PUBLISHED = new Date(Date.now() - 2 * 86400000).toISOString();
const NOTES = '## What’s new\n\n- **Faster** graph on big repositories\n- Update notices, with [release notes](https://example.test)\n\nThanks for using GitDonkey.';

const results = [];
let t;

async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    await t.shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
  }
}

const win = () => t.win;
const card = () => win().locator('.update-card');
const cardKey = (label) => card().locator(`[data-update="${label}"]`);
const statusKey = () => win().locator('.st-update');
const modal = () => win().locator('.modal').last();
const updateState = () => win().evaluate(() => window.gitdonkey.invoke('update:state'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Click GitDonkey ▸ Check for Updates… (Help ▸ on Windows) in the real application menu. */
function menuCheck() {
  return t.app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const it of items) {
        if (it.label === 'Check for Updates…') return it;
        const sub = it.submenu && find(it.submenu.items);
        if (sub) return sub;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error('no Check for Updates… menu item');
    item.click();
    return true;
  });
}

function releaseJson(version, port, files) {
  return {
    tag_name: `v${version}`,
    name: `GitDonkey ${version}`,
    html_url: `https://github.com/NathanCart/gitdonkey/releases/tag/v${version}`,
    published_at: PUBLISHED,
    draft: false,
    prerelease: false,
    body: NOTES,
    assets: [...files].map(([name, buf]) => ({
      name, size: buf.length, digest: `sha256:${sha256(buf)}`, browser_download_url: `http://127.0.0.1:${port}/download/${encodeURIComponent(name)}`,
    })),
  };
}

/** A stand-in for GitHub: the releases API (with ETags) and slow asset downloads. */
async function feedServer(files) {
  const feed = { version: NEXT, requests: [] };
  const server = http.createServer((req, res) => {
    if (req.url === FEED_PATH) {
      const body = JSON.stringify(releaseJson(feed.version, server.address().port, files));
      const etag = `"${sha256(body).slice(0, 16)}"`;
      const conditional = req.headers['if-none-match'] || null;
      const status = conditional === etag ? 304 : 200;
      feed.requests.push({ conditional, status });
      res.writeHead(status, { 'content-type': 'application/json', etag });
      res.end(status === 304 ? undefined : body);
      return;
    }
    const m = req.url.match(/^\/download\/(.+)$/);
    const file = m && files.get(decodeURIComponent(m[1]));
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length });
    // Dribble it out so the progress bar has something to show.
    const size = Math.ceil(file.length / 40);
    let at = 0;
    const tick = () => {
      if (at >= file.length) return res.end();
      res.write(file.subarray(at, (at += size)));
      setTimeout(tick, 50);
    };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  feed.url = `http://127.0.0.1:${server.address().port}${FEED_PATH}`;
  feed.close = () => server.close();
  return feed;
}

/**
 * macOS: an "installed" GitDonkey.app at CURRENT and a DMG holding one at NEXT.
 * Their executable is a tiny real binary (LaunchServices won't open a script)
 * that leaves a `relaunched` file beside its bundle, so the test can see the
 * new app was opened. Without a C compiler the bundles get /usr/bin/true.
 */
function macFixture(work) {
  const launcher = path.join(work, 'launcher');
  let marks = true;
  try {
    const src = path.join(work, 'launcher.c');
    fs.writeFileSync(src, `#include <stdio.h>
#include <libgen.h>
#include <mach-o/dyld.h>
int main(void) {
  char exe[4096], out[4200];
  uint32_t n = sizeof exe;
  if (_NSGetExecutablePath(exe, &n)) return 1;
  snprintf(out, sizeof out, "%s/relaunched", dirname(dirname(dirname(dirname(exe)))));
  FILE *f = fopen(out, "w");
  if (f) fclose(f);
  return 0;
}
`);
    execFileSync('cc', ['-O2', '-o', launcher, src], { stdio: 'ignore' });
  } catch {
    fs.copyFileSync('/usr/bin/true', launcher);
    marks = false;
  }
  const bundle = (dir, version) => {
    const app = path.join(dir, 'GitDonkey.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GitDonkey</string>
<key>CFBundleIdentifier</key><string>dev.gitdonkey.e2e-standin</string>
<key>CFBundleName</key><string>GitDonkey</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
    fs.copyFileSync(launcher, path.join(app, 'Contents', 'MacOS', 'GitDonkey'));
    fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'GitDonkey'), 0o755);
    return app;
  };
  const next = path.join(work, 'dmg-src');
  for (const d of ['Applications', 'dmg-src']) fs.mkdirSync(path.join(work, d));
  const installed = bundle(path.join(work, 'Applications'), CURRENT);
  bundle(next, NEXT);
  fs.symlinkSync('/Applications', path.join(next, 'Applications'));
  const dmg = path.join(work, ASSET);
  execFileSync('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', `GitDonkey ${NEXT}`, '-srcfolder', next, '-format', 'UDZO', dmg]);
  return { installed, dmg: fs.readFileSync(dmg), marks };
}

const plistVersion = (app) => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

async function main() {
  if (!ASSET) {
    console.log(`No GitDonkey build for ${process.platform}-${process.arch}; nothing to test.`);
    return;
  }
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-update-e2e-')));
  const mac = isMac ? macFixture(work) : null;
  const files = new Map([[ASSET, mac ? mac.dmg : Buffer.from('MZ stand-in installer')]]);
  for (const other of [`GitDonkey-${NEXT}-mac-arm64.dmg`, `GitDonkey-${NEXT}-mac-x64.dmg`, `GitDonkey-Setup-${NEXT}-x64.exe`]) if (!files.has(other)) files.set(other, Buffer.from(`not for this computer: ${other}`));
  const feed = await feedServer(files);
  try {
    t = await launch({
      env: {
        GITDONKEY_UPDATE_FEED: feed.url,
        GITDONKEY_UPDATE_DELAY: '300',
        ...(mac ? { GITDONKEY_UPDATE_BUNDLE: mac.installed } : {}),
      },
    });
    console.log(`Feed: ${feed.url}  (running ${CURRENT}, serving ${NEXT})`);
    await win().waitForSelector('.g-row', { timeout: 20000 });
    await run(feed, mac, files);
  } finally {
    feed.close();
  }
}

async function run(feed, mac, files) {
  const userData = path.join(t.work, 'userdata');

  await step('a newer release shows the update notice on launch', async () => {
    await card().waitFor({ timeout: 10000 });
    const text = await card().textContent();
    for (const want of [`GitDonkey ${NEXT} is available`, `You have ${CURRENT}`, 'released 2 days ago', 'Release notes']) if (!text.includes(want)) throw new Error(`card says: ${text}`);
    const notes = await card().locator('.update-notes > *').allTextContents();
    if (notes.join('|') !== 'What’s new|Faster graph on big repositories|Update notices, with release notes|Thanks for using GitDonkey.') throw new Error(`notes: ${notes.join('|')}`);
    // One white keycap, and the card stays clear of the commit module.
    const keys = await card().locator('.btn-key').allTextContents();
    if (keys.join() !== 'Update') throw new Error(`keycaps: ${keys}`);
    const [c, p] = await Promise.all([card().boundingBox(), win().locator('#panel').boundingBox()]);
    if (c.x + c.width > p.x) throw new Error(`card (right ${c.x + c.width}) covers the commit module (left ${p.x})`);
    if ((await statusKey().textContent()) !== `Update to ${NEXT}`) throw new Error(`status key: ${await statusKey().textContent()}`);
    if (feed.requests.length !== 1 || feed.requests[0].conditional) throw new Error(`feed requests: ${JSON.stringify(feed.requests)}`);
    await t.shot('21-update-available');
  });

  await step('Later puts it away and the status strip key brings it back', async () => {
    await cardKey('Later').click();
    await card().waitFor({ state: 'detached' });
    await statusKey().click();
    await card().waitFor();
    await card().locator('.toast-x').click();
    await card().waitFor({ state: 'detached' });
    await statusKey().click();
    await card().waitFor();
  });

  await step('Skip this version hides it and is remembered', async () => {
    await cardKey('Skip this version').click();
    await card().waitFor({ state: 'detached' });
    await waitFor(async () => (await statusKey().count()) === 0, { message: 'status key gone' });
    if ((await updateState()).skipped !== NEXT) throw new Error('skip not in the updater state');
    await waitFor(() => {
      const saved = JSON.parse(fs.readFileSync(path.join(userData, 'gitdonkey-state.json'), 'utf8'));
      return saved.updates && saved.updates.skipped === NEXT;
    }, { message: 'skip saved to disk' });
  });

  await step('Check for Updates… in the app menu still shows a skipped version, with a conditional request', async () => {
    await menuCheck();
    await card().waitFor();
    if (await cardKey('Skip this version').count()) throw new Error('offers to skip a version already skipped');
    const last = feed.requests[feed.requests.length - 1];
    if (!last.conditional || last.status !== 304) throw new Error(`last request: ${JSON.stringify(last)}`);
  });

  await step('Check for Updates… says so when GitDonkey is up to date', async () => {
    feed.version = CURRENT;
    await menuCheck();
    await win().locator('.toast', { hasText: 'GitDonkey is up to date' }).waitFor();
    await card().waitFor({ state: 'detached' });
    if (await statusKey().count()) throw new Error('status key shown while up to date');
    feed.version = NEXT;
    await menuCheck();
    await card().waitFor();
  });

  await step('Settings has the off switch for automatic checks', async () => {
    const toggle = async (on) => {
      await win().locator('.key[data-key="settings"]').click();
      const row = modal().locator('.check', { hasText: 'Check for updates automatically' });
      if (!(await row.textContent()).includes(`You have GitDonkey ${CURRENT}`)) throw new Error(`hint: ${await row.textContent()}`);
      const box = row.locator('input[type=checkbox]');
      if ((await box.isChecked()) === on) throw new Error(`already ${on ? 'on' : 'off'}`);
      if (on) await box.check({ force: true });
      else await box.uncheck({ force: true });
      if (!on) await t.shot('24-update-settings');
      await modal().locator('.btn-key', { hasText: 'Save' }).click();
      await waitFor(async () => (await updateState()).enabled === on, { message: `checks ${on ? 'on' : 'off'}` });
    };
    await toggle(false);
    await toggle(true);
    await win().locator('.toast').filter({ hasText: 'Settings saved' }).first().waitFor();
  });

  await step('Update downloads the build for this computer, with progress', async () => {
    await card().waitFor();
    await cardKey('Update').click();
    await card().locator('.update-progress').waitFor();
    await waitFor(async () => /^\d+(\.\d)? [KM]B of \d+(\.\d)? [KM]B$/.test(await card().locator('.update-bytes').textContent()), { message: 'byte count' });
    await waitFor(async () => /^Downloading .* · \d+%$/.test(await statusKey().textContent()), { message: 'progress on the status strip' });
    await t.shot('22-update-downloading');
    await card().filter({ hasText: `GitDonkey ${NEXT} is ready` }).waitFor({ timeout: 20000 });
    const file = path.join(userData, 'updates', ASSET);
    if (sha256(fs.readFileSync(file)) !== sha256(files.get(ASSET))) throw new Error('downloaded file differs');
    if ((await updateState()).skipped) throw new Error('downloading should clear the skip');
    if (mac) {
      // Written by GitDonkey itself, so no quarantine flag and no "Open Anyway".
      const attrs = execFileSync('xattr', ['-l', file], { encoding: 'utf8' });
      if (/com\.apple\.quarantine/.test(attrs)) throw new Error(`download is quarantined: ${attrs}`);
      if ((await statusKey().textContent()) !== 'Restart to update') throw new Error(`status key: ${await statusKey().textContent()}`);
    }
    await t.shot('23-update-ready');
  });

  const consoleErrors = t.errors.filter((e) => !/Electron Security Warning/.test(e));
  await step('no renderer errors were logged', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
  });

  if (!mac) {
    console.log('  - installing is only exercised on macOS (Windows would run the real installer)');
    return;
  }

  await step('Restart to update swaps in the new app bundle and reopens it', async () => {
    const exited = new Promise((resolve) => t.app.process().once('exit', resolve));
    await win().locator('.commit-summary').fill('');
    await cardKey('Restart to update').click();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('GitDonkey did not quit')), 20000))]);
    if (plistVersion(mac.installed) !== NEXT) throw new Error(`installed version ${plistVersion(mac.installed)}`);
    const attrs = execFileSync('xattr', ['-lr', mac.installed], { encoding: 'utf8' });
    if (/com\.apple\.quarantine/.test(attrs)) throw new Error(`new bundle is quarantined: ${attrs}`);
    if (mac.marks) await waitFor(() => fs.existsSync(path.join(path.dirname(mac.installed), 'relaunched')), { message: 'the new app to be opened', timeout: 15000 });
    else console.log('      (no C compiler: skipped checking the relaunch)');
    const left = fs.readdirSync(path.dirname(mac.installed)).filter((n) => n !== 'relaunched');
    if (left.join() !== 'GitDonkey.app') throw new Error(`left behind: ${left}`);
  });
}

main()
  .catch((e) => {
    console.error('Fatal:', e);
    results.push({ name: 'fatal', ok: false, error: e.message });
  })
  .finally(async () => {
    if (t) await t.app.close().catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
