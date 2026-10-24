'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { AskpassServer, parsePrompt } = require('../../src/main/askpass');

test('parsePrompt recognises Git and SSH prompts', () => {
  assert.deepEqual(parsePrompt("Username for 'https://github.com': "), { kind: 'username', url: 'https://github.com', host: 'github.com' });
  assert.deepEqual(parsePrompt("Password for 'https://nathan@github.com': "), { kind: 'password', url: 'https://nathan@github.com', host: 'github.com', username: 'nathan' });
  assert.equal(parsePrompt("Enter passphrase for key '/Users/n/.ssh/id_ed25519': ").kind, 'passphrase');
  assert.equal(parsePrompt("Enter passphrase for key '/Users/n/.ssh/id_ed25519': ").key, '/Users/n/.ssh/id_ed25519');
  const c = parsePrompt("The authenticity of host 'github.com (140.82.121.4)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
  assert.equal(c.kind, 'confirm');
  assert.equal(c.host, 'github.com (140.82.121.4)');
});

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, opts, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

test('git credential fill is answered through the askpass bridge with one dialog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-askpass-'));
  const asked = [];
  const server = new AskpassServer(dir, async (req) => {
    asked.push(req.kind);
    return { username: 'donkey', password: 'hee-haw-token' };
  });
  const env = await server.start();
  try {
    const r = await run('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      input: 'protocol=https\nhost=example.com\n\n',
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^username=donkey$/m);
    assert.match(r.stdout, /^password=hee-haw-token$/m);
    // Username and password came from a single dialog.
    assert.deepEqual(asked, ['username']);
  } finally {
    server.stop();
  }
});

test('a cancelled dialog fails the git prompt; bad tokens are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-askpass-'));
  const server = new AskpassServer(dir, async () => null);
  const env = await server.start();
  try {
    const r = await run('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      input: 'protocol=https\nhost=example.com\n\n',
    });
    assert.notEqual(r.code, 0);
    // The HTTP endpoint refuses callers without the token.
    const res = await fetch(`http://127.0.0.1:${env.GITDONKEY_ASKPASS_PORT}/askpass`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(res.status, 403);
  } finally {
    server.stop();
  }
});
