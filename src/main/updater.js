'use strict';

// Updates for an app that isn't code-signed. GitDonkey checks its latest GitHub
// release, downloads the installer for this computer in the main process, and
// installs it itself:
//
// - macOS: Squirrel.Mac (and so electron-updater) needs a Developer ID
//   signature, so it's out. A file GitDonkey writes itself carries no
//   com.apple.quarantine flag (only browsers and apps that opt in with
//   LSFileQuarantineEnabled add one), so the app copied out of the downloaded
//   DMG opens without the "Open Anyway" trip to Privacy & Security. Restart
//   swaps the bundle in place and reopens it. When GitDonkey can't write to its
//   own folder, it opens the DMG instead for a drag to Applications.
// - Windows: the NSIS installer runs silently over the current install and
//   starts GitDonkey again (the flags electron-updater passes it). A file the
//   app writes has no Mark of the Web, so SmartScreen doesn't step in.
// - Anywhere else, or with no build for this CPU: the release page.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { execFile, spawn } = require('child_process');

const REPO = 'NathanCart/gitdonkey';
const FEED_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK = 4000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT = 15000;
const STALL_TIMEOUT = 60000;
const BUSY = new Set(['downloading', 'ready', 'installing']);

// The release asset for each platform and CPU, by the end of its file name.
const ASSETS = {
  'darwin-arm64': 'mac-arm64.dmg',
  'darwin-x64': 'mac-x64.dmg',
  'win32-x64': 'x64.exe',
  'win32-arm64': 'x64.exe', // runs under Windows' x64 emulation
  'linux-x64': 'linux-x86_64.AppImage',
  'linux-arm64': 'linux-arm64.AppImage',
};
// Installed from a .deb (not run as an AppImage): the next .deb.
const DEBS = {
  'linux-x64': 'linux-amd64.deb',
  'linux-arm64': 'linux-arm64.deb',
};

class UpdateError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- releases

function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver order: -1, 0 or 1. Anything unparseable sorts first. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function assetFor(assets, platform, arch, { deb = false } = {}) {
  const suffix = (deb ? DEBS : ASSETS)[`${platform}-${arch}`];
  if (!suffix) return null;
  return (assets || []).find((a) => a.name.toLowerCase().endsWith(suffix.toLowerCase())) || null;
}

/** Release notes Markdown as plain blocks for the notice: headings, list items, paragraphs. */
function releaseNotes(md, max = 40) {
  const inline = (s) => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const blocks = [];
  let para = [];
  const flush = () => {
    const text = inline(para.join(' '));
    if (text) blocks.push({ kind: 'p', text });
    para = [];
  };
  let fence = false;
  for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    let m;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
    } else if (fence) continue;
    else if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) flush();
    else if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)[\s#]*$/))) {
      flush();
      blocks.push({ kind: 'h', text: inline(m[1]) });
    } else if ((m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      blocks.push({ kind: 'li', text: inline(m[1]) });
    } else if (!para.length && blocks.length && blocks[blocks.length - 1].kind === 'li' && /^\s{2,}\S/.test(line)) {
      blocks[blocks.length - 1].text += ` ${inline(line)}`;
    } else para.push(line.replace(/^\s*>\s?/, ''));
    if (blocks.length >= max) break;
  }
  flush();
  return blocks.filter((b) => b.text).slice(0, max);
}

/** The GitHub API's release object, trimmed to what the notice needs. Drafts and pre-releases don't count. */
function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const tag = String(json.tag_name || '');
  const version = tag.replace(/^v/i, '');
  if (!parseVersion(version)) return null;
  const https = (u) => typeof u === 'string' && /^https?:\/\//.test(u);
  return {
    version,
    name: json.name || `GitDonkey ${version}`,
    url: https(json.html_url) ? json.html_url : `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: Date.parse(json.published_at) || null,
    notes: releaseNotes(json.body),
    assets: (Array.isArray(json.assets) ? json.assets : [])
      .filter((a) => a && typeof a.name === 'string' && https(a.browser_download_url))
      .map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: Number(a.size) || 0,
        digest: /^sha256:[0-9a-f]{64}$/i.test(a.digest || '') ? a.digest.slice(7).toLowerCase() : null,
      })),
  };
}

// ---------------------------------------------------------------- files

const safeName = (name) => path.basename(String(name)).replace(/[^\w.-]+/g, '_');

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** True when `file` is already the complete, checksummed download of `asset`. */
async function verifyFile(file, asset) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || (asset.size && st.size !== asset.size)) return false;
    return asset.digest ? (await sha256(file)) === asset.digest : true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

function runDetached(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- macOS bundle swap

async function bundleInfo(app) {
  const xml = await run('plutil', ['-convert', 'xml1', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  const get = (key) => {
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  };
  return { id: get('CFBundleIdentifier'), version: get('CFBundleShortVersionString') };
}

/** Why GitDonkey can't replace its own bundle, or null when it can. */
async function replaceProblem(bundle) {
  if (!bundle || !bundle.endsWith('.app')) return 'GitDonkey isn’t running from an app bundle.';
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running GitDonkey from a temporary copy, so it can’t update itself there. Move it to Applications first.';
  try {
    await fsp.access(path.dirname(bundle), fs.constants.W_OK);
    await fsp.access(bundle, fs.constants.W_OK);
  } catch {
    return `GitDonkey can’t write to ${path.dirname(bundle)}.`;
  }
  return null;
}

/** Rename the new bundle into place, putting the old one back if that fails. */
async function swapBundle(bundle, staged, old) {
  await fsp.rename(bundle, old);
  try {
    await fsp.rename(staged, bundle);
  } catch (e) {
    await fsp.rename(old, bundle);
    throw e;
  }
}

/**
 * Mount the DMG, check it holds this app at `version`, and swap it in for
 * `bundle`. `verified`: the DMG already matched the release's SHA-256, so
 * hdiutil needn't checksum it again.
 */
async function replaceBundle({ dmg, bundle, version, verified = false }) {
  const parent = path.dirname(bundle);
  const name = path.basename(bundle, '.app');
  // Staged beside the old bundle, on the same volume, so the swap is a rename.
  const staged = path.join(parent, `.${name}-${version}-${process.pid}.app`);
  const old = path.join(parent, `.${name}-old-${process.pid}.app`);
  const mount = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdonkey-dmg-'));
  await run('hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-readonly', ...(verified ? ['-noverify'] : []), '-mountpoint', mount]);
  try {
    const app = (await fsp.readdir(mount)).find((n) => n.endsWith('.app'));
    if (!app) throw new UpdateError('The disk image has no app in it.', 'UPDATE_BAD_DMG');
    const [next, cur] = await Promise.all([bundleInfo(path.join(mount, app)), bundleInfo(bundle)]);
    if (next.id !== cur.id) throw new UpdateError(`The disk image holds ${next.id || 'another app'}, not ${cur.id}.`, 'UPDATE_BAD_DMG');
    if (version && next.version !== version) throw new UpdateError(`The disk image holds version ${next.version}, not ${version}.`, 'UPDATE_BAD_DMG');
    await fsp.rm(staged, { recursive: true, force: true });
    await run('ditto', [path.join(mount, app), staged]);
  } finally {
    await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
    await fsp.rmdir(mount).catch(() => {});
  }
  try {
    await swapBundle(bundle, staged, old);
  } catch (e) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

/** Reopen `bundle` once this process has exited (giving up the wait after a minute). */
function relaunchAfterExit(target, pid = process.pid, { open = true } = {}) {
  const script = `i=0; while kill -0 "$0" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exec ${open ? 'open ' : ''}"$1"`;
  spawn('/bin/sh', ['-c', script, String(pid), target], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- Linux AppImage swap

/** Put the new AppImage where the running one is. The running one keeps working until it quits. */
async function replaceAppImage(file, target) {
  const dir = path.dirname(target);
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch {
    throw new UpdateError(`GitDonkey can’t write to ${dir}.`, 'UPDATE_INSTALL');
  }
  const next = `${target}.updating`;
  await fs.promises.copyFile(file, next);
  await fs.promises.chmod(next, 0o755);
  await fs.promises.rename(next, target);
}

// ---------------------------------------------------------------- the updater

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {(url: string, init?: object) => Promise<Response>} o.fetch e.g. Electron's net.fetch
   * @param {{ get: Function, set: Function }} o.store GitDonkey's state store
   * @param {string} o.dir where installers are downloaded
   * @param {string} o.version the running version
   * @param {string|null} [o.bundle] macOS: the .app to replace, when it's one GitDonkey may replace
   * @param {boolean} [o.packaged] an installed build, not `electron .`
   * @param {(file: string) => Promise<string>} o.openPath shell.openPath
   * @param {() => void} o.quit
   */
  constructor({ fetch, store, dir, version, platform = process.platform, arch = process.arch, feedUrl = FEED_URL, offline = false, bundle = null, appImage = null, deb = false, packaged = false, firstCheck = FIRST_CHECK, openPath, quit }) {
    super();
    this.fetchImpl = fetch;
    this.store = store;
    this.dir = dir;
    this.version = version;
    this.platform = platform;
    this.arch = arch;
    this.feedUrl = feedUrl;
    this.offline = offline;
    this.bundle = bundle;
    this.appImage = appImage;
    this.deb = deb;
    this.packaged = packaged;
    this.firstCheck = firstCheck;
    this.openPath = openPath;
    this.quit = quit;
    this.status = 'idle';
    this.release = null;
    this.asset = null;
    this.file = null;
    this.progress = null;
    this.error = null;
    this.checking = null;
    this.abort = null;
    this.timers = [];
  }

  saved() {
    return this.store.get('updates') || {};
  }

  save(patch) {
    this.store.set('updates', { ...this.saved(), ...patch });
  }

  enabled() {
    return (this.store.get('settings') || {}).checkUpdates !== false;
  }

  /** How "Update" works here: replace the bundle, run the installer, open the installer, or open the release page. */
  installKind() {
    if (!this.asset) return 'page';
    if (this.platform === 'darwin') return this.bundle ? 'replace' : 'open';
    if (this.platform === 'win32') return this.packaged ? 'installer' : 'open';
    if (this.platform === 'linux') return this.appImage ? 'appimage' : 'open';
    return 'open';
  }

  state() {
    const r = this.release;
    const saved = this.saved();
    return {
      status: this.status,
      version: this.version,
      release: r && { version: r.version, name: r.name, url: r.url, publishedAt: r.publishedAt, notes: r.notes },
      asset: this.asset && { name: this.asset.name, size: this.asset.size },
      install: this.installKind(),
      progress: this.progress,
      error: this.error,
      skipped: saved.skipped || null,
      enabled: this.enabled(),
      checkedAt: saved.checkedAt || null,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  start() {
    this.cleanup();
    const auto = () => this.check().catch(() => {});
    this.timers.push(setTimeout(auto, this.firstCheck), setInterval(auto, CHECK_EVERY));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.cancel();
  }

  /** Remove old downloads and anything a swap that was cut short left behind. */
  async cleanup() {
    const keep = this.downloadPath(assetFor((this.saved().release || {}).assets, this.platform, this.arch, { deb: this.deb }));
    for (const f of await fsp.readdir(this.dir).catch(() => [])) {
      const p = path.join(this.dir, f);
      if (p !== keep) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
    if (!this.bundle) return;
    const name = path.basename(this.bundle, '.app');
    const parent = path.dirname(this.bundle);
    for (const f of await fsp.readdir(parent).catch(() => [])) {
      if (f.startsWith(`.${name}-`) && f.endsWith('.app')) await fsp.rm(path.join(parent, f), { recursive: true, force: true }).catch(() => {});
    }
  }

  downloadPath(asset) {
    return asset ? path.join(this.dir, safeName(asset.name)) : null;
  }

  /** Look for a newer release. Automatic checks fail silently; a manual one throws so it can say why. */
  check({ manual = false } = {}) {
    if (!manual && (this.offline || !this.enabled())) return Promise.resolve(this.state());
    if (!this.checking) {
      this.checking = this.fetchRelease()
        .then((release) => {
          if (!BUSY.has(this.status)) {
            const newer = Boolean(release) && compareVersions(release.version, this.version) > 0;
            this.release = newer ? release : null;
            this.asset = newer ? assetFor(release.assets, this.platform, this.arch, { deb: this.deb }) : null;
            this.status = newer ? 'available' : 'current';
            this.error = null;
          }
          this.emitState();
          return this.state();
        })
        .finally(() => {
          this.checking = null;
        });
    }
    return this.checking.catch((e) => {
      if (manual) throw e;
      return this.state();
    });
  }

  async fetchRelease() {
    const saved = this.saved();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `GitDonkey/${this.version}` };
    // A conditional request: a 304 doesn't count against GitHub's hourly limit.
    if (saved.etag && saved.release) headers['If-None-Match'] = saved.etag;
    let res;
    try {
      res = await this.fetchImpl(this.feedUrl, { headers, cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT) });
    } catch {
      throw new UpdateError('Couldn’t reach GitHub. Check your connection and try again.', 'UPDATE_OFFLINE');
    }
    if (res.status === 304 && saved.release) {
      this.save({ checkedAt: Date.now() });
      return saved.release;
    }
    if (res.status === 404) {
      this.save({ etag: null, release: null, checkedAt: Date.now() });
      return null;
    }
    if (res.status === 403 || res.status === 429) throw new UpdateError('GitHub is limiting requests right now. Try again in a while.', 'UPDATE_RATE_LIMITED');
    if (!res.ok) throw new UpdateError(`GitHub answered ${res.status}. Try again later.`, 'UPDATE_HTTP');
    let release;
    try {
      release = parseRelease(await res.json());
    } catch {
      throw new UpdateError('GitHub sent a release GitDonkey couldn’t read.', 'UPDATE_HTTP');
    }
    this.save({ etag: (res.headers && res.headers.get('etag')) || null, release, checkedAt: Date.now() });
    return release;
  }

  skip(version) {
    this.save({ skipped: version || null });
    this.emitState();
  }

  /** Download the installer for this computer, reporting progress. Resolves when it's done, failed or cancelled. */
  async download() {
    if (BUSY.has(this.status)) return this.state();
    const asset = this.asset;
    if (!asset) {
      this.error = 'There’s no download for this computer. Get it from the release page.';
      this.emitState();
      return this.state();
    }
    this.save({ skipped: null });
    const file = this.downloadPath(asset);
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.status = 'downloading';
    this.error = null;
    this.progress = { received: 0, total: asset.size };
    this.emitState();
    try {
      if (!(await verifyFile(file, asset))) await this.fetchTo(asset, file, ctrl.signal);
      if (ctrl.signal.aborted) throw new UpdateError('Cancelled', 'UPDATE_CANCELLED');
      this.file = file;
      this.status = 'ready';
    } catch (e) {
      this.status = 'available';
      this.error = ctrl.signal.aborted ? null : e.message;
    } finally {
      this.abort = null;
      this.progress = null;
      this.emitState();
    }
    return this.state();
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  async fetchTo(asset, file, signal) {
    await fsp.mkdir(this.dir, { recursive: true });
    const part = `${file}.part`;
    const stall = new AbortController();
    let stallTimer = null;
    const touch = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), STALL_TIMEOUT);
    };
    const hash = crypto.createHash('sha256');
    let out = null;
    let received = 0;
    let reported = 0;
    try {
      touch();
      const res = await this.fetchImpl(asset.url, { cache: 'no-store', signal: AbortSignal.any([signal, stall.signal]) });
      if (!res.ok || !res.body) throw new UpdateError(`The download failed (HTTP ${res.status}). Try again.`, 'UPDATE_DOWNLOAD');
      const total = asset.size || Number(res.headers && res.headers.get('content-length')) || 0;
      out = fs.createWriteStream(part);
      for await (const chunk of res.body) {
        if (signal.aborted || stall.signal.aborted) break;
        touch();
        const buf = Buffer.from(chunk);
        hash.update(buf);
        received += buf.length;
        if (!out.write(buf)) await once(out, 'drain');
        if (Date.now() - reported > 100) {
          reported = Date.now();
          this.progress = { received, total };
          this.emitState();
        }
      }
      if (stall.signal.aborted) throw new UpdateError('The download stalled. Try again.', 'UPDATE_DOWNLOAD');
      if (signal.aborted) throw new UpdateError('Cancelled', 'UPDATE_CANCELLED');
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (asset.size && received !== asset.size) throw new UpdateError('The download was cut short. Try again.', 'UPDATE_DOWNLOAD');
      if (asset.digest && hash.digest('hex') !== asset.digest) throw new UpdateError('The download didn’t match the release’s checksum, so GitDonkey threw it away.', 'UPDATE_CHECKSUM');
      await fsp.rename(part, file);
    } catch (e) {
      if (out) out.destroy();
      await fsp.rm(part, { force: true }).catch(() => {});
      if (e instanceof UpdateError) throw e;
      throw new UpdateError(stall.signal.aborted ? 'The download stalled. Try again.' : signal.aborted ? 'Cancelled' : `The download failed: ${e.message}`, 'UPDATE_DOWNLOAD');
    } finally {
      clearTimeout(stallTimer);
    }
  }

  /**
   * Install the downloaded update. Resolves `{ done: 'restarting' }` when
   * GitDonkey is about to quit into the new version, or `{ done: 'opened', reason }`
   * when it opened the installer for the user to finish instead.
   */
  async install() {
    if (this.status !== 'ready' || !this.file) throw new UpdateError('Download the update first.', 'UPDATE_NOT_READY');
    this.status = 'installing';
    this.error = null;
    this.emitState();
    const kind = this.installKind();
    let reason = null;
    try {
      if (kind === 'replace') {
        reason = await replaceProblem(this.bundle);
        if (!reason) {
          await replaceBundle({ dmg: this.file, bundle: this.bundle, version: this.release.version, verified: Boolean(this.asset.digest) });
          relaunchAfterExit(this.bundle);
          this.quit();
          return { done: 'restarting' };
        }
      } else if (kind === 'appimage') {
        await replaceAppImage(this.file, this.appImage);
        relaunchAfterExit(this.appImage, process.pid, { open: false });
        this.quit();
        return { done: 'restarting' };
      } else if (kind === 'installer') {
        await runDetached(this.file, ['/S', '--updated', '--force-run']);
        this.quit();
        return { done: 'restarting' };
      }
    } catch (e) {
      reason = e.message;
    }
    // Couldn't do it in place: hand the user the installer.
    this.status = 'ready';
    const err = await this.openPath(this.file);
    if (err) {
      this.error = reason ? `${reason} ${err}` : err;
      this.emitState();
      throw new UpdateError(this.error, 'UPDATE_INSTALL');
    }
    this.emitState();
    return { done: 'opened', reason };
  }
}

module.exports = {
  Updater,
  UpdateError,
  FEED_URL,
  parseVersion,
  compareVersions,
  assetFor,
  parseRelease,
  releaseNotes,
  verifyFile,
  replaceProblem,
  swapBundle,
  replaceBundle,
  bundleInfo,
  replaceAppImage,
};
