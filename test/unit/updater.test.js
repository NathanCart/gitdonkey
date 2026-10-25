'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  Updater, compareVersions, assetFor, parseRelease, releaseNotes, verifyFile, replaceProblem, swapBundle, replaceBundle, bundleInfo,
} = require('../../src/main/updater');

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gitdonkey-${prefix}-`)));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function memStore(init = {}) {
  const data = { ...init };
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

async function* chunked(buf, size = 4096, delay = 0) {
  for (let i = 0; i < buf.length; i += size) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    yield buf.subarray(i, i + size);
  }
}

function response(status, body, headers = {}, { delay = 0 } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => map.get(k.toLowerCase()) ?? null },
    json: async () => body,
    body: Buffer.isBuffer(body) ? chunked(body, 4096, delay) : null,
  };
}

const FEED = 'https://api.example.test/releases/latest';

function releaseJson(version, files = {}) {
  return {
    tag_name: `v${version}`,
    name: `GitDonkey ${version}`,
    html_url: `https://github.com/NathanCart/gitdonkey/releases/tag/v${version}`,
    published_at: '2026-10-20T12:00:00Z',
    body: '## What’s new\n\n- **Faster** graph\n- Fixes',
    draft: false,
    prerelease: false,
    assets: Object.entries(files).map(([name, buf]) => ({ name, size: buf.length, digest: `sha256:${sha(buf)}`, browser_download_url: `https://dl.example.test/${name}` })),
  };
}

/** A fake GitHub: `routes` maps URLs to a response or a function returning one. */
function fakeFetch(routes, calls = []) {
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const route = routes[url];
    if (route === undefined) throw new TypeError('fetch failed');
    return typeof route === 'function' ? route(init) : route;
  };
  return { fetch, calls };
}

function makeUpdater(o = {}) {
  return new Updater({
    store: memStore(),
    dir: tmp('updates'),
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    feedUrl: FEED,
    openPath: async () => '',
    quit: () => {},
    ...o,
  });
}

test('versions compare like semver, with or without a v', () => {
  assert.equal(compareVersions('1.0.1', 'v1.0.0'), 1);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.0-beta.10', '2.0.0-beta.2'), 1);
  assert.equal(compareVersions('2.0.0-alpha', '2.0.0-alpha.1'), -1);
  assert.equal(compareVersions('nonsense', '1.0.0'), -1);
});

test('release assets: the right build for each platform and CPU', () => {
  const assets = ['GitDonkey-1.1.0-mac-arm64.dmg', 'GitDonkey-1.1.0-mac-arm64.dmg.blockmap', 'GitDonkey-1.1.0-mac-x64.dmg', 'GitDonkey-Setup-1.1.0-x64.exe'].map((name) => ({ name }));
  assert.equal(assetFor(assets, 'darwin', 'arm64').name, 'GitDonkey-1.1.0-mac-arm64.dmg');
  assert.equal(assetFor(assets, 'darwin', 'x64').name, 'GitDonkey-1.1.0-mac-x64.dmg');
  assert.equal(assetFor(assets, 'win32', 'x64').name, 'GitDonkey-Setup-1.1.0-x64.exe');
  assert.equal(assetFor(assets, 'win32', 'arm64').name, 'GitDonkey-Setup-1.1.0-x64.exe', 'Windows on Arm runs the x64 build');
  assert.equal(assetFor(assets, 'linux', 'x64'), null);
  const linux = ['GitDonkey-1.5.0-linux-x86_64.AppImage', 'GitDonkey-1.5.0-linux-arm64.AppImage', 'GitDonkey-1.5.0-linux-amd64.deb', 'GitDonkey-1.5.0-linux-arm64.deb'].map((name) => ({ name }));
  assert.equal(assetFor(linux, 'linux', 'x64').name, 'GitDonkey-1.5.0-linux-x86_64.AppImage');
  assert.equal(assetFor(linux, 'linux', 'arm64').name, 'GitDonkey-1.5.0-linux-arm64.AppImage');
  assert.equal(assetFor(linux, 'linux', 'x64', { deb: true }).name, 'GitDonkey-1.5.0-linux-amd64.deb');
  assert.equal(assetFor(linux, 'linux', 'arm64', { deb: true }).name, 'GitDonkey-1.5.0-linux-arm64.deb');
});

test('releases: drafts and pre-releases are ignored, digests and notes kept', () => {
  const r = parseRelease(releaseJson('1.1.0', { 'GitDonkey-1.1.0-mac-arm64.dmg': Buffer.from('dmg') }));
  assert.equal(r.version, '1.1.0');
  assert.equal(r.url, 'https://github.com/NathanCart/gitdonkey/releases/tag/v1.1.0');
  assert.equal(r.publishedAt, Date.parse('2026-10-20T12:00:00Z'));
  assert.equal(r.assets[0].digest, sha(Buffer.from('dmg')));
  assert.deepEqual(r.notes, [{ kind: 'h', text: 'What’s new' }, { kind: 'li', text: 'Faster graph' }, { kind: 'li', text: 'Fixes' }]);
  assert.equal(parseRelease({ ...releaseJson('1.2.0'), prerelease: true }), null);
  assert.equal(parseRelease({ ...releaseJson('1.2.0'), draft: true }), null);
  assert.equal(parseRelease({ tag_name: 'nightly' }), null);
  const evil = parseRelease({ ...releaseJson('1.2.0'), html_url: 'javascript:alert(1)', assets: [{ name: 'x.dmg', browser_download_url: 'file:///etc/passwd' }] });
  assert.match(evil.url, /^https:\/\/github\.com\//);
  assert.deepEqual(evil.assets, []);
});

test('release notes: Markdown becomes plain headings, list items and paragraphs', () => {
  const md = [
    '# GitDonkey 1.1.0', '', 'The **update** release, with [a link](https://x.test) and `code`.', 'Same paragraph.', '',
    '- First item', '  carries on here', '* Second _item_ with snake_case_names', '1. Numbered', '', '```', 'skipped code', '```',
    '---', '> Quoted', '![shot](https://x.test/a.png)', '<details>hidden</details>',
  ].join('\r\n');
  assert.deepEqual(releaseNotes(md), [
    { kind: 'h', text: 'GitDonkey 1.1.0' },
    { kind: 'p', text: 'The update release, with a link and code. Same paragraph.' },
    { kind: 'li', text: 'First item carries on here' },
    { kind: 'li', text: 'Second item with snake_case_names' },
    { kind: 'li', text: 'Numbered' },
    { kind: 'p', text: 'Quoted hidden' },
  ]);
  assert.deepEqual(releaseNotes(''), []);
  assert.equal(releaseNotes(Array.from({ length: 100 }, (_, i) => `- item ${i}`).join('\n')).length, 40);
});

test('check: a newer release is offered with the asset for this computer', async () => {
  const dmg = Buffer.from('new app');
  const { fetch, calls } = fakeFetch({ [FEED]: response(200, releaseJson('1.1.0', { 'GitDonkey-1.1.0-mac-arm64.dmg': dmg, 'GitDonkey-Setup-1.1.0-x64.exe': Buffer.from('exe') }), { etag: '"abc"' }) });
  const u = makeUpdater({ fetch, bundle: '/Applications/GitDonkey.app' });
  const events = [];
  u.on('state', (s) => events.push(s.status));
  const s = await u.check();
  assert.equal(s.status, 'available');
  assert.equal(s.release.version, '1.1.0');
  assert.equal(s.asset.name, 'GitDonkey-1.1.0-mac-arm64.dmg');
  assert.equal(s.install, 'replace');
  assert.deepEqual(events, ['available']);
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(u.store.data.updates.etag, '"abc"');
  // Concurrent checks share one request.
  await Promise.all([u.check(), u.check()]);
  assert.equal(calls.length, 2);
});

test('check: the same version is current; a 304 reuses the cached release', async () => {
  let served = 0;
  const { fetch, calls } = fakeFetch({
    [FEED]: (init) => {
      served++;
      return init.headers['If-None-Match'] === '"v1"' ? response(304, null) : response(200, releaseJson('1.0.0'), { ETag: '"v1"' });
    },
  });
  const u = makeUpdater({ fetch });
  assert.equal((await u.check()).status, 'current');
  assert.equal((await u.check()).status, 'current');
  assert.equal(calls[1].headers['If-None-Match'], '"v1"');
  assert.equal(served, 2);
  // An older version on the server is never offered.
  const older = makeUpdater({ fetch: fakeFetch({ [FEED]: response(200, releaseJson('0.9.0')) }).fetch });
  assert.equal((await older.check()).status, 'current');
  // No releases at all yet.
  const none = makeUpdater({ fetch: fakeFetch({ [FEED]: response(404, {}) }).fetch });
  assert.equal((await none.check()).status, 'current');
});

test('check: offline, rate-limited or switched off stays quiet unless asked', async () => {
  const offline = makeUpdater({ fetch: fakeFetch({}).fetch });
  assert.equal((await offline.check()).status, 'idle');
  await assert.rejects(offline.check({ manual: true }), { kind: 'UPDATE_OFFLINE' });

  const limited = makeUpdater({ fetch: fakeFetch({ [FEED]: response(403, { message: 'API rate limit exceeded' }) }).fetch });
  assert.equal((await limited.check()).status, 'idle');
  await assert.rejects(limited.check({ manual: true }), { kind: 'UPDATE_RATE_LIMITED', message: /limiting requests/ });

  const broken = makeUpdater({ fetch: fakeFetch({ [FEED]: { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad'); } } }).fetch });
  await assert.rejects(broken.check({ manual: true }), { kind: 'UPDATE_HTTP' });

  const { fetch, calls } = fakeFetch({ [FEED]: response(200, releaseJson('1.1.0')) });
  const off = makeUpdater({ fetch, store: memStore({ settings: { checkUpdates: false } }) });
  assert.equal((await off.check()).status, 'idle');
  assert.equal(calls.length, 0, 'switched off: no request');
  assert.equal((await off.check({ manual: true })).status, 'available', 'Check for Updates… still works');

  const quiet = makeUpdater({ fetch, offline: true });
  await quiet.check();
  assert.equal(calls.length, 1, 'GITDONKEY_OFFLINE: no request');
});

test('skip remembers the version; downloading it clears the skip', async () => {
  const dmg = crypto.randomBytes(20000);
  const asset = 'GitDonkey-1.1.0-mac-arm64.dmg';
  const u = makeUpdater({ fetch: fakeFetch({ [FEED]: response(200, releaseJson('1.1.0', { [asset]: dmg })), [`https://dl.example.test/${asset}`]: () => response(200, dmg) }).fetch });
  await u.check();
  u.skip('1.1.0');
  assert.equal(u.state().skipped, '1.1.0');
  assert.equal(u.store.data.updates.skipped, '1.1.0');
  await u.download();
  assert.equal(u.state().skipped, null);
});

test('download: streams to disk with progress, checks the size and SHA-256', async () => {
  const dmg = crypto.randomBytes(300 * 1024);
  const asset = 'GitDonkey-1.1.0-mac-arm64.dmg';
  const url = `https://dl.example.test/${asset}`;
  let body = dmg;
  const routes = { [FEED]: response(200, releaseJson('1.1.0', { [asset]: dmg })), [url]: () => response(200, body, {}, { delay: 2 }) };
  const { fetch, calls } = fakeFetch(routes);
  const u = makeUpdater({ fetch });
  await u.check();
  const seen = [];
  u.on('state', (s) => seen.push(s));
  const done = await u.download();
  assert.equal(done.status, 'ready');
  assert.equal(done.error, null);
  const file = path.join(u.dir, asset);
  assert.ok(fs.readFileSync(file).equals(dmg));
  assert.equal(seen[0].status, 'downloading');
  assert.ok(seen.some((s) => s.progress && s.progress.received > 0 && s.progress.total === dmg.length), 'reported progress');
  assert.ok(!fs.existsSync(`${file}.part`));

  // A finished download is reused, not fetched again.
  const again = makeUpdater({ fetch, dir: u.dir });
  await again.check();
  const before = calls.length;
  assert.equal((await again.download()).status, 'ready');
  assert.equal(calls.length, before);

  // Tampered bytes of the right size fail the checksum and are thrown away.
  fs.rmSync(file);
  body = crypto.randomBytes(dmg.length);
  const tampered = makeUpdater({ fetch, dir: u.dir });
  await tampered.check();
  const t = await tampered.download();
  assert.equal(t.status, 'available');
  assert.match(t.error, /checksum/);
  assert.deepEqual(fs.readdirSync(u.dir), []);

  // A short download fails too.
  body = dmg.subarray(0, 1000);
  const short = makeUpdater({ fetch, dir: u.dir });
  await short.check();
  assert.match((await short.download()).error, /cut short/);

  // An HTTP error from the download host.
  routes[url] = () => response(500, null);
  const failed = makeUpdater({ fetch, dir: u.dir });
  await failed.check();
  assert.match((await failed.download()).error, /HTTP 500/);
});

test('download: cancel stops it, keeps nothing and is not an error', async () => {
  const dmg = crypto.randomBytes(400 * 1024);
  const asset = 'GitDonkey-1.1.0-mac-arm64.dmg';
  const u = makeUpdater({ fetch: fakeFetch({ [FEED]: response(200, releaseJson('1.1.0', { [asset]: dmg })), [`https://dl.example.test/${asset}`]: () => response(200, dmg, {}, { delay: 5 }) }).fetch });
  await u.check();
  u.on('state', (s) => {
    if (s.progress && s.progress.received > 0) u.cancel();
  });
  const s = await u.download();
  assert.equal(s.status, 'available');
  assert.equal(s.error, null);
  assert.deepEqual(fs.readdirSync(u.dir), []);
});

test('download: no build for this computer sends the user to the release page', async () => {
  const u = makeUpdater({ platform: 'linux', arch: 'x64', fetch: fakeFetch({ [FEED]: response(200, releaseJson('1.1.0', { 'GitDonkey-1.1.0-mac-arm64.dmg': Buffer.from('x') })) }).fetch });
  const s = await u.check();
  assert.equal(s.install, 'page');
  assert.match((await u.download()).error, /release page/);
});

async function readyUpdater(o) {
  const exe = Buffer.from('installer');
  const name = o.platform === 'win32' ? 'GitDonkey-Setup-1.1.0-x64.exe' : 'GitDonkey-1.1.0-mac-arm64.dmg';
  const u = makeUpdater({ fetch: fakeFetch({ [FEED]: response(200, releaseJson('1.1.0', { [name]: exe })), [`https://dl.example.test/${name}`]: () => response(200, exe) }).fetch, ...o });
  await u.check();
  await u.download();
  assert.equal(u.status, 'ready');
  return u;
}

test('install: Windows runs the installer silently and quits', { skip: process.platform === 'win32' }, async () => {
  const opened = [];
  let quit = 0;
  const u = await readyUpdater({ platform: 'win32', arch: 'x64', packaged: true, openPath: async (p) => { opened.push(p); return ''; }, quit: () => { quit++; } });
  assert.equal(u.installKind(), 'installer');
  // Stand in a script for the NSIS installer that records its arguments.
  const marker = path.join(u.dir, 'args.txt');
  fs.writeFileSync(u.file, `#!/bin/sh\necho "$@" > "${marker}"\n`);
  fs.chmodSync(u.file, 0o755);
  assert.deepEqual(await u.install(), { done: 'restarting' });
  assert.equal(quit, 1);
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '/S --updated --force-run');
  assert.deepEqual(opened, []);
});

test('install: falls back to opening the installer when it can’t replace the app', async () => {
  const opened = [];
  let quit = 0;
  // Running from source: there's no bundle to replace.
  const dev = await readyUpdater({ platform: 'darwin', openPath: async (p) => { opened.push(p); return ''; }, quit: () => { quit++; } });
  assert.equal(dev.installKind(), 'open');
  assert.deepEqual(await dev.install(), { done: 'opened', reason: null });
  assert.deepEqual(opened, [dev.file]);
  assert.equal(dev.status, 'ready');

  // A bundle in a folder GitDonkey can't write to.
  const parent = tmp('ro');
  const bundle = path.join(parent, 'GitDonkey.app');
  fs.mkdirSync(bundle);
  fs.chmodSync(parent, 0o555);
  try {
    const ro = await readyUpdater({ platform: 'darwin', bundle, openPath: async (p) => { opened.push(p); return ''; }, quit: () => { quit++; } });
    const r = await ro.install();
    assert.equal(r.done, 'opened');
    assert.match(r.reason, /can’t write to/);
  } finally {
    fs.chmodSync(parent, 0o755);
  }
  assert.equal(quit, 0);

  // And when even that fails, the error says so.
  const stuck = await readyUpdater({ platform: 'darwin', openPath: async () => 'No application knows how to open it' });
  await assert.rejects(stuck.install(), { kind: 'UPDATE_INSTALL', message: /No application/ });
  assert.equal(stuck.state().error, 'No application knows how to open it');
});

test('install: an AppImage replaces itself and relaunches; a .deb install opens the new package', { skip: process.platform === 'win32' }, async () => {
  const name = 'GitDonkey-1.1.0-linux-x86_64.AppImage';
  const next = Buffer.from('#!/bin/sh\necho new\n');
  const appDir = tmp('appimage');
  const current = path.join(appDir, 'GitDonkey.AppImage');
  fs.writeFileSync(current, '#!/bin/sh\necho old\n', { mode: 0o755 });
  let quit = 0;
  const feed = { [FEED]: response(200, releaseJson('1.1.0', { [name]: next, 'GitDonkey-1.1.0-linux-amd64.deb': Buffer.from('deb') })), [`https://dl.example.test/${name}`]: () => response(200, next), 'https://dl.example.test/GitDonkey-1.1.0-linux-amd64.deb': () => response(200, Buffer.from('deb')) };
  const u = makeUpdater({ platform: 'linux', arch: 'x64', appImage: current, packaged: true, fetch: fakeFetch(feed).fetch, quit: () => { quit++; } });
  await u.check();
  assert.equal(u.asset.name, name);
  assert.equal(u.installKind(), 'appimage');
  await u.download();
  assert.deepEqual(await u.install(), { done: 'restarting' });
  assert.equal(quit, 1);
  assert.equal(fs.readFileSync(current, 'utf8'), next.toString());
  assert.equal(fs.statSync(current).mode & 0o111, 0o111, 'still executable');
  assert.deepEqual(fs.readdirSync(appDir), ['GitDonkey.AppImage']);

  const opened = [];
  const d = makeUpdater({ platform: 'linux', arch: 'x64', deb: true, packaged: true, fetch: fakeFetch(feed).fetch, openPath: async (p) => { opened.push(p); return ''; } });
  await d.check();
  assert.equal(d.asset.name, 'GitDonkey-1.1.0-linux-amd64.deb');
  assert.equal(d.installKind(), 'open');
  await d.download();
  assert.equal((await d.install()).done, 'opened');
  assert.deepEqual(opened, [d.file]);
});

test('replace problems: translocated, read-only and non-bundle paths', async () => {
  assert.match(await replaceProblem('/private/var/folders/x/AppTranslocation/ABC/d/GitDonkey.app'), /temporary copy/);
  assert.match(await replaceProblem('/usr/local/bin/gitdonkey'), /app bundle/);
  const dir = tmp('bundle');
  fs.mkdirSync(path.join(dir, 'GitDonkey.app'));
  assert.equal(await replaceProblem(path.join(dir, 'GitDonkey.app')), null);
});

test('bundle swap puts the old app back when the new one can’t move in', async () => {
  const dir = tmp('swap');
  const bundle = path.join(dir, 'GitDonkey.app');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'version'), 'old');
  await assert.rejects(swapBundle(bundle, path.join(dir, '.missing.app'), path.join(dir, '.old.app')), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(bundle, 'version'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['GitDonkey.app']);
});

function fakeBundle(dir, { id = 'dev.gitdonkey.unit', version }) {
  const app = path.join(dir, 'GitDonkey.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GitDonkey</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`);
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'GitDonkey'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return app;
}

test('macOS: replaces the bundle from a DMG, and refuses a DMG of another app or version', { skip: process.platform !== 'darwin' }, async () => {
  const work = tmp('dmg');
  for (const d of ['Applications', 'Other', 'src']) fs.mkdirSync(path.join(work, d));
  const installed = fakeBundle(path.join(work, 'Applications'), { version: '1.0.0' });
  const other = fakeBundle(path.join(work, 'Other'), { id: 'com.example.other', version: '1.0.0' });
  fakeBundle(path.join(work, 'src'), { version: '1.1.0' });
  const dmg = path.join(work, 'new.dmg');
  execFileSync('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'GitDonkey 1.1.0', '-srcfolder', path.join(work, 'src'), '-format', 'UDZO', dmg]);

  await assert.rejects(replaceBundle({ dmg, bundle: installed, version: '1.2.0', verified: true }), { kind: 'UPDATE_BAD_DMG', message: /version 1.1.0, not 1.2.0/ });
  await assert.rejects(replaceBundle({ dmg, bundle: other, version: '1.1.0', verified: true }), { kind: 'UPDATE_BAD_DMG', message: /holds dev\.gitdonkey\.unit, not com\.example\.other/ });
  assert.equal((await bundleInfo(installed)).version, '1.0.0', 'untouched after a refusal');
  assert.equal((await bundleInfo(other)).version, '1.0.0');

  await replaceBundle({ dmg, bundle: installed, version: '1.1.0', verified: true });
  assert.deepEqual(await bundleInfo(installed), { id: 'dev.gitdonkey.unit', version: '1.1.0' });
  assert.deepEqual(fs.readdirSync(path.dirname(installed)), ['GitDonkey.app'], 'no staged or old copies left');
  assert.equal(execFileSync(path.join(installed, 'Contents', 'MacOS', 'GitDonkey'), { encoding: 'utf8' }).trim(), '1.1.0');
});

test('verifyFile checks size and digest', async () => {
  const dir = tmp('verify');
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, 'hello');
  assert.equal(await verifyFile(file, { size: 5, digest: sha(Buffer.from('hello')) }), true);
  assert.equal(await verifyFile(file, { size: 6, digest: null }), false);
  assert.equal(await verifyFile(file, { size: 5, digest: sha(Buffer.from('jello')) }), false);
  assert.equal(await verifyFile(path.join(dir, 'missing'), { size: 0 }), false);
});

test('cleanup removes old downloads and half-finished swaps', async () => {
  const dir = tmp('cleanup');
  const apps = tmp('apps');
  fs.writeFileSync(path.join(dir, 'GitDonkey-0.9.0-mac-arm64.dmg'), 'old');
  fs.writeFileSync(path.join(dir, 'GitDonkey-1.1.0-mac-arm64.dmg.part'), 'partial');
  fs.writeFileSync(path.join(dir, 'GitDonkey-1.1.0-mac-arm64.dmg'), 'current');
  for (const n of ['GitDonkey.app', '.GitDonkey-old-123.app', '.GitDonkey-1.1.0-123.app', 'Other.app']) fs.mkdirSync(path.join(apps, n));
  const store = memStore({ updates: { release: parseRelease(releaseJson('1.1.0', { 'GitDonkey-1.1.0-mac-arm64.dmg': Buffer.from('current') })) } });
  const u = makeUpdater({ dir, store, bundle: path.join(apps, 'GitDonkey.app') });
  await u.cleanup();
  assert.deepEqual(fs.readdirSync(dir), ['GitDonkey-1.1.0-mac-arm64.dmg']);
  assert.deepEqual(fs.readdirSync(apps).sort(), ['GitDonkey.app', 'Other.app']);
});
