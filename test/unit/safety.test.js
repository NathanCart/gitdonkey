'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { git, write, read, commitFile, newRepo } = require('./helpers');
const { GitRepo } = require('../../src/main/git');

function repoWithWork() {
  const dir = newRepo();
  commitFile(dir, 'a.txt', 'a1\n', 'add a');
  commitFile(dir, 'b.txt', 'b1\n', 'add b');
  commitFile(dir, 'gone.txt', 'bye\n', 'add gone');
  write(dir, 'a.txt', 'a2 staged\n');
  git(dir, 'add', 'a.txt');
  write(dir, 'a.txt', 'a3 on disk\n');
  write(dir, 'b.txt', 'b2\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  write(dir, 'new/untracked.txt', 'fresh\n');
  return dir;
}

test('a snapshot before Discard all brings everything back: staged, unstaged, deleted, untracked', async () => {
  const dir = repoWithWork();
  const repo = new GitRepo(dir);
  const before = git(dir, 'status', '--porcelain');
  const snap = await repo.snapshot('Discard all changes', { kind: 'discard-all' });
  assert.match(snap.hash, /^[0-9a-f]{40}$/);
  assert.equal(snap.files, 4);
  assert.equal(git(dir, 'status', '--porcelain'), before, 'taking a snapshot changes nothing');
  await repo.discardAll();
  assert.equal(git(dir, 'status', '--porcelain'), '');
  const r = await repo.restoreSnapshot(snap.hash);
  assert.equal(r.conflicts, false);
  assert.equal(read(dir, 'a.txt'), 'a3 on disk\n');
  assert.equal(git(dir, 'show', ':a.txt'), 'a2 staged', 'the staged version is staged again');
  assert.equal(read(dir, 'b.txt'), 'b2\n');
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
  assert.equal(read(dir, 'new/untracked.txt'), 'fresh\n');
  assert.equal(git(dir, 'status', '--porcelain'), before);

  const list = await repo.snapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Discard all changes');
  assert.equal(list[0].kind, 'discard-all');
  assert.equal(list[0].branch, 'main');
  assert.equal(list[0].files, 4);
  await repo.deleteSnapshot(list[0].ref);
  assert.deepEqual(await repo.snapshots(), []);
  await assert.rejects(repo.deleteSnapshot('refs/heads/main'), /Invalid snapshot/);
});

test('a snapshot of some files restores only those, over other changes made since', async () => {
  const dir = repoWithWork();
  const repo = new GitRepo(dir);
  const snap = await repo.snapshot('Discard b.txt and the untracked file', { paths: ['b.txt', 'new/untracked.txt'] });
  assert.equal(snap.files, 2);
  await repo.discard([{ path: 'b.txt' }, { path: 'new/untracked.txt', untracked: true }]);
  assert.equal(read(dir, 'b.txt'), 'b1\n');
  write(dir, 'a.txt', 'a4 edited after\n');
  await repo.restoreSnapshot(snap.hash);
  assert.equal(read(dir, 'b.txt'), 'b2\n');
  assert.equal(read(dir, 'new/untracked.txt'), 'fresh\n');
  assert.equal(read(dir, 'a.txt'), 'a4 edited after\n', 'files outside the snapshot are left alone');
  assert.equal(git(dir, 'show', ':a.txt'), 'a2 staged');
  assert.equal(await repo.snapshot('nothing', { paths: ['not-changed.txt'] }), null);
});

test('a snapshot with conflicts in the tree, and on an unborn branch', async () => {
  const dir = newRepo();
  commitFile(dir, 'f.txt', 'base\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'other');
  commitFile(dir, 'f.txt', 'theirs\n', 'theirs');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'f.txt', 'ours\n', 'ours');
  try {
    git(dir, 'merge', 'other');
  } catch {}
  const repo = new GitRepo(dir);
  assert.equal((await repo.status()).conflicted.length, 1);
  const snap = await repo.snapshot('Hard reset');
  assert.ok(snap);
  git(dir, 'reset', '-q', '--hard');
  assert.equal(read(dir, 'f.txt'), 'ours\n');
  await repo.restoreSnapshot(snap.hash);
  assert.match(read(dir, 'f.txt'), /<<<<<<< HEAD/, 'the conflicted file comes back as it was on disk');

  const fresh = newRepo();
  write(fresh, 'x.txt', 'x\n');
  const r2 = new GitRepo(fresh);
  const s2 = await r2.snapshot('Discard all changes');
  await r2.discardAll();
  assert.equal(fs.existsSync(path.join(fresh, 'x.txt')), false);
  await r2.restoreSnapshot(s2.hash);
  assert.equal(read(fresh, 'x.txt'), 'x\n');
});

test('snapshots are kept from a dropped stash, and a stash can be put back', async () => {
  const dir = newRepo();
  commitFile(dir, 'a.txt', 'a\n', 'a');
  write(dir, 'a.txt', 'stashed\n');
  git(dir, 'stash', 'push', '-q', '-m', 'my experiment');
  const repo = new GitRepo(dir);
  const kept = await repo.keepStash('stash@{0}');
  await repo.stashDrop('stash@{0}');
  assert.deepEqual(await repo.stashes(), []);
  const [snap] = await repo.snapshots();
  assert.equal(snap.hash, kept.hash);
  assert.equal(snap.kind, 'stash');
  assert.equal(snap.label, 'Dropped stash: my experiment');
  assert.equal(snap.subject, 'On main: my experiment', 'the stash message as it was, to put it back with');
  await repo.stashStore(kept.hash, 'On main: my experiment');
  assert.equal((await repo.stashes())[0].hash, kept.hash);
  await repo.restoreSnapshot(snap.hash);
  assert.equal(read(dir, 'a.txt'), 'stashed\n');
});

test('lost commits: what a hard reset left behind, and dangling stashes from fsck', async () => {
  const dir = newRepo();
  commitFile(dir, 'a.txt', '1\n', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  commitFile(dir, 'a.txt', '2\n', 'two');
  commitFile(dir, 'a.txt', '3\n', 'three');
  const tip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'reset', '-q', '--hard', base);
  const repo = new GitRepo(dir);
  const lost = await repo.lostCommits();
  assert.equal(lost.length, 1, 'one tip for the two lost commits');
  assert.equal(lost[0].hash, tip);
  assert.equal(lost[0].subject, 'three');
  assert.equal(lost[0].commits, 2);
  assert.match(lost[0].lostBy, /^reset: moving to/);
  // A snapshot pointing at the old HEAD doesn't hide it.
  write(dir, 'a.txt', 'wip\n');
  await repo.snapshot('x');
  assert.equal((await repo.lostCommits()).length, 1);
  git(dir, 'checkout', '-q', 'a.txt');

  write(dir, 'a.txt', 'dropped work\n');
  git(dir, 'stash', 'push', '-q', '-m', 'forgotten');
  const stashHash = git(dir, 'rev-parse', 'stash@{0}');
  git(dir, 'stash', 'drop', '-q');
  const dangling = await repo.danglingCommits();
  const found = dangling.find((c) => c.hash === stashHash);
  assert.ok(found, 'fsck finds the dropped stash');
  assert.equal(found.stashLike, true);
  assert.match(found.subject, /forgotten/);
});
