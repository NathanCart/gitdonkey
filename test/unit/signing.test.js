'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir, git, write, commitFile, newRepo, HOME } = require('./helpers');
const { GitRepo, signingKeys, classifyError } = require('../../src/main/git');

test('SSH signing: set up, trusted locally, and commits read as verified', async () => {
  const keys = tmpDir('keys');
  const key = path.join(keys, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test@example.com', '-f', key]);
  const dir = newRepo();
  commitFile(dir, 'a.txt', 'a\n', 'unsigned');
  const repo = new GitRepo(dir);
  assert.equal((await repo.signingConfig()).enabled, false);
  assert.equal((await repo.commitDetails(git(dir, 'rev-parse', 'HEAD'))).signature, null);

  await assert.rejects(repo.setSigning({ enabled: true, format: 'ssh', key: path.join(keys, 'nope.pub'), scope: 'local' }), /no key file/);
  const cfg = await repo.setSigning({ enabled: true, format: 'ssh', key: `${key}.pub`, scope: 'local' });
  assert.deepEqual([cfg.enabled, cfg.format, cfg.key, cfg.scope], [true, 'ssh', `${key}.pub`, 'local']);
  const allowed = fs.readFileSync(cfg.allowedSigners, 'utf8');
  assert.match(allowed, /^test@example\.com namespaces="git" ssh-ed25519 /m);
  // Doing it twice doesn't add the key twice.
  await repo.setSigning({ enabled: true, format: 'ssh', key: `${key}.pub`, scope: 'local' });
  assert.equal(fs.readFileSync(cfg.allowedSigners, 'utf8'), allowed);

  write(dir, 'b.txt', 'b\n');
  await repo.stage(['b.txt']);
  const hash = await repo.commit({ message: 'signed' });
  const sig = (await repo.commitDetails(hash)).signature;
  assert.deepEqual([sig.type, sig.status, sig.signer], ['ssh', 'verified', 'test@example.com']);

  // A good signature from a key that isn't on the list: signed, signer not confirmed.
  fs.writeFileSync(cfg.allowedSigners, '');
  assert.equal((await repo.signature(hash)).status, 'signed');
  // No list at all: Git can't check it here.
  git(dir, 'config', '--unset', 'gpg.ssh.allowedSignersFile');
  assert.equal((await repo.signature(hash)).status, 'unverified');

  await repo.setSigning({ enabled: false, scope: 'local' });
  assert.equal((await repo.signingConfig()).enabled, false);
  fs.rmSync(path.join(HOME, '.ssh'), { recursive: true, force: true });
});

test('signingKeys finds SSH public keys in ~/.ssh', async () => {
  const ssh = path.join(HOME, '.ssh');
  fs.mkdirSync(ssh, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'me@laptop', '-f', path.join(ssh, 'id_test')]);
  fs.writeFileSync(path.join(ssh, 'junk.pub'), 'not a key');
  const k = await signingKeys();
  assert.deepEqual(k.ssh.map((x) => [path.basename(x.path), x.type, x.comment]), [['id_test.pub', 'ssh-ed25519', 'me@laptop']]);
  fs.rmSync(ssh, { recursive: true, force: true });
});

test('signing failures are recognised', () => {
  assert.equal(classifyError('error: gpg failed to sign the data\nfatal: failed to write commit object'), 'SIGNING');
  assert.equal(classifyError("error: Couldn't load public key /x/id.pub: No such file or directory"), 'SIGNING');
  assert.equal(classifyError('Permission denied (publickey).'), 'AUTH');
});
