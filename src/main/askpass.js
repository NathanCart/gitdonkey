'use strict';

// Credential prompts for Git and SSH, answered by GitDonkey's own dialog.
//
// Git (GIT_ASKPASS) and OpenSSH (SSH_ASKPASS) run a helper program whenever
// they need a username, password/token, key passphrase or host-key decision.
// Our helper is a tiny script that runs this app's binary in Node mode and
// forwards the prompt to a token-protected HTTP server on 127.0.0.1; the main
// process asks the renderer and sends the answer back. Successful logins are
// then saved by the user's Git credential helper (macOS Keychain, Windows
// Credential Manager), so each remote asks only once.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HELPER_JS = `'use strict';
const http = require('http');
const prompt = process.argv.slice(2).join(' ');
const body = JSON.stringify({ prompt });
const req = http.request({
  host: '127.0.0.1',
  port: Number(process.env.GITDONKEY_ASKPASS_PORT),
  path: '/askpass',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-gitdonkey-token': process.env.GITDONKEY_ASKPASS_TOKEN },
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (d) => { data += d; });
  res.on('end', () => {
    try {
      const { answer } = JSON.parse(data);
      if (res.statusCode !== 200 || typeof answer !== 'string') process.exit(1);
      process.stdout.write(answer + '\\n');
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
});
req.on('error', () => process.exit(1));
req.end(body);
`;

const HELPER_SH = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$GITDONKEY_ASKPASS_NODE" "$GITDONKEY_ASKPASS_MAIN" "$@"
`;

/** Classify a Git / SSH prompt into something a dialog can render. */
function parsePrompt(prompt) {
  const p = String(prompt || '').trim();
  let m = p.match(/^Username for '([^']+)'/i);
  if (m) return { kind: 'username', url: m[1], host: hostOf(m[1]) };
  m = p.match(/^Password for '([^']+)'/i);
  if (m) {
    const user = (m[1].match(/^[a-z]+:\/\/([^@/]+)@/i) || [])[1];
    return { kind: 'password', url: m[1], host: hostOf(m[1]), username: user ? decodeURIComponent(user) : null };
  }
  m = p.match(/passphrase for (?:key )?'?([^':]+)'?/i);
  if (m) return { kind: 'passphrase', key: m[1].trim(), host: null };
  if (/\(yes\/no(\/\[fingerprint\])?\)\?/i.test(p)) {
    const host = (p.match(/authenticity of host '([^']+)'/i) || [])[1] || null;
    return { kind: 'confirm', host, detail: p };
  }
  return { kind: 'secret', host: null, detail: p };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

class AskpassServer {
  /**
   * @param {string} dir where the helper scripts are written (outside app.asar)
   * @param {(req: object) => Promise<object|null>} ask shows the dialog; resolves to the answer or null if cancelled
   */
  constructor(dir, ask) {
    this.dir = dir;
    this.ask = ask;
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = null;
    this.pendingPasswords = new Map();
    this.queue = Promise.resolve();
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.mainJs = path.join(this.dir, 'askpass-main.js');
    this.script = path.join(this.dir, 'askpass.sh');
    fs.writeFileSync(this.mainJs, HELPER_JS);
    fs.writeFileSync(this.script, HELPER_SH, { mode: 0o755 });
    fs.chmodSync(this.script, 0o755);
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.env();
  }

  env() {
    return {
      GIT_ASKPASS: this.script,
      SSH_ASKPASS: this.script,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      GITDONKEY_ASKPASS_NODE: process.execPath,
      GITDONKEY_ASKPASS_MAIN: this.mainJs,
      GITDONKEY_ASKPASS_PORT: String(this.port),
      GITDONKEY_ASKPASS_TOKEN: this.token,
    };
  }

  handle(req, res) {
    const reply = (status, answer) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: answer ?? null }));
    };
    const token = req.headers['x-gitdonkey-token'];
    if (req.method !== 'POST' || req.url !== '/askpass' || typeof token !== 'string' || token.length !== this.token.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) {
      reply(403, null);
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
      if (body.length > 16384) req.destroy();
    });
    req.on('end', async () => {
      let prompt = '';
      try {
        prompt = JSON.parse(body).prompt;
      } catch {
        reply(400, null);
        return;
      }
      // One dialog at a time: Git asks for the username, then the password.
      const run = this.queue.then(() => this.answer(prompt));
      this.queue = run.catch(() => {});
      const answer = await run.catch(() => null);
      reply(answer == null ? 401 : 200, answer);
    });
  }

  async answer(prompt) {
    const info = parsePrompt(prompt);
    if (info.kind === 'password' && info.username) {
      const key = `${info.host}\n${info.username}`;
      const cached = this.pendingPasswords.get(key);
      if (cached) {
        this.pendingPasswords.delete(key);
        clearTimeout(cached.timer);
        return cached.password;
      }
    }
    const result = await this.ask({ ...info, prompt });
    if (!result) return null;
    if (info.kind === 'username') {
      if (typeof result.username !== 'string' || !result.username) return null;
      if (typeof result.password === 'string') {
        // Git asks for the password next; answer it without a second dialog.
        const key = `${info.host}\n${result.username}`;
        const timer = setTimeout(() => this.pendingPasswords.delete(key), 120000);
        this.pendingPasswords.set(key, { password: result.password, timer });
      }
      return result.username;
    }
    if (info.kind === 'confirm') return result.confirm ? 'yes' : 'no';
    return typeof result.value === 'string' ? result.value : typeof result.password === 'string' ? result.password : null;
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { AskpassServer, parsePrompt };
