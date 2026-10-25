'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, git, write, commitFile, newRepo } = require('./helpers');
const { GitRepo } = require('../../src/main/git');

test('worktrees: add on a new and an existing branch, list, refuse a busy branch, remove, prune', async () => {
  const dir = newRepo();
  commitFile(dir, 'a.txt', 'a\n', 'a');
  git(dir, 'branch', 'existing');
  const repo = new GitRepo(dir);
  const [only] = await repo.worktrees();
  assert.deepEqual([only.path, only.branch, only.main, only.current], [dir, 'main', true, true]);

  const parent = tmpDir('wt');
  const one = path.join(parent, 'repo-new-idea');
  assert.equal(await repo.addWorktree(one, { newBranch: 'new-idea', start: 'HEAD' }), one);
  const two = path.join(parent, 'repo-existing');
  await repo.addWorktree(two, { branch: 'existing' });
  const list = await repo.worktrees(); // the main one, then Git's order (by path)
  assert.deepEqual(list.map((w) => [w.path, w.branch, w.main, w.current]), [[dir, 'main', true, true], [two, 'existing', false, false], [one, 'new-idea', false, false]]);
  assert.equal(fs.readFileSync(path.join(one, 'a.txt'), 'utf8'), 'a\n');

  await assert.rejects(repo.checkout('existing'), (e) => e.kind === 'WORKTREE_BUSY' && e.message.includes(two));
  await assert.rejects(repo.addWorktree('relative/path', { branch: 'main' }), /absolute folder/);
  await assert.rejects(repo.addWorktree(dir, { branch: 'main' }), /isn’t empty/);
  await assert.rejects(repo.removeWorktree(dir), /main worktree/);
  await assert.rejects(repo.removeWorktree(path.join(parent, 'nope')), /isn’t one of/);

  write(two, 'dirty.txt', 'x\n');
  await assert.rejects(repo.removeWorktree(two), /modified or untracked|contains/);
  await repo.removeWorktree(two, { force: true });
  assert.equal(fs.existsSync(two), false);

  fs.rmSync(one, { recursive: true, force: true });
  assert.equal((await repo.worktrees()).find((w) => w.path === one).prunable !== false, true);
  await repo.pruneWorktrees();
  assert.deepEqual((await repo.worktrees()).map((w) => w.path), [dir]);

  const detached = path.join(parent, 'repo-detached');
  await repo.addWorktree(detached, { start: 'HEAD' });
  const d = (await repo.worktrees()).find((w) => w.path === detached);
  assert.equal(d.detached, true);
  assert.equal(d.branch, null);
  // Opened from the linked worktree, it knows it's the current one.
  const fromThere = (await new GitRepo(detached).worktrees()).find((w) => w.current);
  assert.equal(fromThere.path, detached);
});
