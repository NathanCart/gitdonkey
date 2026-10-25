import test from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from '../../src/renderer/lib/find.js';

test('findAll: every match, case-insensitive unless asked, no overlaps', () => {
  assert.deepEqual(findAll('Json json JSON', 'json'), [0, 5, 10]);
  assert.deepEqual(findAll('Json json JSON', 'json', { matchCase: true }), [5]);
  assert.deepEqual(findAll('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(findAll('abc', ''), []);
  assert.deepEqual(findAll('abc', 'x'), []);
});

import { parseLfsPointer, lfsDiff } from '../../src/renderer/lib/lfs.js';
import { parseDiff } from '../../src/renderer/lib/diff-parse.js';

const OID = (c) => c.repeat(64);

test('parseLfsPointer reads pointer files and nothing else', () => {
  assert.deepEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID('a')}\nsize 12345\n`), { oid: OID('a'), size: 12345 });
  assert.deepEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${OID('c')}\noid sha256:${OID('a')}\nsize 1\n`), { oid: OID('a'), size: 1 });
  assert.equal(parseLfsPointer('hello\n'), null);
  assert.equal(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID('a')}\nsize 1\n${'x'.repeat(2000)}`), null);
});

test('lfsDiff turns a pointer diff into before and after sizes', () => {
  const [file] = parseDiff(`diff --git a/x.psd b/x.psd\nindex 1..2 100644\n--- a/x.psd\n+++ b/x.psd\n@@ -1,3 +1,3 @@\n version https://git-lfs.github.com/spec/v1\n-oid sha256:${OID('a')}\n-size 100\n+oid sha256:${OID('b')}\n+size 2000\n`);
  assert.deepEqual(lfsDiff(file), { before: { oid: OID('a'), size: 100 }, after: { oid: OID('b'), size: 2000 } });
  const [plain] = parseDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(lfsDiff(plain), null);
});
