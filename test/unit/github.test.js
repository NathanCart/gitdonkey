'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHub, parseRemote, githubRemote } = require('../../src/main/github');

test('parseRemote reads github.com remotes in every form, and nothing else', () => {
  for (const url of [
    'https://github.com/acme/harbor-api.git',
    'https://github.com/acme/harbor-api',
    'https://nathan@github.com/acme/harbor-api.git',
    'git@github.com:acme/harbor-api.git',
    'ssh://git@github.com/acme/harbor-api.git',
    'ssh://git@ssh.github.com:443/acme/harbor-api.git',
  ]) assert.deepEqual(parseRemote(url), { owner: 'acme', name: 'harbor-api' }, url);
  assert.deepEqual(parseRemote('git@github.com:a.b/c.d.git'), { owner: 'a.b', name: 'c.d' });
  for (const url of ['https://gitlab.com/acme/x.git', '/tmp/origin.git', 'git@github.com:acme', 'https://github.com/acme/x/tree/main', null]) assert.equal(parseRemote(url), null, String(url));
});

test('githubRemote prefers origin, then upstream', () => {
  const remotes = [
    { name: 'mirror', fetchUrl: 'https://github.com/someone/else.git' },
    { name: 'upstream', fetchUrl: 'https://github.com/acme/app.git' },
    { name: 'origin', fetchUrl: '/srv/git/app.git' },
  ];
  assert.deepEqual(githubRemote(remotes), { owner: 'acme', name: 'app', remote: 'upstream' });
  remotes[2] = { name: 'origin', fetchUrl: 'git@github.com:me/app.git' };
  assert.deepEqual(githubRemote(remotes), { owner: 'me', name: 'app', remote: 'origin' });
  assert.equal(githubRemote([{ name: 'origin', fetchUrl: '/x' }]), null);
});

const vault = (token = null) => ({ get: (id) => (id === 'github' ? token : null) });
const pr = (n, extra = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`, isDraft: false, updatedAt: '2026-10-20T10:00:00Z',
  author: { login: 'maya', avatarUrl: 'https://x/a.png' }, headRefName: `feature/${n}`, headRefOid: 'a'.repeat(40), baseRefName: 'main',
  headRepositoryOwner: { login: 'acme' }, headRepository: { nameWithOwner: 'acme/app' }, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
  additions: 3, deletions: 1, changedFiles: 2, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...extra,
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const handler = routes(url, init.method, body);
    const [status, json] = handler;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test('pulls: one query for a repository, its checks and reviews read plainly', async () => {
  const fetch = fakeFetch((url, method, body) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.deepEqual(body.variables, { owner: 'acme', name: 'app' });
    return [200, { data: { viewer: { login: 'maya' }, repository: {
      nameWithOwner: 'acme/app', isFork: false, defaultBranchRef: { name: 'main' }, parent: null,
      pullRequests: { nodes: [pr(7), pr(8, { isDraft: true, reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }, headRepositoryOwner: { login: 'fan' }, headRepository: { nameWithOwner: 'fan/app' } })] },
    } } }];
  });
  const gh = new GitHub({ fetch, vault: vault('tok'), env: {} });
  const r = await gh.pulls({ owner: 'acme', name: 'app' });
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(r.viewer, 'maya');
  assert.equal(r.base.defaultBranch, 'main');
  assert.deepEqual(r.pulls.map((p) => [p.number, p.head, p.checks, p.review, p.draft, p.fromFork]), [
    [7, 'feature/7', 'passing', 'APPROVED', false, false],
    [8, 'feature/8', 'failing', null, true, true],
  ]);
});

test('pulls on a fork come from the repository it was forked from', async () => {
  const fetch = fakeFetch((url, method, body) => {
    if (body.variables.owner === 'me') {
      return [200, { data: { viewer: { login: 'me' }, repository: {
        nameWithOwner: 'me/app', isFork: true, defaultBranchRef: { name: 'main' },
        parent: { nameWithOwner: 'acme/app', name: 'app', owner: { login: 'acme' }, defaultBranchRef: { name: 'trunk' } },
        pullRequests: { nodes: [] },
      } } }];
    }
    return [200, { data: { repository: { pullRequests: { nodes: [pr(1, { headRepositoryOwner: { login: 'me' }, headRepository: { nameWithOwner: 'me/app' } })] } } } }];
  });
  const gh = new GitHub({ fetch, vault: vault('tok'), env: {} });
  const r = await gh.pulls({ owner: 'me', name: 'app' });
  assert.deepEqual(r.base, { owner: 'acme', name: 'app', nameWithOwner: 'acme/app', defaultBranch: 'trunk' });
  assert.equal(r.repo.fork, true);
  assert.equal(r.pulls[0].fromFork, true);
  assert.equal(r.pulls[0].headOwner, 'me');
});

test('createPull names a fork’s branch owner:branch, and GitHub’s complaints come through', async () => {
  const fetch = fakeFetch((url, method, body) => {
    if (body.head === 'taken') return [422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:taken.' }] }];
    return [201, { number: 12, html_url: 'https://github.com/acme/app/pull/12' }];
  });
  const gh = new GitHub({ fetch, vault: vault('tok'), env: {} });
  const r = await gh.createPull({ base: { owner: 'acme', name: 'app' }, from: { owner: 'me', name: 'app' }, head: 'fix', baseBranch: 'main', title: ' Fix it ', body: 'Why' });
  assert.deepEqual(r, { number: 12, url: 'https://github.com/acme/app/pull/12' });
  assert.equal(fetch.calls[0].url, 'https://api.github.com/repos/acme/app/pulls');
  assert.deepEqual(fetch.calls[0].body, { title: 'Fix it', body: 'Why', head: 'me:fix', base: 'main', draft: false });
  await gh.createPull({ base: { owner: 'acme', name: 'app' }, from: { owner: 'acme', name: 'app' }, head: 'same', baseBranch: 'main', title: 'x' });
  assert.equal(fetch.calls[1].body.head, 'same');
  await assert.rejects(gh.createPull({ base: { owner: 'acme', name: 'app' }, from: { owner: 'acme' }, head: 'taken', baseBranch: 'main', title: 'x' }), /already exists/);
  await assert.rejects(gh.createPull({ base: { owner: 'acme', name: 'app' }, head: 'x', baseBranch: 'main', title: '  ' }), /needs a title/);
});

test('auth: a saved token, then the environment, then nothing; 401 and offline say so', async () => {
  assert.deepEqual(await new GitHub({ fetch: null, vault: vault('saved'), env: { GH_TOKEN: 'env' } }).auth(), { token: 'saved', source: 'saved' });
  assert.deepEqual(await new GitHub({ fetch: null, vault: vault(), env: { GITHUB_TOKEN: 'env' } }).auth(), { token: 'env', source: 'env' });
  assert.equal(await new GitHub({ fetch: null, vault: vault(), env: {} }).auth(), null);
  const none = new GitHub({ fetch: null, vault: vault(), env: {} });
  await assert.rejects(none.pulls({ owner: 'a', name: 'b' }), (e) => e.kind === 'GH_AUTH');
  const bad = new GitHub({ fetch: fakeFetch(() => [401, { message: 'Bad credentials' }]), vault: vault('old'), env: {} });
  await assert.rejects(bad.pulls({ owner: 'a', name: 'b' }), (e) => e.kind === 'GH_AUTH' && /didn’t accept the token/.test(e.message));
  const off = new GitHub({ fetch: null, vault: vault('t'), env: {}, offline: true });
  await assert.rejects(off.pulls({ owner: 'a', name: 'b' }), (e) => e.kind === 'GH_OFFLINE');
  const missing = new GitHub({ fetch: fakeFetch(() => [200, { data: { viewer: { login: 'x' }, repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }]), vault: vault('t'), env: {} });
  await assert.rejects(missing.pulls({ owner: 'a', name: 'b' }), (e) => e.kind === 'GH_NOT_FOUND');
});
