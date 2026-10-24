import test from 'node:test';
import assert from 'node:assert/strict';
import { LINES, pickLine, fill, eventForGit, moodOf } from '../../src/renderer/lib/donkey-lines.js';

test('donkey: every line is short and every placeholder is one he’s given', () => {
  const known = new Set(['branch', 'remote', 'ref', 'name', 'count', 'version']);
  for (const [type, list] of Object.entries(LINES)) {
    assert.ok(list.length, type);
    for (const line of list) {
      assert.ok(line.length <= 90, `${type}: ${line}`);
      for (const [, v] of line.matchAll(/\{(\w+)\}/g)) assert.ok(known.has(v), `${type}: {${v}}`);
    }
  }
});

test('donkey: lines fill in, never repeat back to back, and fall back politely', () => {
  assert.equal(fill('Now on {branch}.', { branch: 'main' }), 'Now on main.');
  assert.equal(fill('Bye, {name}.', {}), 'Bye, it.');
  let last = null;
  for (let i = 0; i < 20; i++) {
    const line = pickLine('poke', {}, () => 0); // the same roll every time
    assert.notEqual(line, last);
    last = line;
  }
  assert.equal(pickLine('nope'), null);
  assert.match(pickLine('checkout', { branch: 'feature/hay' }, () => 0), /feature\/hay/);
});

test('donkey: Git calls he talks about, and the ones he doesn’t', () => {
  const ok = (method, ...args) => eventForGit({ method, args, ok: true });
  assert.equal(ok('commit', { message: 'x' }).type, 'commit');
  assert.equal(ok('commit', { message: 'x', amend: true }).type, 'amend');
  assert.equal(ok('push', { remote: 'origin', branch: 'main' }).type, 'push');
  assert.equal(ok('push', { remote: 'origin', force: true }).type, 'forcePush');
  assert.deepEqual(ok('merge', 'refs/heads/feature/hay').vars, { ref: 'feature/hay' });
  assert.deepEqual(ok('checkout', 'a'.repeat(40)).vars, { branch: 'aaaaaaa' });
  assert.equal(ok('createBranch', 'hay', 'HEAD').vars.name, 'hay');
  assert.equal(ok('deleteBranch', 'old', { force: true }).vars.name, 'old');
  assert.equal(ok('reset', 'HEAD~1', 'hard').type, 'resetHard');
  assert.equal(ok('reset', 'HEAD~1', 'mixed').type, 'reset');
  assert.equal(ok('stashSave', {}).type, 'stash');
  assert.equal(ok('createTag', 'v2.0.0').vars.name, 'v2.0.0');
  for (const quiet of ['status', 'log', 'diff', 'stage', 'unstage', 'fetch', 'refs']) assert.equal(ok(quiet), null, quiet);
  const bad = (method, kind, args = []) => eventForGit({ method, args, ok: false, error: { kind } });
  assert.equal(bad('merge', 'CONFLICT').type, 'conflict');
  assert.equal(bad('push', 'PUSH_REJECTED', [{ remote: 'upstream' }]).vars.remote, 'upstream');
  assert.equal(bad('push', 'NO_UPSTREAM').type, 'noUpstream');
  assert.equal(bad('checkout', 'DIRTY_WORKTREE').type, 'error');
  assert.equal(bad('status', 'ENOENT'), null);
  assert.equal(bad('push', 'AUTH_CANCELLED'), null);
});

test('donkey: moods', () => {
  assert.equal(moodOf('commit'), 'happy');
  assert.equal(moodOf('conflict'), 'worried');
  assert.equal(moodOf('resetHard'), 'shocked');
  assert.equal(moodOf('joke'), 'neutral');
});
