'use strict';

// Pull requests for repositories on github.com. Signs in with a token the
// user pasted, GH_TOKEN / GITHUB_TOKEN, or the GitHub CLI's own login.

const { spawn } = require('child_process');

const API = 'https://api.github.com';
const TIMEOUT_MS = 20000;

class GitHubError extends Error {
  constructor(message, kind = null) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
  }
}

/** owner/name from a github.com remote URL (https, ssh or scp-style), or null. */
function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** The GitHub repository behind a repo's remotes: origin first, then upstream, then any other. */
function githubRemote(remotes) {
  const rank = (n) => (n === 'origin' ? 0 : n === 'upstream' ? 1 : 2);
  for (const r of [...(remotes || [])].sort((a, b) => rank(a.name) - rank(b.name))) {
    const p = parseRemote(r.fetchUrl || r.pushUrl);
    if (p) return { ...p, remote: r.name };
  }
  return null;
}

const PR_FIELDS = `number title url isDraft createdAt updatedAt additions deletions changedFiles reviewDecision mergeable
  author { login avatarUrl } headRefName headRefOid baseRefName headRepositoryOwner { login } headRepository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
const REPO_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner isFork defaultBranchRef { name }
    parent { nameWithOwner name owner { login } defaultBranchRef { name } }
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}`;
const PULLS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  }
}`;

const CHECKS = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'running', EXPECTED: 'running' };

function mapPull(n, repoName) {
  const rollup = n.commits && n.commits.nodes && n.commits.nodes[0] && n.commits.nodes[0].commit.statusCheckRollup;
  const headRepo = n.headRepository ? n.headRepository.nameWithOwner : null;
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    draft: Boolean(n.isDraft),
    author: n.author ? n.author.login : 'ghost',
    avatarUrl: n.author ? n.author.avatarUrl : null,
    head: n.headRefName,
    headOid: n.headRefOid,
    headOwner: n.headRepositoryOwner ? n.headRepositoryOwner.login : null,
    fromFork: Boolean(headRepo && repoName && headRepo.toLowerCase() !== repoName.toLowerCase()),
    base: n.baseRefName,
    review: n.reviewDecision || null,
    checks: rollup ? CHECKS[rollup.state] || null : null,
    mergeable: n.mergeable || null,
    additions: n.additions || 0,
    deletions: n.deletions || 0,
    files: n.changedFiles || 0,
    updatedAt: Date.parse(n.updatedAt) || null,
  };
}

class GitHub {
  constructor({ fetch, vault, ghPath = () => null, api = API, env = process.env, offline = false }) {
    this.fetch = fetch;
    this.vault = vault;
    this.ghPath = ghPath;
    this.api = api.replace(/\/+$/, '');
    this.env = env;
    this.offline = offline;
    this.ghToken = null;
  }

  /** Where the token comes from right now: 'saved', 'env', 'gh', or null. */
  async auth() {
    const saved = this.vault.get('github');
    if (saved) return { token: saved, source: 'saved' };
    const fromEnv = this.env.GITDONKEY_GITHUB_TOKEN || this.env.GH_TOKEN || this.env.GITHUB_TOKEN;
    if (fromEnv) return { token: fromEnv, source: 'env' };
    const gh = this.ghPath();
    if (gh) {
      if (!this.ghToken || Date.now() - this.ghToken.at > 10 * 60 * 1000) {
        const token = await ghAuthToken(gh).catch(() => null);
        this.ghToken = token ? { token, at: Date.now() } : null;
      }
      if (this.ghToken) return { token: this.ghToken.token, source: 'gh' };
    }
    return null;
  }

  async request(method, path, body) {
    if (this.offline) throw new GitHubError('GitHub is switched off in offline mode.', 'GH_OFFLINE');
    const auth = await this.auth();
    if (!auth) throw new GitHubError('Connect GitHub to see and open pull requests.', 'GH_AUTH');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(`${this.api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'GitDonkey',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new GitHubError(e.name === 'AbortError' ? 'GitHub didn’t answer in time.' : `Couldn’t reach GitHub (${e.message}).`, 'GH_NETWORK');
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status === 401) {
      if (auth.source === 'gh') this.ghToken = null;
      throw new GitHubError(`GitHub didn’t accept the ${auth.source === 'gh' ? 'GitHub CLI’s login' : 'token'}. Connect GitHub again.`, 'GH_AUTH');
    }
    if (!res.ok) {
      const detail = json && Array.isArray(json.errors) && json.errors.length ? json.errors.map((e) => e.message || e.code).filter(Boolean).join('; ') : '';
      const msg = (json && json.message) || `GitHub answered ${res.status}`;
      throw new GitHubError(detail ? `${msg}: ${detail}` : msg, res.status === 404 ? 'GH_NOT_FOUND' : res.status === 422 ? 'GH_INVALID' : 'GH_ERROR');
    }
    return json;
  }

  async graphql(query, variables) {
    const r = await this.request('POST', '/graphql', { query, variables });
    if (r && Array.isArray(r.errors) && r.errors.length) {
      const notFound = r.errors.some((e) => e.type === 'NOT_FOUND');
      throw new GitHubError(r.errors.map((e) => e.message).join('; '), notFound ? 'GH_NOT_FOUND' : 'GH_ERROR');
    }
    return r ? r.data : null;
  }

  /**
   * The repository's open pull requests. For a fork, the ones on the repository
   * it was forked from, where pull requests from it are opened.
   */
  async pulls({ owner, name }) {
    const data = await this.graphql(REPO_QUERY, { owner, name });
    const repo = data && data.repository;
    if (!repo) throw new GitHubError(`GitHub has no repository ${owner}/${name} you can see.`, 'GH_NOT_FOUND');
    let base = { owner, name, nameWithOwner: repo.nameWithOwner, defaultBranch: repo.defaultBranchRef ? repo.defaultBranchRef.name : null };
    let nodes = repo.pullRequests.nodes;
    if (repo.isFork && repo.parent) {
      const p = repo.parent;
      base = { owner: p.owner.login, name: p.name, nameWithOwner: p.nameWithOwner, defaultBranch: p.defaultBranchRef ? p.defaultBranchRef.name : null };
      const parent = await this.graphql(PULLS_QUERY, { owner: base.owner, name: base.name }).catch(() => null);
      if (parent && parent.repository) nodes = parent.repository.pullRequests.nodes.concat(nodes);
    }
    const seen = new Set();
    const pulls = nodes.map((n) => mapPull(n, base.nameWithOwner)).filter((p) => !seen.has(p.url) && seen.add(p.url));
    return {
      viewer: data.viewer ? data.viewer.login : null,
      repo: { owner, name, nameWithOwner: repo.nameWithOwner, fork: Boolean(repo.isFork) },
      base,
      pulls,
    };
  }

  /** Open a pull request. `head` is a branch on `from` (the fork, when it isn't the base repository). */
  async createPull({ base, from, head, baseBranch, title, body = '', draft = false }) {
    if (!title || !String(title).trim()) throw new GitHubError('A pull request needs a title.', 'GH_INVALID');
    const headRef = from && from.owner && from.owner.toLowerCase() !== base.owner.toLowerCase() ? `${from.owner}:${head}` : head;
    const r = await this.request('POST', `/repos/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.name)}/pulls`, {
      title: String(title).trim(), body: String(body || ''), head: headRef, base: baseBranch, draft: Boolean(draft),
    });
    return { number: r.number, url: r.html_url };
  }
}

function ghAuthToken(gh) {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(gh, ['auth', 'token', '--hostname', 'github.com'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const token = out.trim();
      if (code === 0 && token) resolve(token);
      else reject(new Error('gh has no token'));
    });
  });
}

module.exports = { GitHub, GitHubError, parseRemote, githubRemote, mapPull };
