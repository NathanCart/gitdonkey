'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { git, commitFile, newRepo } = require('./helpers');
const { GitRepo } = require('../../src/main/git');

test('log filters: only some branches, hide some, no remote branches, no tags', async () => {
  const dir = newRepo();
  commitFile(dir, 'a.txt', '0\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature/a');
  commitFile(dir, 'a.txt', 'a\n', 'on a');
  git(dir, 'checkout', '-q', '-b', 'feature/b', 'main');
  commitFile(dir, 'b.txt', 'b\n', 'on b');
  git(dir, 'checkout', '-q', '--detach', 'main');
  commitFile(dir, 't.txt', 't\n', 'tagged only');
  git(dir, 'tag', 'v1');
  commitFile(dir, 'r.txt', 'r\n', 'remote only');
  git(dir, 'update-ref', 'refs/remotes/origin/r', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  const repo = new GitRepo(dir);
  const subjects = async (opts) => (await repo.log(opts)).map((c) => c.subject).sort();

  assert.deepEqual(await subjects({}), ['base', 'on a', 'on b', 'remote only', 'tagged only']);
  assert.deepEqual(await subjects({ only: ['refs/heads/feature/a'] }), ['base', 'on a']);
  assert.deepEqual(await subjects({ only: ['refs/heads/feature/a', 'refs/heads/gone'] }), ['base', 'on a'], 'a deleted branch is skipped');
  assert.deepEqual(await subjects({ hidden: ['refs/heads/feature/b'] }), ['base', 'on a', 'remote only', 'tagged only']);
  assert.deepEqual(await subjects({ remotes: false }), ['base', 'on a', 'on b', 'tagged only']);
  assert.deepEqual(await subjects({ remotes: false, tags: false }), ['base', 'on a', 'on b']);
  assert.deepEqual(await subjects({ hidden: ['refs/remotes/origin/r'], tags: false }), ['base', 'on a', 'on b']);
  await assert.rejects(repo.log({ only: ['--all'] }), /Invalid ref/);
  await assert.rejects(repo.log({ hidden: ['main'] }), /Invalid ref/);
});
