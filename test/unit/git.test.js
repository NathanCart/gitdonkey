'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, git, write, read, commitFile, newRepo } = require('./helpers');
const { GitRepo, resolveRoot, initRepo, cloneRepo, GitError } = require('../../src/main/git');

const lib = (name) => import(path.join(__dirname, '../../src/renderer/lib', name));

test('resolveRoot finds the top level and rejects non-repos', async () => {
  const dir = newRepo();
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  assert.equal(await resolveRoot(path.join(dir, 'a/b')), dir);
  assert.equal(await resolveRoot(tmpDir('plain')), null);
  assert.equal(await resolveRoot('/definitely/not/here'), null);
});

test('empty repository: status, refs, log, stashes', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const st = await repo.status();
  assert.equal(st.branch.unborn, true);
  assert.equal(st.branch.head, 'main');
  const refs = await repo.refs();
  assert.equal(refs.head.branch, 'main');
  assert.equal(refs.head.unborn, true);
  assert.deepEqual(await repo.log(), []);
  assert.deepEqual(await repo.stashes(), []);
  assert.equal(await repo.lastCommitMessage(), '');
});

test('stage / unstage / commit on an unborn branch', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  write(dir, 'a.txt', 'a\n');
  write(dir, 'dir with space/b *.txt', 'b\n');
  let st = await repo.status();
  assert.deepEqual(st.unstaged.map((f) => [f.path, f.status, Boolean(f.untracked)]), [
    ['a.txt', '?', true],
    ['dir with space/b *.txt', '?', true],
  ]);
  await repo.stage(['dir with space/b *.txt']);
  st = await repo.status();
  assert.deepEqual(st.staged.map((f) => f.path), ['dir with space/b *.txt']);
  await repo.unstage(['dir with space/b *.txt']);
  st = await repo.status();
  assert.equal(st.staged.length, 0);
  await repo.stageAll();
  st = await repo.status();
  assert.equal(st.staged.length, 2);
  await repo.unstageAll();
  assert.equal((await repo.status()).staged.length, 0);
  await repo.stageAll();
  const hash = await repo.commit({ message: 'first\n\nbody text' });
  assert.match(hash, /^[0-9a-f]{40}$/);
  const log = await repo.log();
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, 'first');
  const details = await repo.commitDetails(hash);
  assert.equal(details.subject, 'first');
  assert.equal(details.body, 'body text');
  assert.equal(details.files.length, 2);
  assert.ok(details.files.every((f) => f.status === 'A'));
});

test('status reports renames, deletions, modifications, conflicts', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'keep.txt', 'one\ntwo\nthree\nfour\nfive\n', 'init');
  commitFile(dir, 'gone.txt', 'bye\n', 'gone');
  git(dir, 'mv', 'keep.txt', 'moved.txt');
  fs.unlinkSync(path.join(dir, 'gone.txt'));
  write(dir, 'moved.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  const st = await repo.status();
  assert.deepEqual(st.staged, [{ path: 'moved.txt', oldPath: 'keep.txt', status: 'R' }]);
  assert.deepEqual(
    st.unstaged.map((f) => [f.path, f.status]),
    [['gone.txt', 'D'], ['moved.txt', 'M']],
  );
  // Unstaging a rename needs both sides.
  await repo.unstage(['moved.txt', 'keep.txt']);
  const st2 = await repo.status();
  assert.equal(st2.staged.length, 0);
});

test('discard: unstaged changes, untracked files, full discard, discard all', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'original\n', 'init');
  write(dir, 'a.txt', 'changed\n');
  write(dir, 'new.txt', 'new\n');
  await repo.discard([{ path: 'a.txt' }, { path: 'new.txt', untracked: true }]);
  assert.equal(read(dir, 'a.txt'), 'original\n');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);

  write(dir, 'a.txt', 'staged change\n');
  git(dir, 'add', 'a.txt');
  write(dir, 'b.txt', 'added\n');
  git(dir, 'add', 'b.txt');
  await repo.discardFull([{ path: 'a.txt', status: 'M' }, { path: 'b.txt', status: 'A' }]);
  assert.equal(read(dir, 'a.txt'), 'original\n');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
  const st = await repo.status();
  assert.equal(st.staged.length + st.unstaged.length, 0);

  write(dir, 'a.txt', 'x\n');
  write(dir, 'sub/u.txt', 'u\n');
  await repo.discardAll();
  const st2 = await repo.status();
  assert.equal(st2.staged.length + st2.unstaged.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false);

  await assert.rejects(() => repo.discard([{ path: '../escape.txt', untracked: true }]), /outside the repository/);
  await assert.rejects(() => repo.discard([{ path: '.git/HEAD', untracked: true }]), /\.git directory/);
});

test('refs: local branches, tracking info, tags, remote branches', async () => {
  const remote = tmpDir('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const c1 = commitFile(dir, 'a.txt', '1\n', 'one');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  commitFile(dir, 'a.txt', '2\n', 'two');
  git(dir, 'branch', 'feature/x', c1);
  git(dir, 'tag', 'v1', c1);
  git(dir, 'tag', '-a', 'v2', '-m', 'release two');
  const refs = await repo.refs();
  const main = refs.local.find((b) => b.name === 'main');
  assert.equal(main.isHead, true);
  assert.equal(main.upstream, 'origin/main');
  assert.equal(main.upstreamRemote, 'origin');
  assert.equal(main.upstreamBranch, 'main');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
  assert.ok(refs.local.find((b) => b.name === 'feature/x' && b.hash === c1));
  assert.deepEqual(refs.remote.map((r) => [r.remote, r.name]), [['origin', 'main']]);
  const v1 = refs.tags.find((t) => t.name === 'v1');
  const v2 = refs.tags.find((t) => t.name === 'v2');
  assert.equal(v1.hash, c1);
  assert.equal(v1.annotated, false);
  assert.equal(v2.annotated, true);
  assert.equal(v2.hash, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(v2.message, 'release two');
  assert.deepEqual(refs.remotes, ['origin']);
  const remotes = await repo.remotes();
  assert.equal(remotes[0].fetchUrl, remote);
});

test('log is in date order with parents, and the graph layout is consistent', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', '1\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 'b.txt', '1\n', 'side work');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'a.txt', '2\n', 'main work');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const log = await repo.log();
  assert.equal(log.length, 4);
  assert.equal(log[0].subject, 'merge side');
  assert.equal(log[0].parents.length, 2);
  const { computeGraph } = await lib('graph-layout.js');
  const g = computeGraph(log);
  assert.equal(g.rows[0].col, 0);
  assert.equal(g.width, 2);
  const idx = new Map(log.map((c, i) => [c.hash, i]));
  // Every commit's node column must be where its children's lanes lead.
  for (let r = 1; r < log.length; r++) {
    for (const e of g.rows[r].edges) {
      assert.ok(e.to >= 0 && e.to < g.width);
      assert.ok(e.from >= 0 && e.from < g.width);
    }
  }
  const base = idx.get(log[3].hash);
  assert.equal(g.rows[base].col, 0);
  // Paging with skip gives the rest.
  const page = await repo.log({ skip: 2, max: 10 });
  assert.equal(page.length, 2);
  assert.equal(page[0].hash, log[2].hash);
});

test('hunk and line staging through parseDiff/buildPatch + applyPatch', async () => {
  const { parseDiff, buildPatch } = await lib('diff-parse.js');
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  commitFile(dir, 'f.txt', `${lines.join('\n')}\n`, 'init');
  const changed = [...lines];
  changed[1] = 'line 2 CHANGED';
  changed.splice(25, 0, 'inserted A', 'inserted B');
  write(dir, 'f.txt', `${changed.join('\n')}\n`);

  let diff = parseDiff((await repo.diff({ kind: 'unstaged', path: 'f.txt' })).text);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].hunks.length, 2);

  // Stage only the second hunk.
  await repo.applyPatch(buildPatch(diff[0], new Map([[1, 'all']])), { cached: true });
  let staged = parseDiff((await repo.diff({ kind: 'staged', path: 'f.txt' })).text);
  assert.equal(staged[0].hunks.length, 1);
  assert.deepEqual(staged[0].hunks[0].lines.filter((l) => l.type === '+').map((l) => l.text), ['inserted A', 'inserted B']);

  // Unstage just "inserted B" (line-level, reverse patch against the index).
  const h = staged[0].hunks[0];
  const bIndex = h.lines.findIndex((l) => l.text === 'inserted B');
  await repo.applyPatch(buildPatch(staged[0], new Map([[0, new Set([bIndex])]]), { reverse: true }), { cached: true, reverse: true });
  staged = parseDiff((await repo.diff({ kind: 'staged', path: 'f.txt' })).text);
  assert.deepEqual(staged[0].hunks[0].lines.filter((l) => l.type === '+').map((l) => l.text), ['inserted A']);

  // Stage only the "+" line of the first hunk (the "-" becomes context).
  diff = parseDiff((await repo.diff({ kind: 'unstaged', path: 'f.txt' })).text);
  const h0 = diff[0].hunks[0];
  const plus = h0.lines.findIndex((l) => l.type === '+');
  await repo.applyPatch(buildPatch(diff[0], new Map([[0, new Set([plus])]])), { cached: true });
  const index = git(dir, 'show', ':f.txt').split('\n');
  assert.equal(index[1], 'line 2');
  assert.equal(index[2], 'line 2 CHANGED');

  // Discard the remaining working tree change of "inserted B" (reverse, no --cached).
  diff = parseDiff((await repo.diff({ kind: 'unstaged', path: 'f.txt' })).text);
  const hb = diff[0].hunks.findIndex((hh) => hh.lines.some((l) => l.text === 'inserted B'));
  const li = diff[0].hunks[hb].lines.findIndex((l) => l.text === 'inserted B');
  await repo.applyPatch(buildPatch(diff[0], new Map([[hb, new Set([li])]]), { reverse: true }), { reverse: true });
  assert.ok(!read(dir, 'f.txt').includes('inserted B'));
  assert.ok(read(dir, 'f.txt').includes('inserted A'));
});

test('staging part of an untracked file', async () => {
  const { parseDiff, buildPatch } = await lib('diff-parse.js');
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'a\n', 'init');
  write(dir, 'new.txt', 'one\ntwo\nthree\n');
  const diff = parseDiff((await repo.diff({ kind: 'untracked', path: 'new.txt' })).text);
  assert.equal(diff[0].isNew, true);
  const two = diff[0].hunks[0].lines.findIndex((l) => l.text === 'two');
  await repo.applyPatch(buildPatch(diff[0], new Map([[0, new Set([two])]])), { cached: true });
  assert.equal(git(dir, 'show', ':new.txt'), 'two');
});

test('merge conflict: details, resolve by side, continue', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'c.txt', 'base\n', 'base');
  commitFile(dir, 'd.txt', 'base d\n', 'base d');
  git(dir, 'checkout', '-q', '-b', 'other');
  commitFile(dir, 'c.txt', 'theirs\n', 'theirs c');
  commitFile(dir, 'd.txt', 'theirs d\n', 'theirs d');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'c.txt', 'ours\n', 'ours c');
  commitFile(dir, 'd.txt', 'ours d\n', 'ours d');
  const r = await repo.merge('other');
  assert.equal(r.conflicts, true);
  assert.deepEqual(r.files.sort(), ['c.txt', 'd.txt']);
  const state = await repo.opState();
  assert.equal(state.type, 'merge');
  assert.match(state.message, /Merge branch 'other'/);
  const det = await repo.conflictDetails('c.txt');
  assert.equal(det.base, 'base\n');
  assert.equal(det.ours, 'ours\n');
  assert.equal(det.theirs, 'theirs\n');
  assert.match(det.working, /<<<<<<< HEAD/);

  const { parseConflicts, resolveConflicts } = await lib('conflicts.js');
  const segs = parseConflicts(det.working);
  assert.equal(segs.filter((s) => s.type === 'conflict').length, 1);
  await repo.writeFile('c.txt', resolveConflicts(segs, ['both']));
  await repo.markResolved(['c.txt']);
  assert.equal(read(dir, 'c.txt'), 'ours\ntheirs\n');
  await repo.resolveConflict('d.txt', 'theirs');
  assert.equal(read(dir, 'd.txt'), 'theirs d\n');
  const st = await repo.status();
  assert.equal(st.conflicted.length, 0);
  await repo.continueOperation('merge', { message: state.message });
  assert.equal(await repo.opState(), null);
  const head = (await repo.log())[0];
  assert.equal(head.parents.length, 2);
});

test('merge abort, ff-only, no-ff, squash', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'a\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'f');
  commitFile(dir, 'b.txt', 'b\n', 'feature');
  git(dir, 'checkout', '-q', 'main');
  const r = await repo.merge('f', { ffOnly: true });
  assert.equal(r.conflicts, false);
  assert.equal(git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'f'));
  git(dir, 'checkout', '-q', '-b', 'g');
  commitFile(dir, 'g.txt', 'g\n', 'g');
  git(dir, 'checkout', '-q', 'main');
  await repo.merge('g', { noFF: true });
  assert.equal((await repo.log())[0].parents.length, 2);

  commitFile(dir, 'x.txt', 'main\n', 'x main');
  git(dir, 'checkout', '-q', '-b', 'h', 'HEAD~1');
  commitFile(dir, 'x.txt', 'h\n', 'x h');
  git(dir, 'checkout', '-q', 'main');
  const c = await repo.merge('h');
  assert.equal(c.conflicts, true);
  await repo.abortOperation('merge');
  assert.equal(await repo.opState(), null);
  assert.equal(read(dir, 'x.txt'), 'main\n');
});

test('rebase with conflict, skip/abort; clean rebase', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'base\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  commitFile(dir, 'a.txt', 'topic\n', 'topic change');
  commitFile(dir, 't.txt', 't\n', 'topic file');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'a.txt', 'main\n', 'main change');
  git(dir, 'checkout', '-q', 'topic');
  const r = await repo.rebase('main');
  assert.equal(r.conflicts, true);
  const st = await repo.opState();
  assert.equal(st.type, 'rebase');
  assert.equal(st.branch, 'topic');
  assert.equal(st.step, 1);
  assert.equal(st.total, 2);
  await repo.abortOperation('rebase');
  assert.equal(await repo.opState(), null);

  const r2 = await repo.rebase('main');
  assert.equal(r2.conflicts, true);
  await repo.resolveConflict('a.txt', 'theirs');
  const r3 = await repo.continueOperation('rebase');
  assert.equal(r3.conflicts, false);
  assert.equal(await repo.opState(), null);
  assert.equal(git(dir, 'rev-parse', 'topic~2'), git(dir, 'rev-parse', 'main'));
});

test('interactive rebase: reword, squash, drop', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const base = commitFile(dir, 'a.txt', '0\n', 'base');
  const c1 = commitFile(dir, 'a.txt', '1\n', 'one');
  const c2 = commitFile(dir, 'b.txt', '2\n', 'two');
  const c3 = commitFile(dir, 'c.txt', '3\n', 'three');
  const c4 = commitFile(dir, 'd.txt', '4\n', 'four');
  const r = await repo.rebaseInteractive(base, [
    { action: 'reword', hash: c1, message: 'one (reworded)' },
    { action: 'fixup', hash: c2 },
    { action: 'drop', hash: c3 },
    { action: 'pick', hash: c4 },
  ]);
  assert.equal(r.conflicts, false);
  const subjects = (await repo.log()).map((c) => c.subject);
  assert.deepEqual(subjects, ['four', 'one (reworded)', 'base']);
  assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false);
  assert.equal(read(dir, 'b.txt'), '2\n');
});

test('cherry-pick, revert, reset modes, amend', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'a\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  const pickme = commitFile(dir, 'p.txt', 'p\n', 'pick me');
  git(dir, 'checkout', '-q', 'main');
  await repo.cherryPick(pickme);
  assert.equal((await repo.log())[0].subject, 'pick me');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  const head = git(dir, 'rev-parse', 'HEAD');
  await repo.revert(head);
  assert.equal(fs.existsSync(path.join(dir, 'p.txt')), false);
  await repo.reset('HEAD~1', 'soft');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal((await repo.status()).staged[0].path, 'p.txt');
  await repo.reset('HEAD', 'hard');
  assert.equal((await repo.status()).staged.length, 0);
  await repo.commit({ message: 'pick me (amended)', amend: true });
  assert.equal(await repo.lastCommitMessage(), 'pick me (amended)');
  await assert.rejects(() => repo.reset('HEAD', 'bogus'), GitError);
});

test('branches: create, checkout, rename, delete, upstream, fast-forward, detached', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const c1 = commitFile(dir, 'a.txt', '1\n', 'one');
  await repo.createBranch('feat', 'HEAD', { checkout: true });
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat');
  const c2 = commitFile(dir, 'a.txt', '2\n', 'two');
  await repo.checkout('main');
  // main is checked out: fast-forward must move the worktree too.
  await repo.fastForwardBranch('main', 'feat');
  assert.equal(git(dir, 'rev-parse', 'main'), c2);
  assert.equal(read(dir, 'a.txt'), '2\n');
  assert.equal((await repo.status()).staged.length, 0);
  await repo.checkout('feat');
  commitFile(dir, 'f.txt', 'only on feat\n', 'feat only');
  await repo.checkout('main');
  // Fast-forwarding an unchecked-out branch:
  await repo.createBranch('old', c1);
  await repo.fastForwardBranch('old', 'feat');
  const featTip = git(dir, 'rev-parse', 'feat');
  assert.equal(git(dir, 'rev-parse', 'old'), featTip);
  await repo.renameBranch('old', 'renamed');
  assert.equal(git(dir, 'rev-parse', 'renamed'), featTip);
  await assert.rejects(() => repo.fastForwardBranch('renamed', c1), (e) => e.kind === 'NOT_FF');
  await assert.rejects(() => repo.createBranch('bad..name'), /not a valid branch name/);
  await assert.rejects(() => repo.createBranch('-x'), /Invalid/);
  await repo.checkout('main');
  await assert.rejects(() => repo.deleteBranch('feat'), (e) => e.kind === 'NOT_MERGED');
  await repo.deleteBranch('feat', { force: true });
  await repo.checkoutDetached(c1);
  const refs = await repo.refs();
  assert.equal(refs.head.detached, true);
  assert.equal(refs.head.hash, c1);
  write(dir, 'a.txt', 'dirty\n');
  await repo.checkout('main').catch((e) => assert.equal(e.kind, 'DIRTY_WORKTREE'));
});

test('stash: save with untracked, list, details, apply, pop, drop', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'a\n', 'base');
  write(dir, 'a.txt', 'changed\n');
  write(dir, 'u.txt', 'untracked\n');
  await repo.stashSave({ message: 'my stash' });
  assert.equal((await repo.status()).unstaged.length, 0);
  let list = await repo.stashes();
  assert.equal(list.length, 1);
  assert.equal(list[0].ref, 'stash@{0}');
  assert.equal(list[0].summary, 'my stash');
  assert.equal(list[0].branch, 'main');
  const det = await repo.commitDetails(list[0].hash, { stash: true });
  assert.deepEqual(det.files.map((f) => f.path).sort(), ['a.txt', 'u.txt']);
  await repo.stashApply('stash@{0}');
  assert.equal(read(dir, 'u.txt'), 'untracked\n');
  assert.equal((await repo.stashes()).length, 1);
  await repo.discardAll();
  await repo.stashApply('stash@{0}', { pop: true });
  assert.equal(read(dir, 'a.txt'), 'changed\n');
  assert.equal((await repo.stashes()).length, 0);
  await repo.stashSave({});
  await repo.stashDrop('stash@{0}');
  assert.equal((await repo.stashes()).length, 0);
  await assert.rejects(() => repo.stashSave({}), /No local changes/);
  await assert.rejects(() => repo.stashDrop('stash@{0}; rm -rf /'), /Invalid stash/);
});

test('remotes: push -u, fetch, pull (ff / merge / rebase), rejected push, delete remote branch, tags', async () => {
  const bare = tmpDir('bare');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const a = newRepo();
  const ra = new GitRepo(a);
  commitFile(a, 'a.txt', '1\n', 'one');
  await ra.addRemote('origin', bare);
  const progress = [];
  await ra.push({ remote: 'origin', branch: 'main', setUpstream: true, onProgress: (p) => progress.push(p) });
  let refs = await ra.refs();
  assert.equal(refs.local[0].upstream, 'origin/main');

  const bdir = path.join(tmpDir('clone'), 'b');
  const cloneProgress = [];
  const root = await cloneRepo(bare, bdir, { onProgress: (p) => cloneProgress.push(p) });
  assert.equal(root, fs.realpathSync(bdir));
  const rb = new GitRepo(root);
  commitFile(root, 'b.txt', 'b\n', 'from b');
  await rb.push({ remote: 'origin', branch: 'main' });

  await ra.fetch({});
  refs = await ra.refs();
  assert.equal(refs.local[0].behind, 1);
  const pr = await ra.pull({ mode: 'ff-only' });
  assert.equal(pr.conflicts, false);
  assert.equal(read(a, 'b.txt'), 'b\n');

  // Diverge, then a plain push is rejected.
  commitFile(root, 'b.txt', 'b2\n', 'b again');
  await rb.push({ remote: 'origin', branch: 'main' });
  commitFile(a, 'a.txt', '2\n', 'a again');
  await assert.rejects(() => ra.push({ remote: 'origin', branch: 'main' }), (e) => e.kind === 'PUSH_REJECTED');
  await assert.rejects(() => ra.pull({ mode: 'ff-only' }), (e) => e.kind === 'NOT_FF' || /fast-forward/i.test(e.message));
  const merged = await ra.pull({ mode: 'merge' });
  assert.equal(merged.conflicts, false);
  assert.equal((await ra.log())[0].parents.length, 2);
  await ra.push({ remote: 'origin', branch: 'main' });

  commitFile(root, 'c.txt', 'c\n', 'c from b');
  await rb.pull({ mode: 'rebase' });
  await rb.push({ remote: 'origin', branch: 'main' });
  assert.equal(git(root, 'rev-parse', 'HEAD'), git(bare, 'rev-parse', 'main'));

  // Force push with lease after rewriting.
  await rb.commit({ message: 'c from b (amended)', amend: true });
  await assert.rejects(() => rb.push({ remote: 'origin', branch: 'main' }), (e) => e.kind === 'PUSH_REJECTED');
  await rb.push({ remote: 'origin', branch: 'main', force: true });

  // Remote branches and tags.
  await rb.createBranch('topic', 'HEAD');
  await rb.push({ remote: 'origin', branch: 'topic', setUpstream: true });
  assert.ok(git(bare, 'branch', '--list', 'topic'));
  await rb.deleteRemoteBranch('origin', 'topic');
  assert.equal(git(bare, 'branch', '--list', 'topic'), '');
  await rb.createTag('v1.0', 'HEAD', 'Release 1.0');
  await rb.pushTag('origin', 'v1.0');
  assert.equal(git(bare, 'tag', '--list'), 'v1.0');
  await rb.deleteRemoteTag('origin', 'v1.0');
  assert.equal(git(bare, 'tag', '--list'), '');
  await rb.deleteTag('v1.0');

  // checkoutRemote creates a tracking branch.
  await ra.fetch({ remote: 'origin' });
  git(root, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-only');
  await ra.fetch({ remote: 'origin' });
  await ra.checkoutRemote('origin/remote-only', 'remote-only');
  refs = await ra.refs();
  const ro = refs.local.find((b) => b.name === 'remote-only');
  assert.equal(ro.isHead, true);
  assert.equal(ro.upstream, 'origin/remote-only');

  await ra.renameRemote('origin', 'upstream');
  await ra.setRemoteUrl('upstream', bare);
  assert.deepEqual((await ra.refs()).remotes, ['upstream']);
  await ra.removeRemote('upstream');
  assert.deepEqual((await ra.remotes()), []);
});

test('pull with conflicts reports them', async () => {
  const bare = tmpDir('bare');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const a = newRepo();
  commitFile(a, 'x.txt', 'base\n', 'base');
  git(a, 'remote', 'add', 'origin', bare);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = path.join(tmpDir('c'), 'b');
  git(path.dirname(b), 'clone', '-q', bare, b);
  commitFile(b, 'x.txt', 'theirs\n', 'b');
  git(b, 'push', '-q');
  commitFile(a, 'x.txt', 'ours\n', 'a');
  const repo = new GitRepo(a);
  const r = await repo.pull({ mode: 'merge' });
  assert.equal(r.conflicts, true);
  assert.equal((await repo.opState()).type, 'merge');
});

test('init and clone helpers', async () => {
  const parent = tmpDir('init');
  const dir = path.join(parent, 'new project');
  const root = await initRepo(dir, { readme: true, name: 'new project', branch: 'trunk' });
  assert.equal(root, dir);
  assert.equal(read(dir, 'README.md'), '# new project\n');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'trunk');
  const dest = path.join(parent, 'copy');
  await cloneRepo(dir, dest);
  assert.equal(read(dest, 'README.md'), '# new project\n');
  await assert.rejects(() => cloneRepo(dir, dest), /not empty/);
  await assert.rejects(() => cloneRepo('/nope/nothing-here', path.join(parent, 'x')), GitError);
});

test('file history follows renames; blame; showFile; blob', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const c1 = commitFile(dir, 'old.txt', 'alpha\nbeta\n', 'create');
  git(dir, 'mv', 'old.txt', 'new.txt');
  git(dir, 'commit', '-q', '-m', 'rename');
  commitFile(dir, 'new.txt', 'alpha\nbeta\ngamma\n', 'extend');
  const hist = await repo.fileHistory('new.txt');
  assert.deepEqual(hist.map((h) => h.subject), ['extend', 'rename', 'create']);
  assert.equal(hist[1].status, 'R');
  assert.equal(hist[1].oldPath, 'old.txt');
  assert.equal(hist[2].path, 'old.txt');
  const blame = await repo.blame('new.txt');
  assert.equal(blame.lines.length, 3);
  assert.equal(blame.lines[0].hash, c1);
  assert.equal(blame.commits[c1].summary, 'create');
  assert.equal(blame.lines[2].text, 'gamma');
  const shown = await repo.showFile({ rev: c1, path: 'old.txt' });
  assert.equal(shown.text, 'alpha\nbeta\n');
  assert.equal(await repo.showFile({ rev: c1, path: 'missing.txt' }), null);
  const blob = await repo.blob({ rev: 'working', path: 'new.txt' });
  assert.equal(Buffer.from(blob.base64, 'base64').toString(), 'alpha\nbeta\ngamma\n');
  const details = await repo.commitDetails(git(dir, 'rev-parse', 'HEAD~1'));
  assert.equal(details.files[0].status, 'R');
  assert.equal(details.files[0].oldPath, 'old.txt');
  const d = await repo.diff({ kind: 'commit', path: 'new.txt', oldPath: 'old.txt', from: details.parents[0], to: details.hash });
  assert.match(d.text, /rename from old.txt/);
});

test('search, ignore, identity, ancestry', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  const c1 = commitFile(dir, 'a.txt', 'a\n', 'Fix the Login bug');
  const c2 = commitFile(dir, 'b.txt', 'b\n', 'unrelated');
  const found = await repo.searchCommits('login');
  assert.deepEqual(found.map((c) => c.hash), [c1]);
  const byAuthor = await repo.searchCommits('Test User');
  assert.equal(byAuthor.length, 2);
  await repo.ignore('*.log');
  await repo.ignore('/build');
  assert.equal(read(dir, '.gitignore'), '*.log\n/build\n');
  assert.equal(await repo.isAncestor(c1, c2), true);
  assert.equal(await repo.isAncestor(c2, c1), false);
  await repo.setIdentity({ name: 'Local Name', email: 'local@example.com', global: false });
  const id = await repo.identity();
  assert.equal(id.name, 'Local Name');
  assert.equal(id.email, 'local@example.com');
});

test('cherry-pick conflict and continue / revert of a merge commit', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  commitFile(dir, 'a.txt', 'base\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  const s = commitFile(dir, 'a.txt', 'side\n', 'side');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'a.txt', 'main\n', 'main');
  const r = await repo.cherryPick(s);
  assert.equal(r.conflicts, true);
  assert.equal((await repo.opState()).type, 'cherry-pick');
  await repo.resolveConflict('a.txt', 'theirs');
  await repo.continueOperation('cherry-pick');
  assert.equal(await repo.opState(), null);
  assert.equal((await repo.log())[0].subject, 'side');

  git(dir, 'checkout', '-q', '-b', 'm2');
  commitFile(dir, 'z.txt', 'z\n', 'z');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge m2', 'm2');
  await repo.revert(git(dir, 'rev-parse', 'HEAD'));
  assert.equal(fs.existsSync(path.join(dir, 'z.txt')), false);
});

test('stash with conflicted files says so instead of “could not write index”', async () => {
  const dir = newRepo();
  write(dir, 'f.txt', 'a\nb\nc\n');
  write(dir, 'g.txt', 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  write(dir, 'f.txt', 'a\nSTASH\nc\n');
  write(dir, 'g.txt', 'x\ny\n');
  git(dir, 'stash', '-q');
  write(dir, 'f.txt', 'a\nHEAD\nc\n');
  git(dir, 'commit', '-qam', 'head');
  try {
    git(dir, 'stash', 'pop');
  } catch {
    // A conflicting pop exits 1 and keeps the stash, like the one in the bug report.
  }
  const repo = new GitRepo(dir);
  await assert.rejects(() => repo.stashSave({ includeUntracked: true }), (e) => e.kind === 'UNMERGED' && /1 file is still conflicted \(f\.txt\)/.test(e.message) && e.files.join() === 'f.txt');
  assert.equal(git(dir, 'stash', 'list').trim().split('\n').length, 1, 'nothing stashed, the popped stash kept');
  // Git's own wording is classified the same way, for the other commands that hit it.
  const raw = new GitError('could not write index', { stderr: 'error: could not write index\nf.txt: needs merge' });
  assert.equal(raw.kind, 'UNMERGED');
});
