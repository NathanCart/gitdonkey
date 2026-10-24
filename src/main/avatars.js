'use strict';

// Author avatars: GitHub for GitHub noreply addresses, otherwise Gravatar.
// Fetched in the main process, cached in memory and on disk, and handed to the
// renderer as data URLs (no remote origins in the page's CSP).

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const HIT_TTL = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL = 24 * 60 * 60 * 1000;
const MAX_PARALLEL = 6;
const TIMEOUT_MS = 6000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email.trim());
}

/** Candidate image URLs for an email, most specific first. */
function avatarCandidates(email, size = 96) {
  const e = normalizeEmail(email);
  const urls = [];
  let m = e.match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/);
  if (m) urls.push(`https://avatars.githubusercontent.com/u/${m[1]}?s=${size}&v=4`);
  else if ((m = e.match(/^([a-z0-9-]+)@users\.noreply\.github\.com$/))) urls.push(`https://github.com/${m[1]}.png?size=${size}`);
  const md5 = crypto.createHash('md5').update(e).digest('hex');
  urls.push(`https://www.gravatar.com/avatar/${md5}?s=${size}&d=404`);
  return urls;
}

class AvatarService {
  /**
   * @param {string} dir cache directory
   * @param {(url: string, init: object) => Promise<Response>} fetchImpl e.g. Electron's net.fetch
   */
  constructor(dir, fetchImpl, { offline = false } = {}) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.offline = offline;
    this.memory = new Map();
    this.pending = new Map();
    this.queue = [];
    this.active = 0;
  }

  key(email) {
    return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 32);
  }

  async get(email) {
    if (!isEmail(email) || this.offline) return null;
    const k = this.key(email);
    if (this.memory.has(k)) return this.memory.get(k);
    if (this.pending.has(k)) return this.pending.get(k);
    const p = this.resolve(email, k).then((url) => {
      this.memory.set(k, url);
      this.pending.delete(k);
      return url;
    });
    this.pending.set(k, p);
    return p;
  }

  async resolve(email, k) {
    const cached = await this.readCache(k);
    if (cached !== undefined) return cached;
    const url = await this.schedule(() => this.download(email));
    await this.writeCache(k, url);
    return url;
  }

  async readCache(k) {
    try {
      const hit = path.join(this.dir, `${k}.txt`);
      const st = await fsp.stat(hit);
      if (Date.now() - st.mtimeMs < HIT_TTL) return await fsp.readFile(hit, 'utf8');
    } catch {}
    try {
      const st = await fsp.stat(path.join(this.dir, `${k}.none`));
      if (Date.now() - st.mtimeMs < MISS_TTL) return null;
    } catch {}
    return undefined;
  }

  async writeCache(k, url) {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      if (url) {
        await fsp.writeFile(path.join(this.dir, `${k}.txt`), url);
        await fsp.rm(path.join(this.dir, `${k}.none`), { force: true });
      } else await fsp.writeFile(path.join(this.dir, `${k}.none`), '');
    } catch {
      // Cache is best effort.
    }
  }

  schedule(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const { task, resolve } = this.queue.shift();
      this.active++;
      task()
        .catch(() => null)
        .then((v) => {
          this.active--;
          resolve(v);
          this.pump();
        });
    }
  }

  async download(email) {
    for (const url of avatarCandidates(email)) {
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok || !type.startsWith('image/')) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > 512 * 1024) continue;
        return `data:${type};base64,${buf.toString('base64')}`;
      } catch {
        // Offline, blocked or timed out: try the next source.
      }
    }
    return null;
  }

  async clear() {
    this.memory.clear();
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

module.exports = { AvatarService, avatarCandidates, isEmail };
