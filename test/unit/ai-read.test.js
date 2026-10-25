'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExplainPrompt, buildPullPrompt, buildReviewPrompt, parseJsonReply, parsePullReply, parseReviewReply } = require('../../src/main/ai');
const { GitRepo } = require('../../src/main/git');
const { git, commitFile, newRepo, write } = require('./helpers');

const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';

test('explain: a commit or a branch, with its files and diff', () => {
  const c = buildExplainPrompt({ commit: { author: 'Maya', subject: 'Fix crash', body: 'When PORT is empty.' }, files: [{ status: 'M', path: 'src/a.js' }], diff: DIFF });
  assert.match(c.system, /one sentence/);
  assert.match(c.system, /Watch out: /);
  assert.match(c.user, /Commit by Maya: Fix crash\n\nWhen PORT is empty\./);
  assert.match(c.user, /M src\/a\.js/);
  assert.match(c.user, /\+new/);
  const b = buildExplainPrompt({ range: { base: 'main', head: 'feature/x', commits: [{ subject: 'Two' }, { subject: 'One' }] }, files: [], diff: DIFF });
  assert.match(b.user, /Branch feature\/x, compared with main\./);
  assert.match(b.user, /- Two\n- One/);
});

test('pull request prompt and reply: JSON title and body, fences or not', () => {
  const p = buildPullPrompt({ base: 'main', head: 'feature/x', commits: [{ subject: 'Add x' }], files: [], diff: DIFF, instructions: 'Mention the ticket HARB-1.' });
  assert.match(p.system, /"title"/);
  assert.match(p.system, /HARB-1/);
  assert.match(p.user, /Merging feature\/x into main\./);
  assert.deepEqual(parsePullReply('```json\n{"title": "  Add   rate limits ", "body": "## Changes\\n- x"}\n```'), { title: 'Add rate limits', body: '## Changes\n- x' });
  assert.deepEqual(parsePullReply('Sure! {"title":"T","body":null}'), { title: 'T', body: '' });
  assert.throws(() => parsePullReply('{"body":"no title"}'), /didn’t write a title/);
  assert.throws(() => parseJsonReply('not json'), (e) => e.kind === 'AI_FORMAT');
});

test('review prompt and reply: issues cleaned up and worst first', () => {
  const r = buildReviewPrompt({ diff: DIFF, files: [{ status: 'M', path: 'src/a.js' }], branch: 'develop' });
  assert.match(r.system, /Skip style/);
  assert.match(r.user, /Branch: develop/);
  const reply = parseReviewReply(JSON.stringify({
    summary: 'One real bug.',
    issues: [
      { file: 'b/src/a.js', line: 4, severity: 'Low', title: 'Minor', detail: 'x' },
      { file: 'src/a.js', line: '7', severity: 'HIGH', title: 'Crash', detail: 'Null deref.' },
      { file: 'src/b.js', line: 0, severity: 'catastrophic', title: 'Odd', detail: '' },
      { file: 'src/c.js', severity: 'medium' },
    ],
  }));
  assert.equal(reply.summary, 'One real bug.');
  assert.deepEqual(reply.issues.map((i) => [i.file, i.line, i.severity, i.title]), [
    ['src/a.js', null, 'high', 'Crash'],
    ['src/a.js', 4, 'low', 'Minor'],
    ['src/b.js', null, 'low', 'Odd'],
  ]);
  assert.deepEqual(parseReviewReply('{"summary":"Fine.","issues":[]}'), { summary: 'Fine.', issues: [] });
});

test('commitPatch and rangePatch give the AI a commit or a branch to read', async () => {
  const dir = newRepo();
  commitFile(dir, 'a.txt', 'one\n', 'first');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commitFile(dir, 'a.txt', 'two\n', 'second');
  write(dir, 'b.txt', 'b\n');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'third\n\nwith a body');
  const repo = new GitRepo(dir);
  const c = await repo.commitPatch(git(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(c.commit, { author: 'Test User', subject: 'third', body: 'with a body' });
  assert.deepEqual(c.files.map((f) => f.path), ['b.txt']);
  assert.match(c.diff, /\+b/);
  const first = await repo.commitPatch(git(dir, 'rev-parse', 'main'));
  assert.match(first.diff, /new file mode/);
  const r = await repo.rangePatch('main', 'feature');
  assert.deepEqual(r.range.commits.map((x) => x.subject), ['third', 'second']);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  assert.match(r.diff, /-one\n\+two/);
});
