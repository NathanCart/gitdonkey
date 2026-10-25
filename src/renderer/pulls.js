// Pull requests on GitHub: the open ones for this repository, their number and
// checks on branch plugs, checking one out, and opening a new one.
import { h, icon } from './dom.js';
import { invoke, git } from './api.js';
import { toast, formDialog, contextMenu } from './ui.js';
import { relativeTime, pluralize } from './lib/util.js';

const STALE_MS = 90 * 1000;
const CHECK_LED = { passing: 'green', failing: 'red', running: 'amber' };
const CHECK_WORD = { passing: 'Checks passing', failing: 'Checks failing', running: 'Checks running' };
const REVIEW_WORD = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };

/** "feature/rate-limiter" → "Rate limiter". */
export function titleFromBranch(name) {
  const leaf = String(name || '').split('/').pop().replace(/[-_]+/g, ' ').trim();
  return leaf ? leaf[0].toUpperCase() + leaf.slice(1) : '';
}

export function pullTitle(pr) {
  return [
    `#${pr.number} ${pr.title}`,
    `${pr.fromFork && pr.headOwner ? `${pr.headOwner}:` : ''}${pr.head} → ${pr.base} · by ${pr.author}${pr.updatedAt ? ` · updated ${relativeTime(pr.updatedAt)}` : ''}`,
    [pr.draft ? 'Draft' : null, pr.checks ? CHECK_WORD[pr.checks] : null, pr.review ? REVIEW_WORD[pr.review] : null].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n');
}

/** The small "#12" tag a branch with a pull request wears. */
export function pullTag(pr) {
  return h('span', { class: ['pr-tag', pr.checks && `checks-${pr.checks}`, pr.draft && 'draft'], title: pullTitle(pr) },
    icon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request', { size: 11 }), `#${pr.number}`);
}

export class Pulls {
  constructor(app) {
    this.app = app;
  }

  state(tab = this.app.tab) {
    if (!tab) return { status: 'none' };
    if (!tab.prs) tab.prs = { status: 'idle', list: [], at: 0 };
    return tab.prs;
  }

  /** Bring the list up to date (quietly; nothing happens for repositories that aren't on GitHub). */
  async load(tab = this.app.tab, { force = false } = {}) {
    if (!tab || !tab.root || !tab.data) return;
    const s = this.state(tab);
    const sig = JSON.stringify(tab.data.remotes.map((r) => [r.name, r.fetchUrl]));
    if (s.loading) return;
    if (!force && s.sig === sig && (s.status === 'none' || s.status === 'signin' || Date.now() - s.at < STALE_MS)) return;
    s.loading = true;
    try {
      if (force || s.sig !== sig || s.status === 'idle' || s.status === 'signin') {
        const st = await invoke('gh:status', tab.root);
        s.sig = sig;
        s.remote = st.remote;
        s.source = st.source;
        if (!st.remote) {
          Object.assign(s, { status: 'none', list: [] });
          return;
        }
        if (!st.signedIn) {
          Object.assign(s, { status: 'signin', list: [] });
          return;
        }
      }
      if (!s.list.length) s.status = 'loading';
      const r = await invoke('gh:pulls', tab.root);
      Object.assign(s, { status: 'ready', list: r.pulls, base: r.base, repo: r.repo, viewer: r.viewer, error: null, at: Date.now() });
    } catch (e) {
      Object.assign(s, e.kind === 'GH_AUTH' ? { status: 'signin', list: [] } : e.kind === 'GH_NONE' ? { status: 'none', list: [] } : { status: 'error', error: e.message, at: Date.now() });
    } finally {
      s.loading = false;
      if (tab === this.app.tab && tab.data) {
        this.app.buildGraph();
        this.app.renderAll({ skipDetail: true });
      }
    }
  }

  /** The open pull request whose head is this branch of ours, if any. */
  forBranch(name, { remote = null } = {}) {
    const s = this.state();
    if (!s.list || !s.list.length || !name) return null;
    if (remote && s.remote && remote !== s.remote.remote) return null;
    const own = s.repo && s.base && s.repo.nameWithOwner === s.base.nameWithOwner;
    return s.list.find((p) => p.head === name && (own ? !p.fromFork : p.fromFork && s.repo && p.headOwner === s.repo.owner)) || null;
  }

  /** Give branch refs in the graph their pull request. */
  annotate(refsByHash) {
    const s = this.state();
    if (!s.list || !s.list.length) return;
    for (const list of refsByHash.values()) {
      for (const ref of list) {
        if (ref.type === 'local') ref.pr = this.forBranch(ref.name);
        else if (ref.type === 'remote') ref.pr = this.forBranch(ref.branchName, { remote: ref.remote });
      }
    }
  }

  /** The sidebar's Pull requests section body. */
  sidebarItems(register) {
    const s = this.state();
    const app = this.app;
    if (s.status === 'signin') {
      return [h('div', { class: 'sb-empty sb-gh' }, h('span', null, 'Connect GitHub to see this repository’s pull requests.'),
        h('button', { class: 'btn btn-tiny', onClick: () => this.connect() }, icon('git-pull-request', { size: 12 }), 'Connect GitHub…'))];
    }
    if (s.status === 'error') {
      return [h('div', { class: 'sb-empty sb-gh' }, h('span', null, s.error),
        h('button', { class: 'btn btn-tiny', onClick: () => this.load(app.tab, { force: true }) }, 'Retry'))];
    }
    if (s.status === 'loading' || s.status === 'idle') return [h('div', { class: 'sb-empty' }, 'Loading pull requests…')];
    if (!s.list.length) return [h('div', { class: 'sb-empty' }, `No open pull requests on ${s.base ? s.base.nameWithOwner : 'GitHub'}.`)];
    return s.list.map((pr) => {
      const item = h('div', {
        class: ['sb-item', 'sb-pr', pr.draft && 'draft'],
        style: { '--indent': '0' },
        title: `${pullTitle(pr)}\nDouble-click to check out`,
      },
      h('span', { class: ['pr-led', pr.checks && `checks-${pr.checks}`] }),
      h('span', { class: 'sb-pr-num' }, `#${pr.number}`),
      h('span', { class: 'sb-name' }, pr.title),
      pr.review === 'APPROVED' ? h('span', { class: 'pr-review ok', title: 'Approved' }, icon('check', { size: 12, stroke: 2.5 })) : null,
      pr.review === 'CHANGES_REQUESTED' ? h('span', { class: 'pr-review bad', title: 'Changes requested' }, icon('circle-x', { size: 12 })) : null);
      register(item, { type: 'pr', name: `#${pr.number}`, pr });
      return item;
    });
  }

  /** Select the pull request's head in the graph, when it's there. */
  reveal(pr) {
    if (this.app.indexByHash.has(pr.headOid)) this.app.selectCommit(pr.headOid, { scroll: true });
    else toast({ type: 'info', title: `#${pr.number} isn’t in the graph yet`, message: 'Fetch, or check it out, to see its commits.', actions: [{ label: 'Check out', run: () => this.checkout(pr) }] });
  }

  menu(pr, x, y) {
    const app = this.app;
    contextMenu(x, y, [
      { header: `#${pr.number} ${pr.title}` },
      { label: `Check out ${pr.fromFork ? `#${pr.number}` : pr.head}`, icon: 'check', run: () => this.checkout(pr) },
      { label: 'Show in graph', icon: 'crosshair', run: () => this.reveal(pr) },
      '-',
      { label: 'Open on GitHub', icon: 'external-link', run: () => invoke('shell:openExternal', pr.url) },
      { label: 'Copy link', icon: 'copy', run: () => app.copy(pr.url, 'Link copied') },
    ]);
  }

  /** Check out the branch behind a pull request; from a fork, fetch it as pr/<number>. */
  async checkout(pr) {
    const app = this.app;
    const s = this.state();
    const d = app.data;
    const own = !pr.fromFork && s.repo && s.base && s.repo.nameWithOwner === s.base.nameWithOwner;
    if (own) {
      const remote = s.remote.remote;
      const local = d.refs.local.find((b) => b.name === pr.head);
      if (local) return app.checkoutBranch(local.name);
      if (!d.refs.remote.some((r) => r.remote === remote && r.name === pr.head)) await app.fetchRemote(remote);
      return app.checkoutRef({ type: 'remote', name: `${remote}/${pr.head}`, remote, branchName: pr.head });
    }
    // The base repository as one of ours, or by URL.
    const baseName = s.base.nameWithOwner.toLowerCase();
    const remote = d.remotes.find((r) => (r.fetchUrl || '').toLowerCase().replace(/\.git$/, '').endsWith(`github.com/${baseName}`) || (r.fetchUrl || '').toLowerCase().replace(/\.git$/, '').endsWith(`github.com:${baseName}`));
    const from = remote ? remote.name : `https://github.com/${s.base.nameWithOwner}.git`;
    return app.run(`Check out #${pr.number}`, () => git(app.repo, 'checkoutPull', from, pr.number, `pr/${pr.number}`), { success: `Checked out #${pr.number} as pr/${pr.number}`, autoStash: true });
  }

  /** Connect GitHub: the GitHub CLI's login when it's there, or a pasted token. */
  async connect() {
    const st = await invoke('gh:status', this.app.repo).catch(() => ({}));
    const page = 'https://github.com/settings/tokens/new?scopes=repo&description=GitDonkey';
    const v = await formDialog({
      title: 'Connect GitHub',
      okLabel: 'Save token',
      width: 520,
      intro: h('div', { class: 'stack' },
        h('p', { class: 'modal-text' }, st.gh
          ? 'GitDonkey uses the GitHub CLI’s login when it can, but it didn’t work. Paste a personal access token instead.'
          : 'GitDonkey uses the GitHub CLI’s login when gh is installed and signed in (run gh auth login). Or paste a personal access token: a classic one with the repo scope, or a fine-grained one with Pull requests read and write.'),
        h('div', { class: 'cred-hint' }, h('span', null, 'Tokens are saved with your system keychain and only sent to GitHub.'),
          h('button', { type: 'button', class: 'btn btn-small', onClick: () => invoke('shell:openExternal', page) }, icon('external-link', { size: 13 }), 'Create a token'))),
      fields: [{ name: 'token', label: 'Personal access token', type: 'password', placeholder: 'ghp_… or github_pat_…' }],
      validate: (x) => (!x.token.trim() ? 'Paste a token.' : null),
    });
    if (!v) return;
    try {
      await invoke('gh:setToken', v.token.trim());
    } catch (e) {
      toast({ type: 'error', title: 'Couldn’t save the token', message: e.message });
      return;
    }
    await this.load(this.app.tab, { force: true });
    const s = this.state();
    if (s.status === 'ready') toast({ type: 'success', title: 'GitHub connected', message: `${pluralize(s.list.length, 'open pull request')} on ${s.base.nameWithOwner}.` });
    else if (s.status === 'signin') toast({ type: 'error', title: 'GitHub didn’t accept that token' });
  }

  /** Open a pull request for `branch` (the current one by default). */
  async create(branch = this.app.currentBranch) {
    const app = this.app;
    let s = this.state();
    if (s.status === 'signin') return this.connect();
    if (s.status !== 'ready') {
      await this.load(app.tab, { force: true });
      s = this.state();
      if (s.status === 'signin') return this.connect();
      if (s.status !== 'ready') {
        toast({ type: 'error', title: 'Can’t open a pull request', message: s.status === 'none' ? 'This repository has no GitHub remote.' : s.error || 'GitHub isn’t reachable.' });
        return null;
      }
    }
    if (!branch) {
      toast({ type: 'info', title: 'Check out a branch first' });
      return null;
    }
    const existing = this.forBranch(branch);
    if (existing) {
      toast({ type: 'info', title: `${branch} already has #${existing.number}`, message: existing.title, actions: [{ label: 'Open on GitHub', run: () => invoke('shell:openExternal', existing.url) }] });
      return null;
    }
    const d = app.data;
    const remote = s.remote.remote;
    const own = s.repo.nameWithOwner === s.base.nameWithOwner;
    const bases = own ? d.refs.remote.filter((r) => r.remote === remote).map((r) => r.name) : [];
    const defaultBase = s.base.defaultBranch && s.base.defaultBranch !== branch ? s.base.defaultBranch : bases.find((n) => n !== branch) || s.base.defaultBranch || 'main';
    const options = [...new Set([defaultBase, ...bases.filter((n) => n !== branch)])];
    const commitsFor = async (base) => git(app.repo, 'commitsBetween', own && bases.includes(base) ? `${remote}/${base}` : `${remote}/${defaultBase}`, branch).catch(() => []);
    let commits = await commitsFor(defaultBase);
    const defaults = (list) => ({
      title: list.length === 1 ? list[0].subject : titleFromBranch(branch),
      body: list.length > 1 ? list.slice().reverse().map((c) => `- ${c.subject}`).join('\n') : '',
    });
    let touched = { title: false, body: false };
    let fields = null;
    const first = defaults(commits);
    const aiStatus = h('span', { class: 'ai-status' });
    let writing = null;
    const aiLabel = h('span', null, 'Write with AI');
    const aiBtn = h('button', { type: 'button', class: 'btn btn-small ai-key', title: 'Write the title and description from the commits and diff', onClick: async () => {
      if (writing) {
        writing.cancel();
        return;
      }
      if (!app.aiConfig()) return app.command('ai-settings');
      aiBtn.setAttribute('aria-busy', 'true');
      aiLabel.textContent = 'Stop · 0s';
      aiStatus.textContent = 'Writing…';
      aiStatus.classList.remove('bad');
      try {
        const base = own && bases.includes(fields.base.value) ? `${remote}/${fields.base.value}` : `${remote}/${defaultBase}`;
        writing = app.ai.describePull({ base, head: branch }, { onTick: (s) => {
          aiLabel.textContent = `Stop · ${s}s`;
        } });
        const r = await writing.promise;
        fields.title.value = r.title;
        fields.body.value = r.body;
        touched = { title: true, body: true };
        aiStatus.textContent = 'Written by AI. Read it before you open the pull request.';
      } catch (e) {
        aiStatus.textContent = e.kind === 'AI_CANCELLED' ? 'Stopped.' : e.message;
        aiStatus.classList.toggle('bad', e.kind !== 'AI_CANCELLED');
      } finally {
        writing = null;
        aiLabel.textContent = 'Write with AI';
        aiBtn.removeAttribute('aria-busy');
      }
    } }, icon('sparkles', { size: 13 }), aiLabel);
    const v = await formDialog({
      title: `Open a pull request for ${branch}`,
      okLabel: 'Open pull request',
      width: 620,
      intro: h('p', { class: 'modal-text' }, `On ${s.base.nameWithOwner}${own ? '' : ` from your fork ${s.repo.nameWithOwner}`}. ${commits.length ? `${pluralize(commits.length, 'commit')} to merge.` : ''}`),
      fields: [
        { name: 'base', label: 'Merge into', type: 'select', value: defaultBase, options: options.map((n) => ({ value: n, label: n })) },
        { name: 'title', label: 'Title', value: first.title, select: false },
        { name: 'body', label: 'Description', type: 'textarea', rows: 8, value: first.body, placeholder: 'What changes, and why. Markdown works.' },
        { name: 'draft', type: 'checkbox', label: 'Open as a draft', value: false },
      ],
      extra: h('div', { class: 'ai-tools' }, aiBtn, aiStatus),
      onChange: async (x, inputs) => {
        fields = inputs;
        if (touched && document.activeElement === inputs.title) touched.title = true;
        if (touched && document.activeElement === inputs.body) touched.body = true;
        if (x.base !== this.lastBase) {
          this.lastBase = x.base;
          commits = await commitsFor(x.base);
          const next = defaults(commits);
          if (touched && !touched.title) inputs.title.value = next.title;
          if (touched && !touched.body) inputs.body.value = next.body;
        }
      },
      validate: (x) => (!x.title.trim() ? 'Give it a title.' : null),
    });
    this.lastBase = null;
    touched = null;
    if (!v) return null;
    // GitHub needs the branch there, with everything in it.
    const b = d.refs.local.find((x) => x.name === branch);
    if (b && (!b.upstream || b.gone || b.ahead || b.upstreamRemote !== remote)) {
      if (!b.isHead) {
        await app.pushTo(branch, remote, branch);
      } else {
        await app.push();
      }
      const now = app.data.refs.local.find((x) => x.name === branch);
      if (!now || !now.upstream || now.ahead) {
        toast({ type: 'warn', title: 'Push the branch first', message: `${branch} needs to be on ${remote} before GitHub can open a pull request for it.` });
        return null;
      }
    }
    app.beginBusy('Opening pull request');
    try {
      const r = await invoke('gh:createPull', { root: app.repo, base: { owner: s.base.owner, name: s.base.name }, head: branch, baseBranch: v.base, title: v.title.trim(), body: v.body, draft: v.draft });
      toast({ type: 'success', title: `Opened pull request #${r.number}`, message: v.title.trim(), actions: [{ label: 'Open on GitHub', primary: true, run: () => invoke('shell:openExternal', r.url) }], timeout: 9000 });
      app.donkey.react('pullRequest', { number: r.number });
      await this.load(app.tab, { force: true });
      return r;
    } catch (e) {
      toast({ type: 'error', title: 'Couldn’t open the pull request', message: e.message });
      return null;
    } finally {
      app.endBusy();
    }
  }

  /** After a push: offer a pull request when the branch has none. */
  afterPushActions(branch) {
    const s = this.state();
    if (s.status !== 'ready' || !s.base || branch === s.base.defaultBranch || this.forBranch(branch)) return [];
    return [{ label: 'Open pull request…', run: () => this.create(branch) }];
  }
}

