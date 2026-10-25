import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzy, rank } from '../../src/renderer/lib/fuzzy.js';

test('fuzzy: substrings beat scattered letters; word starts beat the middle', () => {
  assert.equal(fuzzy('xyz', 'Push').score, -1);
  assert.ok(fuzzy('push', 'Push').score > fuzzy('push', 'Open pull request…').score);
  assert.ok(fuzzy('pr', 'Open pull request…').score >= 0, 'p…r in order');
  assert.deepEqual(fuzzy('pr', 'Open pull request').hits, [5, 10], 'initials of words');
  assert.ok(fuzzy('cb', 'Create branch…').score > fuzzy('cb', 'Fetch all branches').score);
  assert.deepEqual(fuzzy('ch', 'Check out main').hits, [0, 1]);
  assert.ok(fuzzy('main check', 'Check out main').score > 0, 'words in any order');
  assert.equal(fuzzy('main zzz', 'Check out main').score, -1);
});

test('rank keeps the order for an empty query and sorts by score otherwise', () => {
  const items = [{ label: 'Stash changes' }, { label: 'Pull' }, { label: 'Push' }, { label: 'Pop stash' }];
  assert.deepEqual(rank(items, '').map((r) => r.item.label), ['Stash changes', 'Pull', 'Push', 'Pop stash']);
  assert.deepEqual(rank(items, 'pu').map((r) => r.item.label), ['Pull', 'Push']);
  assert.deepEqual(rank(items, 'stash').map((r) => r.item.label), ['Stash changes', 'Pop stash']);
});
