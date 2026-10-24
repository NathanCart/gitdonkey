import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGraph } from '../../src/renderer/lib/graph-layout.js';
import { parseDiff, buildPatch, splitRows, diffStats } from '../../src/renderer/lib/diff-parse.js';
import { parseConflicts, resolveConflicts, conflictCount } from '../../src/renderer/lib/conflicts.js';

test('graph: linear history stays in one lane', () => {
  const g = computeGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(g.rows.map((r) => r.col), [0, 0, 0]);
  assert.equal(g.width, 1);
  assert.deepEqual(g.rows[1].edges, [{ from: 0, to: 0, color: g.rows[0].color, dashed: false }]);
  assert.deepEqual(g.tail, []);
});

test('graph: branch and merge', () => {
  const g = computeGraph([
    { hash: 'M', parents: ['A', 'B'] },
    { hash: 'B', parents: ['X'] },
    { hash: 'A', parents: ['X'] },
    { hash: 'X', parents: [] },
  ]);
  assert.deepEqual(g.rows.map((r) => r.col), [0, 1, 0, 0]);
  // B's incoming edges: lane 0 continues, lane 1 branches out of M (col 0).
  assert.deepEqual(g.rows[1].edges.map((e) => [e.from, e.to]), [[0, 0], [0, 1]]);
  // X receives both lanes.
  assert.deepEqual(g.rows[3].edges.map((e) => [e.from, e.to]), [[0, 0], [1, 0]]);
  assert.equal(g.width, 2);
});

test('graph: merge parent already has a lane', () => {
  // T1 and T2 are tips; M merges P which is also the parent of T2.
  const g = computeGraph([
    { hash: 'T2', parents: ['P'] },
    { hash: 'M', parents: ['Q', 'P'] },
    { hash: 'P', parents: ['R'] },
    { hash: 'Q', parents: ['R'] },
    { hash: 'R', parents: [] },
  ]);
  assert.deepEqual(g.rows.map((r) => r.col), [0, 1, 0, 1, 0]);
  // Row P: lane 0 (P) from T2 and the merge edge from M (col 1) both land on P.
  const toP = g.rows[2].edges.filter((e) => e.to === 0).map((e) => e.from).sort();
  assert.deepEqual(toP, [0, 1]);
});

test('graph: WIP row has dashed lane and open tails are reported', () => {
  const g = computeGraph([
    { hash: 'WIP', parents: ['h'], wip: true },
    { hash: 'h', parents: ['notloaded'] },
  ]);
  assert.equal(g.rows[1].edges[0].dashed, true);
  assert.deepEqual(g.tail, [{ from: 0, to: 0, color: g.rows[1].color, dashed: false }]);
});

test('graph: independent root commits reuse freed columns', () => {
  const g = computeGraph([
    { hash: 'a2', parents: ['a1'] },
    { hash: 'a1', parents: [] },
    { hash: 'b2', parents: ['b1'] },
    { hash: 'b1', parents: [] },
  ]);
  assert.deepEqual(g.rows.map((r) => r.col), [0, 0, 0, 0]);
  assert.deepEqual(g.rows[2].edges, []);
});

const SAMPLE = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@ section
 one
-two
+TWO
 three
 four
@@ -10,3 +10,4 @@
 ten
 eleven
+eleven and a half
 twelve
`;

test('parseDiff reads headers, hunks and line numbers', () => {
  const [f] = parseDiff(SAMPLE);
  assert.equal(f.oldPath, 'f.txt');
  assert.equal(f.newPath, 'f.txt');
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].section, 'section');
  assert.deepEqual(f.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo]), [
    [' ', 1, 1], ['-', 2, null], ['+', null, 2], [' ', 3, 3], [' ', 4, 4],
  ]);
  assert.deepEqual(diffStats(f), { add: 2, del: 1 });
  assert.equal(f.header.length, 4);
});

test('buildPatch: whole hunk, subset, reverse', () => {
  const [f] = parseDiff(SAMPLE);
  const second = buildPatch(f, new Map([[1, 'all']]));
  assert.ok(second.includes('@@ -10,3 +10,4 @@'));
  assert.ok(!second.includes('TWO'));
  // Only the "+TWO" line: "-two" turns into context.
  const plusOnly = buildPatch(f, new Map([[0, new Set([2])]]));
  assert.ok(plusOnly.includes('@@ -1,4 +1,5 @@'));
  assert.ok(plusOnly.includes('\n two\n+TWO\n'));
  // Reverse: only "-two"; the "+TWO" line becomes context, "-" kept.
  const rev = buildPatch(f, new Map([[0, new Set([1])]]), { reverse: true });
  assert.ok(rev.includes('\n-two\n TWO\n'));
  assert.equal(buildPatch(f, new Map([[0, new Set([0])]])), null);
});

test('splitRows pairs deletions and additions', () => {
  const [f] = parseDiff(SAMPLE);
  const rows = splitRows(f.hunks[0]);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].left.text, 'two');
  assert.equal(rows[1].right.text, 'TWO');
  const rows2 = splitRows(f.hunks[1]);
  assert.equal(rows2[2].left, null);
  assert.equal(rows2[2].right.text, 'eleven and a half');
});

test('parseDiff handles binary and new files', () => {
  const files = parseDiff(`diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc
Binary files /dev/null and b/img.png differ
diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/n.txt
@@ -0,0 +1 @@
+hi
\\ No newline at end of file
`);
  assert.equal(files.length, 2);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].isNew, true);
  assert.equal(files[1].oldPath, null);
  assert.equal(files[1].hunks[0].lines[1].type, '\\');
});

test('conflicts: parse, count, resolve', () => {
  const text = 'top\n<<<<<<< HEAD\nours 1\nours 2\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\nend\n';
  const segs = parseConflicts(text);
  assert.equal(conflictCount(segs), 2);
  assert.equal(segs[1].oursLabel, 'HEAD');
  assert.equal(segs[1].theirsLabel, 'feature');
  assert.deepEqual(segs[1].base, ['base']);
  assert.equal(resolveConflicts(segs, ['ours', 'theirs']), 'top\nours 1\nours 2\nmiddle\nb\nend\n');
  assert.equal(resolveConflicts(segs, ['both', 'both-theirs-first']), 'top\nours 1\nours 2\ntheirs\nmiddle\nb\na\nend\n');
  // Unresolved conflicts round-trip with markers.
  const round = resolveConflicts(segs, []);
  assert.equal(conflictCount(parseConflicts(round)), 2);
  // Unterminated markers are treated as text.
  assert.equal(conflictCount(parseConflicts('<<<<<<< HEAD\nx\n')), 0);
});
