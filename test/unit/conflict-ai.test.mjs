import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseConflicts, resolveConflicts, conflictContext, parseResolutionReply } from '../../src/renderer/lib/conflicts.js';

const require = createRequire(import.meta.url);
const { buildConflictPrompt } = require('../../src/main/ai.js');

const FILE = [
  'const a = 1;', 'const b = 2;',
  '<<<<<<< Updated upstream', "export const MODELS = ['flux', 'krea'];", '=======', "export const MODELS = ['flux', 'deepseek'];", '>>>>>>> Stashed changes',
  'export const X = 1;',
  '<<<<<<< Updated upstream', 'one', '||||||| base', 'zero', '=======', 'two', '>>>>>>> Stashed changes',
  '',
].join('\n');

test('conflict context: each conflict with its sides, base and neighbouring lines', () => {
  const ctx = conflictContext(parseConflicts(FILE), 2);
  assert.equal(ctx.length, 2);
  assert.deepEqual(ctx[0].before, ['const a = 1;', 'const b = 2;']);
  assert.deepEqual(ctx[0].after, ['export const X = 1;']);
  assert.deepEqual(ctx[1].base, ['zero']);
  assert.equal(ctx[1].theirsLabel, 'Stashed changes');
});

test('AI replies: fenced, chatty or stringly typed are read; junk, markers and strays are not', () => {
  const reply = 'Sure!\n```json\n{"resolutions":[{"conflict":1,"lines":["export const MODELS = [\'flux\', \'krea\', \'deepseek\'];"],"why":"Both sides added a model.","confidence":"high"},'
    + '{"conflict":2,"lines":"one\\ntwo","confidence":"sure"},{"conflict":7,"lines":["x"]},{"conflict":1,"lines":["dupe"]}]}\n```';
  const got = parseResolutionReply(reply, 2);
  assert.deepEqual([...got.keys()], [0, 1]);
  assert.equal(got.get(0).why, 'Both sides added a model.');
  assert.deepEqual(got.get(1).lines, ['one', 'two']);
  assert.equal(got.get(1).confidence, 'medium');
  assert.throws(() => parseResolutionReply('I think you should keep both.', 2), /format/);
  assert.throws(() => parseResolutionReply('{"resolutions":[{"conflict":1,"lines":["<<<<<<< HEAD","x"]}]}', 1), /any of these/);
});

test('an accepted suggestion replaces its conflict and nothing else', () => {
  const segments = parseConflicts(FILE);
  const out = resolveConflicts(segments, [{ lines: ["export const MODELS = ['flux', 'krea', 'deepseek'];"] }, 'theirs']);
  assert.equal(out, "const a = 1;\nconst b = 2;\nexport const MODELS = ['flux', 'krea', 'deepseek'];\nexport const X = 1;\ntwo\n");
  assert.equal(resolveConflicts(segments, [{ lines: ['x'] }]).includes('<<<<<<< Updated upstream'), true, 'the open conflict keeps its markers');
});

test('the conflict prompt carries every side, says what happened, and stays within budget', () => {
  const ctx = conflictContext(parseConflicts(FILE));
  const p = buildConflictPrompt({ path: 'lib/studio-presets.ts', operation: 'a stash was applied', oursLabel: 'Updated upstream', theirsLabel: 'Stashed changes', conflicts: ctx });
  assert.match(p.system, /JSON only/);
  assert.match(p.user, /lib\/studio-presets\.ts/);
  assert.match(p.user, /Conflict 2[\s\S]*BASE:[\s\S]*zero/);
  assert.match(p.user, /deepseek/);
  const huge = Array.from({ length: 60 }, (_, i) => ({ index: i, ours: Array(150).fill(`ours line ${i}`), theirs: Array(150).fill(`theirs line ${i}`), base: null, before: [], after: [] }));
  const big = buildConflictPrompt({ path: 'big.ts', operation: 'merge', conflicts: huge });
  assert.ok(big.user.length < 42000);
  assert.match(big.user, /more conflicts/);
});
