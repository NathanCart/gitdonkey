// GitDonkey renderer controller: state, refresh, actions, menus, tabs.
import { git, invoke, on, pathForFile, isMac, kb, revealLabel } from './api.js';
import { h, icon, clear, led, logoMark } from './dom.js';
import { toast, confirmDialog, choiceDialog, promptDialog, formDialog, contextMenu, menuFromButton, closeMenus, hasOpenModal } from './ui.js';
import { computeGraph } from './lib/graph-layout.js';
import { shortHash, debounce, pluralize, splitPath } from './lib/util.js';
import { GraphView } from './graph-view.js';
import { Sidebar } from './sidebar.js';
import { Panel } from './panel.js';
import { DetailView } from './detail-view.js';
import { PatchBay } from './patch.js';
import { renderToolbar } from './toolbar.js';
import { renderWelcome } from './welcome.js';
import * as dialogs from './dialogs.js';
import { setAvatarsEnabled, onAvatarChange } from './avatars.js';
import { Updates } from './updates.js';

const PAGE = 1500;
const DEFAULT_SETTINGS = {
  pullMode: 'merge', autoFetch: 0, diffMode: 'unified', diffContext: 'hunks', ignoreWhitespace: false, fileView: 'path', confirmDiscard: true, avatars: true, checkUpdates: true,
};
const DEFAULT_LAYOUT = { sidebar: 248, panel: 392, refs: 176, graphMax: 340, sidebarHidden: false, panelHidden: false };

let tabSeq = 0;
function makeTab(root, name) {
  return {
    id: ++tabSeq,
    root,
    name: name || 'New tab',
    data: null,
    error: null,
    ui: { selection: { type: 'wip' }, draft: {}, undo: [], redo: [], collapsed: null, fileSel: null, detail: null, scrollTop: 0, prefilled: null },
  };
}

const basename = (p) => p.replace(/\/+$/, '').split('/').pop();
const firstLine = (s) => String(s || '').split('\n')[0];

function refsSignature(refs) {
  return JSON.stringify([
    refs.head,
    refs.local.map((b) => [b.name, b.hash]),
    refs.remote.map((b) => [b.shortName, b.hash]),
    refs.tags.map((t) => [t.name, t.hash]),
  ]);
}

function buildRefsByHash(refs) {
  const map = new Map();
  const add = (hash, ref) => {
    if (!hash) return;
    if (!map.has(hash)) map.set(hash, []);
    map.get(hash).push(ref);
  };
  const localByHash = new Map();
  for (const b of refs.local) {
    const ref = { type: 'local', name: b.name, isHead: b.isHead, branch: b, remotes: [] };
    localByHash.set(`${b.hash}:${b.name}`, ref);
    add(b.hash, ref);
  }
  for (const r of refs.remote) {
    const twin = refs.local.find((b) => b.hash === r.hash && (b.upstream === r.shortName || b.name === r.name));
    if (twin) localByHash.get(`${twin.hash}:${twin.name}`).remotes.push(r.shortName);
    else add(r.hash, { type: 'remote', name: r.shortName, remote: r.remote, branchName: r.name, remoteRef: r });
  }
  for (const t of refs.tags) add(t.hash, { type: 'tag', name: t.name, tag: t });
  if (refs.head.detached && refs.head.hash) add(refs.head.hash, { type: 'head', name: 'HEAD', isHead: true });
  const order = { head: 0, local: 1, remote: 2, tag: 3 };
  for (const list of map.values()) list.sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0) || order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  return map;
}

class App {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.layout = { ...DEFAULT_LAYOUT };
    this.tabs = [];
    this.activeId = null;
    this.details = null;
    this.detailsToken = 0;
    this.busy = [];
    this.progress = null;
    this.loadingMore = false;
    this.refreshing = null;
    this.refreshQueued = false;
    this.search = null;
    this.rows = [];
    this.layoutData = { rows: [], width: 1, tail: [] };
    this.indexByHash = new Map();
    this.refsByHash = new Map();
    this.lastError = null;
    this.patch = new PatchBay(this);
    this.updates = new Updates(this);
  }

  get tab() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  get repo() {
    return this.tab ? this.tab.root : null;
  }

  get data() {
    return this.tab ? this.tab.data : null;
  }

  get headHash() {
    return this.data ? this.data.refs.head.hash : null;
  }

  get currentBranch() {
    return this.data && !this.data.refs.head.detached ? this.data.refs.head.branch : null;
  }

  // ------------------------------------------------------------ boot

  async init() {
    this.info = await invoke('app:info');
    document.body.classList.toggle('mac', this.info.platform === 'darwin');
    Object.assign(this.settings, (await invoke('store:get', 'settings')) || {});
    Object.assign(this.layout, (await invoke('store:get', 'layout')) || {});
    setAvatarsEnabled(this.settings.avatars !== false);
    onAvatarChange(() => this.graph && this.graph.draw());
    this.aiProviders = await invoke('ai:providers').catch(() => []);
    const $ = (s) => document.querySelector(s);
    this.els = {
      tabs: $('#tabs'), toolbar: $('#toolbar'), welcome: $('#welcome'), repoView: $('#repo'), sidebar: $('#sidebar'),
      center: $('#center'), graph: $('#graph'), detail: $('#detail'), panel: $('#panel'), status: $('#status'), repoError: $('#repo-error'),
    };
    this.graph = new GraphView(this.els.graph, this);
    this.sidebar = new Sidebar(this.els.sidebar, this);
    this.panel = new Panel(this.els.panel, this);
    this.detail = new DetailView(this.els.detail, this);
    this.applyLayout();
    this.bindSplitters();
    this.bindGlobal();
    $('#tab-add').addEventListener('click', () => this.newTab());
    $('#tab-add').title = `New tab (${kb('⌘T')})`;

    const saved = (await invoke('store:get', 'tabs')) || [];
    const activeIndex = (await invoke('store:get', 'activeTab')) || 0;
    const opened = await Promise.all(saved.map(async (root) => {
      if (!root) return makeTab(null);
      try {
        const res = await invoke('repo:open', root);
        return makeTab(res.root, res.name);
      } catch {
        return null;
      }
    }));
    this.tabs = opened.filter(Boolean);
    let target = this.tabs[Math.min(activeIndex, this.tabs.length - 1)];
    for (const p of this.info.launchPaths || []) {
      try {
        const res = await invoke('repo:open', p);
        let t = this.tabs.find((x) => x.root === res.root);
        if (!t) {
          t = makeTab(res.root, res.name);
          this.tabs.push(t);
        }
        target = t;
      } catch (e) {
        toast({ type: 'error', title: 'Could not open folder', message: e.message });
      }
    }
    if (!this.tabs.length) this.tabs.push(makeTab(null));
    this.syncWatch();
    await this.activate((target || this.tabs[0]).id);
    this.applyAutoFetch();
    await this.updates.init();
    document.body.classList.add('ready');
  }

  // ------------------------------------------------------------ persistence

  persistTabs() {
    invoke('store:set', 'tabs', this.tabs.map((t) => t.root));
    invoke('store:set', 'activeTab', Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)));
  }

  saveLayout() {
    invoke('store:set', 'layout', this.layout);
  }

  setSetting(key, value, { silent = false } = {}) {
    this.settings[key] = value;
    invoke('store:set', 'settings', this.settings);
    if (silent) return;
    if (key === 'fileView') this.panel.render();
    if (key === 'avatars') {
      setAvatarsEnabled(value);
      if (this.data) this.renderAll({ skipDetail: true });
    }
    if (['diffMode', 'diffContext', 'ignoreWhitespace'].includes(key) && this.detail.isOpen()) {
      this.detail.renderHead();
      this.detail.load();
    }
  }

  syncWatch() {
    invoke('watch:set', this.tabs.map((t) => t.root).filter(Boolean));
  }

  // ------------------------------------------------------------ layout

  applyLayout() {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-w', `${this.layout.sidebarHidden ? 0 : this.layout.sidebar}px`);
    root.style.setProperty('--panel-w', `${this.layout.panelHidden ? 0 : this.layout.panel}px`);
    document.body.classList.toggle('no-sidebar', Boolean(this.layout.sidebarHidden));
    document.body.classList.toggle('no-panel', Boolean(this.layout.panelHidden));
    if (this.graph) this.graph.update(true);
  }

  bindSplitters() {
    for (const sp of document.querySelectorAll('.splitter')) {
      sp.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const which = sp.dataset.split;
        const startX = e.clientX;
        const start = this.layout[which];
        const move = (ev) => {
          const dx = ev.clientX - startX;
          const w = which === 'sidebar' ? Math.max(180, Math.min(440, start + dx)) : Math.max(300, Math.min(640, start - dx));
          this.layout[which] = w;
          this.applyLayout();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
          this.saveLayout();
        };
        document.body.classList.add('resizing');
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      sp.addEventListener('dblclick', () => {
        this.layout[sp.dataset.split] = DEFAULT_LAYOUT[sp.dataset.split];
        this.applyLayout();
        this.saveLayout();
      });
    }
  }

  // ------------------------------------------------------------ tabs

  renderTabs() {
    const el = this.els.tabs;
    clear(el);
    for (const t of this.tabs) {
      const active = t.id === this.activeId;
      el.appendChild(h('div', {
        class: ['tab', active && 'on', t.error && 'broken'],
        role: 'tab',
        'aria-selected': String(active),
        title: t.root || 'New tab',
        onMousedown: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this.closeTab(t.id);
          }
        },
        onClick: (e) => {
          if (!e.target.closest('.tab-x')) this.activate(t.id);
        },
      },
      t.root ? icon('folder-git-2', { size: 14 }) : logoMark(14, { mono: true }),
      h('span', { class: 'tab-name' }, t.name),
      h('button', { class: 'tab-x', title: `Close tab (${kb('⌘W')})`, 'aria-label': `Close ${t.name}`, onClick: () => this.closeTab(t.id) }, icon('x', { size: 12, stroke: 2 }))));
    }
  }

  newTab() {
    const t = makeTab(null);
    this.tabs.push(t);
    this.persistTabs();
    this.activate(t.id);
  }

  async closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [t] = this.tabs.splice(i, 1);
    if (t.root && !this.tabs.some((x) => x.root === t.root)) invoke('repo:close', t.root);
    if (!this.tabs.length) this.tabs.push(makeTab(null));
    this.syncWatch();
    if (id === this.activeId) await this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else {
      this.renderTabs();
      this.persistTabs();
    }
  }

  cycleTab(delta) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(i + delta + this.tabs.length) % this.tabs.length];
    if (next) this.activate(next.id);
  }

  async activate(id) {
    const prev = this.tab;
    if (prev && prev.root && this.graph) prev.ui.scrollTop = this.graph.scroller.scrollTop;
    this.activeId = id;
    this.persistTabs();
    this.closeSearch();
    closeMenus();
    this.details = null;
    this.renderTabs();
    const tab = this.tab;
    if (!tab.root) {
      document.body.classList.add('show-welcome');
      this.detail.close();
      renderToolbar(this.els.toolbar, this);
      this.renderStatus();
      invoke('window:setTitle', 'GitDonkey');
      await renderWelcome(this.els.welcome, this);
      return;
    }
    document.body.classList.remove('show-welcome');
    invoke('window:setTitle', `${tab.name} — GitDonkey`);
    this.panel.loadDraft();
    this.detail.close();
    if (tab.data) {
      this.afterData({ restoreScroll: true });
    } else {
      renderToolbar(this.els.toolbar, this);
      this.graph.setData({ rows: [], layout: { rows: [], width: 1, tail: [] }, refsByHash: new Map(), selectedIndex: -1, emptyText: 'Reading repository…' });
    }
    await this.refresh();
    if (this.tab === tab) {
      if (tab.ui.detail) this.detail.open(tab.ui.detail);
      const sel = tab.ui.selection;
      if (sel.type === 'commit') this.loadDetails(sel.hash);
      else if (sel.type === 'stash') this.loadDetails(sel.stash.hash, { stash: true });
    }
  }

  // ------------------------------------------------------------ repository open

  async openDialog() {
    const dir = await invoke('dialog:pickFolder', { title: 'Open a Git repository', buttonLabel: 'Open' });
    if (dir) await this.openRepo(dir);
  }

  async openRepo(dir) {
    let res;
    try {
      res = await invoke('repo:open', dir);
    } catch (e) {
      const notRepo = /not a Git repository/i.test(e.message);
      toast({
        type: 'error',
        title: notRepo ? 'Not a Git repository' : 'Could not open folder',
        message: e.message,
        actions: notRepo ? [{ label: 'Initialize it', run: () => this.initHere(dir) }] : [],
      });
      return false;
    }
    const existing = this.tabs.find((t) => t.root === res.root);
    if (existing) {
      await this.activate(existing.id);
      return true;
    }
    // An empty welcome tab is always reused; otherwise a repo opens in a new tab.
    let tab = this.tab;
    if (!tab || tab.root) {
      tab = makeTab(res.root, res.name);
      this.tabs.push(tab);
    } else {
      tab.root = res.root;
      tab.name = res.name;
    }
    this.syncWatch();
    await this.activate(tab.id);
    return true;
  }

  async initHere(dir) {
    const ok = await confirmDialog({ title: 'Initialize repository', message: `Run git init in ${dir}?`, okLabel: 'Initialize' });
    if (!ok) return;
    try {
      const res = await invoke('repo:init', { dir, readme: false });
      await this.openRepo(res.root);
    } catch (e) {
      toast({ type: 'error', title: 'Could not initialize', message: e.message });
    }
  }

  // ------------------------------------------------------------ refresh

  refresh() {
    const tab = this.tab;
    if (!tab || !tab.root) return Promise.resolve();
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh(tab).finally(() => {
      this.refreshing = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    });
    return this.refreshing;
  }

  async doRefresh(tab) {
    const root = tab.root;
    try {
      const [status, refs, stashes, remotes, opState] = await Promise.all([
        git(root, 'status'), git(root, 'refs'), git(root, 'stashes'), git(root, 'remotes'), git(root, 'opState'),
      ]);
      const sig = refsSignature(refs);
      let commits = tab.data ? tab.data.commits : null;
      let hasMore = tab.data ? tab.data.hasMore : false;
      if (!tab.data || tab.data.sig !== sig || !commits) {
        const want = Math.max(PAGE, tab.data ? tab.data.commits.length : 0);
        commits = await git(root, 'log', { max: want });
        hasMore = commits.length >= want;
      }
      tab.data = { sig, status, refs, stashes, remotes, opState, commits, hasMore };
      tab.error = null;
    } catch (e) {
      tab.error = e.message;
      if (tab === this.tab) this.showRepoError(tab);
      return;
    }
    if (tab !== this.tab) return;
    this.afterData();
  }

  showRepoError(tab) {
    this.renderTabs();
    const host = this.els.graph;
    this.graph.setData({ rows: [], layout: { rows: [], width: 1, tail: [] }, refsByHash: new Map(), selectedIndex: -1, emptyText: 'This repository could not be read' });
    toast({
      type: 'error',
      title: `Cannot read ${tab.name}`,
      message: tab.error,
      actions: [{ label: 'Close tab', run: () => this.closeTab(tab.id) }, { label: 'Retry', run: () => this.refresh() }],
    });
    void host;
  }

  afterData({ restoreScroll = false } = {}) {
    const tab = this.tab;
    const d = tab.data;
    this.buildGraph();
    // Selection sanity.
    const sel = tab.ui.selection;
    if (sel.type === 'stash' && !d.stashes.some((s) => s.hash === sel.stash.hash)) tab.ui.selection = { type: 'wip' };
    // Pre-fill the commit message for merges / cherry-picks in progress.
    if (d.opState && d.opState.message && ['merge', 'cherry-pick', 'revert'].includes(d.opState.type)) {
      const key = `${d.opState.type}:${(d.opState.heads || [d.opState.hash]).join(',')}`;
      if (tab.ui.prefilled !== key) {
        tab.ui.prefilled = key;
        this.panel.setMessage(d.opState.message.replace(/^#.*$/gm, '').trim(), { amend: false });
        tab.ui.selection = { type: 'wip' };
      }
    } else if (!d.opState) tab.ui.prefilled = null;
    const reopened = this.validateDetail();
    this.renderAll({ skipDetail: reopened });
    if (restoreScroll) this.graph.scroller.scrollTop = tab.ui.scrollTop || 0;
    if (this.search && this.search.query) this.runSearch(this.search.query, { keepIndex: true });
  }

  buildGraph() {
    const d = this.data;
    const st = d.status;
    const dirty = st.staged.length + st.unstaged.length + st.conflicted.length > 0;
    const rows = dirty || d.opState ? [{ hash: 'WIP', wip: true, parents: d.refs.head.hash ? [d.refs.head.hash] : [], subject: '' }, ...d.commits] : d.commits;
    this.rows = rows;
    this.layoutData = computeGraph(rows);
    this.indexByHash = new Map(rows.map((c, i) => [c.hash, i]));
    this.refsByHash = buildRefsByHash(d.refs);
  }

  laneColorFor(hash) {
    if (!hash) return null;
    const i = this.indexByHash.get(hash);
    return i === undefined ? null : this.layoutData.rows[i].color;
  }

  selectedIndex() {
    const sel = this.tab.ui.selection;
    if (sel.type === 'wip') return this.rows[0] && this.rows[0].wip ? 0 : -1;
    if (sel.type === 'commit') return this.indexByHash.get(sel.hash) ?? -1;
    return -1;
  }

  renderAll({ skipDetail = false } = {}) {
    const d = this.data;
    renderToolbar(this.els.toolbar, this);
    this.sidebar.render();
    const st = d.status;
    const opLabels = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', am: 'Applying patches' };
    this.graph.setData({
      rows: this.rows,
      layout: this.layoutData,
      refsByHash: this.refsByHash,
      selectedIndex: this.selectedIndex(),
      wip: { staged: st.staged.length, unstaged: st.unstaged.length, conflicted: st.conflicted.length, opLabel: d.opState ? `${opLabels[d.opState.type] || d.opState.type}…` : null },
      emptyText: d.refs.head.unborn ? 'No commits yet' : 'No commits',
    });
    this.panel.render();
    this.renderStatus();
    if (!skipDetail) this.detail.refresh();
  }

  /** Keep the open diff pointed at the right list after staging changes. Returns true when it reopened. */
  validateDetail() {
    const tab = this.tab;
    const spec = tab.ui.detail;
    if (!spec || spec.kind === 'commit') return false;
    const st = this.data.status;
    const inU = st.unstaged.find((f) => f.path === spec.path);
    const inS = st.staged.find((f) => f.path === spec.path);
    const inC = st.conflicted.find((f) => f.path === spec.path);
    let next = spec;
    if (spec.kind === 'unstaged' || spec.kind === 'untracked') {
      if (inC) next = { kind: 'conflict', path: spec.path, status: 'U', conflict: inC.conflict };
      else if (inU) next = { ...spec, kind: inU.untracked ? 'untracked' : 'unstaged', status: inU.status, untracked: Boolean(inU.untracked) };
      else if (inS) next = { ...spec, kind: 'staged', status: inS.status, oldPath: inS.oldPath, untracked: false };
      else next = null;
    } else if (spec.kind === 'staged') {
      if (inS) next = { ...spec, status: inS.status, oldPath: inS.oldPath };
      else if (inU) next = { ...spec, kind: inU.untracked ? 'untracked' : 'unstaged', status: inU.status, oldPath: null, untracked: Boolean(inU.untracked) };
      else next = null;
    } else if (spec.kind === 'conflict') {
      if (!inC) {
        const other = st.conflicted[0];
        next = other ? { kind: 'conflict', path: other.path, status: 'U', conflict: other.conflict } : null;
      }
    }
    if (!next) {
      tab.ui.detail = null;
      this.detail.close();
      return true;
    }
    if (next.kind !== spec.kind || next.path !== spec.path || next.status !== spec.status) {
      tab.ui.detail = next;
      if (this.detail.isOpen()) this.detail.open(next, { mode: this.detail.mode === 'merge' ? 'diff' : this.detail.mode });
      return true;
    }
    return false;
  }

  async loadMore() {
    const tab = this.tab;
    if (!tab || !tab.data || !tab.data.hasMore || this.loadingMore) return;
    this.loadingMore = true;
    try {
      const more = await git(tab.root, 'log', { skip: tab.data.commits.length, max: PAGE });
      if (tab !== this.tab) return;
      const seen = new Set(tab.data.commits.map((c) => c.hash));
      tab.data.commits = tab.data.commits.concat(more.filter((c) => !seen.has(c.hash)));
      tab.data.hasMore = more.length >= PAGE;
      this.buildGraph();
      this.renderAll({ skipDetail: true });
    } catch (e) {
      toast({ type: 'error', title: 'Could not load more commits', message: e.message });
    } finally {
      this.loadingMore = false;
    }
  }

  async loadAllCommits() {
    const tab = this.tab;
    if (!tab.data.hasMore) return;
    this.beginBusy('Loading full history');
    try {
      tab.data.commits = await git(tab.root, 'log', { max: 1000000 });
      tab.data.hasMore = false;
      this.buildGraph();
      this.renderAll({ skipDetail: true });
    } finally {
      this.endBusy();
    }
  }

  // ------------------------------------------------------------ selection

  selectRow(i) {
    const row = this.rows[i];
    if (!row) return;
    if (row.wip) this.selectWip();
    else this.selectCommit(row.hash);
  }

  moveSelection(delta) {
    let i = this.selectedIndex();
    if (i === -1) i = delta > 0 ? -1 : this.rows.length;
    const next = Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.selectRow(next);
  }

  selectWip() {
    const tab = this.tab;
    const wasStash = tab.ui.selection.type === 'stash';
    tab.ui.selection = { type: 'wip' };
    tab.ui.fileSel = null;
    this.details = null;
    if (tab.ui.detail && tab.ui.detail.kind === 'commit') this.closeDetail();
    this.graph.setSelected(this.selectedIndex());
    this.panel.render();
    if (wasStash) this.sidebar.render();
  }

  async selectCommit(hash, { scroll = true, closeDetail = false } = {}) {
    const tab = this.tab;
    let idx = this.indexByHash.get(hash);
    if (idx === undefined && tab.data.hasMore) {
      // Load pages until the commit appears (bounded).
      for (let n = 0; n < 20 && idx === undefined && tab.data.hasMore; n++) {
        await this.loadMore();
        idx = this.indexByHash.get(hash);
      }
    }
    const wasStash = tab.ui.selection.type === 'stash';
    tab.ui.selection = { type: 'commit', hash };
    tab.ui.fileSel = null;
    const spec = tab.ui.detail;
    if (closeDetail || (spec && !(spec.kind === 'commit' && spec.hash === hash))) this.closeDetail({ focus: false });
    this.graph.setSelected(idx ?? -1, { scroll });
    if (scroll && idx !== undefined) this.graph.scrollToIndex(idx, { center: true });
    if (wasStash) this.sidebar.render();
    this.loadDetails(hash);
  }

  selectStash(stash) {
    const tab = this.tab;
    tab.ui.selection = { type: 'stash', stash };
    tab.ui.fileSel = null;
    this.closeDetail({ focus: false });
    this.graph.setSelected(-1, { scroll: false });
    this.sidebar.render();
    this.loadDetails(stash.hash, { stash: true });
  }

  isSelectedStash(s) {
    const sel = this.tab && this.tab.ui.selection;
    return sel && sel.type === 'stash' && sel.stash.hash === s.hash;
  }

  async loadDetails(hash, opts = {}) {
    if (this.details && this.details.hash === hash && this.details.data) {
      this.panel.render();
      return;
    }
    const token = ++this.detailsToken;
    this.details = { hash, loading: true };
    this.panel.render();
    try {
      const data = await git(this.repo, 'commitDetails', hash, opts);
      if (token !== this.detailsToken) return;
      this.details = { hash, data };
    } catch (e) {
      if (token !== this.detailsToken) return;
      this.details = { hash, error: e.message };
    }
    this.panel.render();
  }

  revealRef(ref) {
    if (ref.type === 'stash') return this.selectStash(ref.stash);
    if (ref.type === 'remote-root') return undefined;
    const hash = ref.type === 'local' ? ref.branch.hash : ref.type === 'remote' ? ref.remoteRef.hash : ref.type === 'tag' ? ref.tag.hash : this.headHash;
    return this.selectCommit(hash, { scroll: true });
  }

  // ------------------------------------------------------------ detail view

  openFile(spec) {
    const tab = this.tab;
    const full = spec.kind === 'commit' ? { ...spec, hash: spec.to } : spec;
    tab.ui.detail = full;
    this.detail.open(full);
    this.panel.syncRowState();
  }

  closeDetail({ focus = true } = {}) {
    const tab = this.tab;
    if (!tab) return;
    tab.ui.detail = null;
    this.detail.close();
    this.panel.render();
    if (focus) this.graph.scroller.focus({ preventScroll: true });
  }

  isDetailFile(kind, f) {
    const spec = this.tab && this.tab.ui.detail;
    if (!spec || spec.path !== f.path) return false;
    if (kind === 'unstaged') return spec.kind === 'unstaged' || spec.kind === 'untracked';
    if (kind === 'conflicted') return spec.kind === 'conflict';
    if (kind === 'commit') return spec.kind === 'commit' && spec.to === f.to;
    return spec.kind === kind;
  }

  // ------------------------------------------------------------ busy / status

  beginBusy(label) {
    this.busy.push(label);
    this.progress = null;
    this.renderStatus();
  }

  endBusy() {
    this.busy.pop();
    if (!this.busy.length) this.progress = null;
    this.renderStatus();
  }

  renderStatus() {
    const el = this.els.status;
    clear(el);
    const busy = this.busy[this.busy.length - 1];
    const d = this.data;
    const left = h('div', { class: 'st-left' },
      led(busy ? 'amber' : this.lastError ? 'red' : 'green'),
      h('span', { class: 'st-text' }, busy ? `${busy}${this.progress && this.progress.text ? ` · ${this.progress.text}` : '…'}` : this.lastError ? this.lastError : 'Ready'));
    const mid = h('div', { class: 'st-mid' });
    if (busy && this.progress && this.progress.percent !== null && this.progress.percent !== undefined) {
      mid.appendChild(h('span', { class: 'mp-track' }, h('span', { class: 'mp-fill', style: { width: `${this.progress.percent}%` } })));
    }
    const right = h('div', { class: 'st-right' }, this.updates.statusKey());
    if (d && this.tab && this.tab.root) {
      const b = d.refs.local.find((x) => x.isHead);
      if (b && b.upstream) right.appendChild(h('span', { class: 'st-up', title: b.ahead || b.behind ? 'Out of sync with upstream' : 'In sync with upstream' }, led(b.ahead || b.behind ? 'amber' : 'green'), `${b.name} → ${b.upstream}`, b.ahead ? h('span', { class: 'ab ahead' }, `↑${b.ahead}`) : null, b.behind ? h('span', { class: 'ab behind' }, `↓${b.behind}`) : null));
      right.appendChild(h('span', { class: 'st-count' }, `${d.commits.length.toLocaleString()}${d.hasMore ? '+' : ''} commits`));
    }
    el.append(left, mid, right);
  }

  // ------------------------------------------------------------ running operations

  async run(label, fn, { success, refresh = true, busy = true, autoStash = false } = {}) {
    if (busy) this.beginBusy(label);
    const repo = this.repo;
    try {
      let r;
      try {
        r = await fn();
      } catch (e) {
        if (!(autoStash && e.kind === 'DIRTY_WORKTREE')) throw e;
        if (busy) this.endBusy();
        const choice = await choiceDialog({
          title: label,
          message: 'Your uncommitted changes would be overwritten. Stash them first and continue? Pop the stash afterwards to get them back.',
          detail: e.message,
          choices: [{ id: 'stash', label: 'Stash & continue' }],
        });
        if (busy) this.beginBusy(label);
        if (choice !== 'stash') return null;
        await git(repo, 'stashSave', { message: `GitDonkey: before ${label}`, includeUntracked: true });
        r = await fn();
      }
      this.lastError = null;
      if (r && r.conflicts) {
        toast({ type: 'warn', title: `${label}: conflicts`, message: `${pluralize(r.files ? r.files.length : 1, 'file')} need${r.files && r.files.length === 1 ? 's' : ''} resolving. Open each one from the panel, then continue.` });
        this.tab.ui.selection = { type: 'wip' };
        this.details = null;
      } else if (success) {
        const msg = typeof success === 'function' ? success(r) : success;
        if (msg) toast({ type: 'success', title: msg });
      }
      return r === undefined || r === null ? true : r;
    } catch (e) {
      this.handleError(label, e);
      return null;
    } finally {
      if (busy) this.endBusy();
      if (refresh) await this.refresh();
    }
  }

  handleError(label, e) {
    this.lastError = `${label} failed`;
    const kind = e.kind;
    if (kind === 'NO_IDENTITY') {
      toast({ type: 'warn', title: 'Set your Git identity', message: 'Git needs your name and email before it can commit.' });
      dialogs.identityDialog(this, { required: true });
      return;
    }
    if (kind === 'AUTH') {
      const cancelled = /could not read (Username|Password)|terminal prompts disabled/i.test(e.message);
      toast({
        type: cancelled ? 'warn' : 'error',
        title: cancelled ? `${label}: sign-in cancelled` : `${label}: login rejected`,
        message: cancelled
          ? 'Try again and enter your username and token when GitDonkey asks.'
          : 'The server refused the username or token. GitDonkey will ask again on your next try; for GitHub use a personal access token, not your password.',
        detail: e.message,
      });
      return;
    }
    if (kind === 'DIRTY_WORKTREE') {
      toast({
        type: 'error',
        title: `${label}: uncommitted changes in the way`,
        message: e.message,
        actions: [{ label: 'Stash changes', run: () => this.stash() }],
      });
      return;
    }
    toast({ type: 'error', title: `${label} failed`, message: e.message });
  }

  pushUndo(entry) {
    const tab = this.tab;
    tab.ui.undo.push({ ...entry, repo: tab.root });
    if (tab.ui.undo.length > 50) tab.ui.undo.shift();
    tab.ui.redo = [];
    renderToolbar(this.els.toolbar, this);
  }

  async undo() {
    const tab = this.tab;
    const entry = tab && tab.ui.undo.pop();
    if (!entry) return;
    const ok = await this.run(`Undo ${entry.label}`, entry.undo, { success: `Undid: ${entry.label}` });
    if (ok) tab.ui.redo.push(entry);
    renderToolbar(this.els.toolbar, this);
  }

  async redo() {
    const tab = this.tab;
    const entry = tab && tab.ui.redo.pop();
    if (!entry) return;
    const ok = await this.run(`Redo ${entry.label}`, entry.redo, { success: `Redid: ${entry.label}` });
    if (ok) tab.ui.undo.push(entry);
    renderToolbar(this.els.toolbar, this);
  }

  headRef() {
    const head = this.data.refs.head;
    return head.detached ? { detached: true, ref: head.hash } : { detached: false, ref: head.branch };
  }

  restoreHeadFn(prev) {
    const repo = this.repo;
    return () => git(repo, prev.detached ? 'checkoutDetached' : 'checkout', prev.ref);
  }

  async copy(text, message = 'Copied') {
    await invoke('clipboard:write', text);
    toast({ type: 'info', title: message, message: text.length > 80 ? `${text.slice(0, 80)}…` : text, timeout: 2200 });
  }

  // ------------------------------------------------------------ working tree actions

  stage(files) {
    const paths = files.map((f) => f.path);
    if (!paths.length) return null;
    return this.run('Stage', () => git(this.repo, 'stage', paths), { busy: false });
  }

  unstage(files) {
    const paths = files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
    if (!paths.length) return null;
    return this.run('Unstage', () => git(this.repo, 'unstage', paths), { busy: false });
  }

  stageAll() {
    if (!this.data || !this.data.status.unstaged.length) return null;
    return this.run('Stage all', () => git(this.repo, 'stageAll'), { busy: false });
  }

  unstageAll() {
    if (!this.data || !this.data.status.staged.length) return null;
    return this.run('Unstage all', () => git(this.repo, 'unstageAll'), { busy: false });
  }

  async discard(files) {
    if (!files.length) return;
    if (this.settings.confirmDiscard !== false) {
      const ok = await confirmDialog({
        title: 'Discard changes',
        message: files.length === 1 ? `Discard your changes to ${files[0].path}? This cannot be undone.` : `Discard changes to ${files.length} files? This cannot be undone.`,
        okLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    await this.run('Discard changes', () => git(this.repo, 'discard', files.map((f) => ({ path: f.path, untracked: Boolean(f.untracked || f.status === '?') }))));
  }

  async discardStaged(files) {
    const ok = await confirmDialog({
      title: 'Discard changes',
      message: `Throw away all staged and unstaged changes to ${files.length === 1 ? files[0].path : `${files.length} files`}? This cannot be undone.`,
      okLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    await this.run('Discard changes', () => git(this.repo, 'discardFull', files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }))));
  }

  async discardAll() {
    const st = this.data && this.data.status;
    if (!st) return;
    const n = st.staged.length + st.unstaged.length + st.conflicted.length;
    if (!n) return;
    const ok = await confirmDialog({
      title: 'Discard all changes',
      message: `Reset the working tree and index to ${this.currentBranch || 'HEAD'} and delete untracked files? ${pluralize(n, 'change')} will be lost. This cannot be undone.`,
      okLabel: 'Discard everything',
      danger: true,
    });
    if (!ok) return;
    await this.run('Discard all changes', () => git(this.repo, 'discardAll'));
  }

  async ignore(pattern) {
    await this.run(`Ignore ${pattern}`, () => git(this.repo, 'ignore', pattern), { success: `Added ${pattern} to .gitignore` });
  }

  async toggleAmend(checked) {
    const tab = this.tab;
    if (checked) {
      if (!this.panel.summary.value.trim()) {
        const msg = await git(this.repo, 'lastCommitMessage').catch(() => '');
        tab.ui.amendFilled = msg;
        this.panel.setMessage(msg, { amend: true });
      } else this.panel.saveDraft();
    } else {
      if (tab.ui.amendFilled && this.panel.message() === tab.ui.amendFilled.trim()) this.panel.setMessage('', { amend: false });
      tab.ui.amendFilled = null;
      this.panel.saveDraft();
    }
    this.panel.updateCommitButton();
  }

  /** The chosen AI provider and model, or null when AI commit messages are off. */
  aiConfig() {
    const ai = this.settings.ai;
    const p = ai && ai.provider && (this.aiProviders || []).find((x) => x.id === ai.provider);
    if (!p) return null;
    const model = ((ai.models || {})[p.id] || p.model || '').trim();
    return { provider: p.id, model, baseUrl: (ai.baseUrls || {})[p.id] || '', instructions: ai.instructions || '', label: model ? `${p.name} · ${model}` : p.name };
  }

  /** Write the commit message from the staged changes with the user's own AI provider. */
  async generateMessage() {
    const ai = this.aiConfig();
    if (!ai) return dialogs.aiSettingsDialog(this, { thenGenerate: true });
    const panel = this.panel;
    const tab = this.tab;
    if (!tab || panel.generating) return;
    const before = panel.message();
    const amend = panel.amendBox.checked;
    panel.setGenerating(true);
    try {
      const r = await invoke('ai:generate', { repo: tab.root, provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, instructions: ai.instructions, amend });
      const message = r.description ? `${r.summary}\n\n${r.description}` : r.summary;
      // The user may have switched tabs while it was writing.
      if (this.tab === tab) panel.setMessage(message);
      else tab.ui.draft = { ...(tab.ui.draft || {}), summary: r.summary, description: r.description };
      toast({
        type: 'success',
        title: 'Message written',
        message: `By ${r.model || ai.label}. Read it before you commit.`,
        actions: before.trim() && this.tab === tab ? [{ label: 'Undo', run: () => panel.setMessage(before) }] : [],
        timeout: 6000,
      });
    } catch (e) {
      toast({ type: 'error', title: 'Couldn’t write a message', message: e.message, actions: [{ label: 'AI settings…', run: () => dialogs.aiSettingsDialog(this) }] });
    } finally {
      panel.setGenerating(false);
    }
  }

  async commitFromPanel(message, amend) {
    const d = this.data;
    const op = d.opState;
    if (op && op.type === 'rebase') return this.continueOp(message);
    if (op && (op.type === 'cherry-pick' || op.type === 'revert')) return this.continueOp(message);
    const repo = this.repo;
    const prev = this.headHash;
    const branch = this.currentBranch;
    const r = await this.run(amend ? 'Amend commit' : 'Commit', async () => {
      if (op && op.type === 'merge') {
        await git(repo, 'continueOperation', 'merge', { message });
        return git(repo, 'revParse', 'HEAD');
      }
      return git(repo, 'commit', { message, amend });
    });
    if (!r) return;
    this.tab.ui.amendFilled = null;
    this.panel.setMessage('', { amend: false });
    const newHash = typeof r === 'string' ? r : await git(repo, 'revParse', 'HEAD').catch(() => null);
    if (prev && newHash && !op) {
      this.pushUndo({
        label: `${amend ? 'amend' : 'commit'} “${firstLine(message).slice(0, 40)}”`,
        undo: () => git(repo, 'reset', prev, 'soft'),
        redo: () => git(repo, 'reset', newHash, 'soft'),
      });
    }
    toast({ type: 'success', title: amend ? 'Commit amended' : 'Committed', message: `${shortHash(newHash || '')} on ${branch || 'detached HEAD'}`, timeout: 2600 });
  }

  // ------------------------------------------------------------ branches

  refName(ref) {
    return ref.type === 'local' ? ref.name : ref.type === 'remote' ? ref.name : ref.type === 'tag' ? `refs/tags/${ref.name}` : 'HEAD';
  }

  async checkoutRef(ref) {
    if (!ref) return null;
    if (ref.type === 'local') return ref.isHead ? null : this.checkoutBranch(ref.name);
    if (ref.type === 'remote') {
      const local = this.data.refs.local.find((b) => b.name === ref.branchName);
      if (local) {
        if (local.isHead) return null;
        return this.checkoutBranch(local.name);
      }
      const prev = this.headRef();
      const r = await this.run(`Check out ${ref.name}`, () => git(this.repo, 'checkoutRemote', ref.name, ref.branchName), { autoStash: true });
      if (r) {
        const repo = this.repo;
        this.pushUndo({ label: `check out ${ref.branchName}`, undo: async () => {
          await this.restoreHeadFn(prev)();
          await git(repo, 'deleteBranch', ref.branchName, { force: true });
        }, redo: () => git(repo, 'checkoutRemote', ref.name, ref.branchName) });
      }
      return r;
    }
    if (ref.type === 'tag') return this.checkoutDetached(ref.tag.hash, ref.name);
    return null;
  }

  async checkoutBranch(name) {
    const prev = this.headRef();
    const repo = this.repo;
    const r = await this.run(`Check out ${name}`, () => git(repo, 'checkout', name), { autoStash: true });
    if (r) this.pushUndo({ label: `check out ${name}`, undo: this.restoreHeadFn(prev), redo: () => git(repo, 'checkout', name) });
    return r;
  }

  async checkoutDetached(hash, label) {
    const prev = this.headRef();
    const repo = this.repo;
    const r = await this.run(`Check out ${label || shortHash(hash)}`, () => git(repo, 'checkoutDetached', hash), { autoStash: true });
    if (r) {
      this.pushUndo({ label: `check out ${label || shortHash(hash)}`, undo: this.restoreHeadFn(prev), redo: () => git(repo, 'checkoutDetached', hash) });
      toast({ type: 'info', title: 'Detached HEAD', message: 'You are not on a branch. Create a branch here to keep new commits.', actions: [{ label: 'Create branch', run: () => this.createBranch(hash) }] });
    }
    return r;
  }

  async createBranch(at, atLabel) {
    const d = this.data;
    if (!d || d.refs.head.unborn) {
      toast({ type: 'info', title: 'Make the first commit', message: 'Branches need at least one commit to start from.' });
      return;
    }
    const target = at || d.refs.head.hash;
    const label = atLabel || (at ? shortHash(at) : d.refs.head.branch || shortHash(d.refs.head.hash));
    const v = await dialogs.branchDialog(this, { at: target, atLabel: label });
    if (!v) return;
    const repo = this.repo;
    const prev = this.headRef();
    const r = await this.run(`Create branch ${v.name}`, () => git(repo, 'createBranch', v.name, target, { checkout: v.checkout }), { autoStash: v.checkout });
    if (r) {
      this.pushUndo({
        label: `create branch ${v.name}`,
        undo: async () => {
          if (v.checkout) await this.restoreHeadFn(prev)();
          await git(repo, 'deleteBranch', v.name, { force: true });
        },
        redo: () => git(repo, 'createBranch', v.name, target, { checkout: v.checkout }),
      });
    }
  }

  async deleteBranch(name) {
    const b = this.data.refs.local.find((x) => x.name === name);
    if (!b) return;
    if (b.isHead) {
      toast({ type: 'info', title: `${name} is checked out`, message: 'Check out another branch before deleting this one.' });
      return;
    }
    const repo = this.repo;
    const merged = this.headHash ? await git(repo, 'isAncestor', b.hash, 'HEAD').catch(() => false) : false;
    if (!merged) {
      const ok = await confirmDialog({
        title: `Delete ${name}?`,
        message: `${name} has commits that are not in ${this.currentBranch || 'HEAD'}. Delete it anyway? You can undo this.`,
        okLabel: 'Delete branch',
        danger: true,
      });
      if (!ok) return;
    }
    const r = await this.run(`Delete ${name}`, () => git(repo, 'deleteBranch', name, { force: true }));
    if (r) {
      this.pushUndo({
        label: `delete ${name}`,
        undo: async () => {
          await git(repo, 'createBranch', name, b.hash);
          if (b.upstream) await git(repo, 'setUpstream', name, b.upstream).catch(() => {});
        },
        redo: () => git(repo, 'deleteBranch', name, { force: true }),
      });
    }
  }

  async renameBranch(name) {
    const repo = this.repo;
    const next = await promptDialog({
      title: `Rename ${name}`,
      label: 'New name',
      value: name,
      okLabel: 'Rename',
      mono: true,
      validate: async (v) => {
        if (!v) return 'Enter a name.';
        if (v === name) return 'Choose a different name.';
        if (this.data.refs.local.some((b) => b.name === v)) return `${v} already exists.`;
        return (await git(repo, 'validateBranchName', v).catch(() => false)) ? null : `“${v}” is not a valid branch name.`;
      },
    });
    if (!next) return;
    const r = await this.run(`Rename ${name}`, () => git(repo, 'renameBranch', name, next));
    if (r) this.pushUndo({ label: `rename ${name}`, undo: () => git(repo, 'renameBranch', next, name), redo: () => git(repo, 'renameBranch', name, next) });
  }

  async setUpstreamFor(name) {
    const remoteBranches = this.data.refs.remote.map((r) => r.shortName);
    if (!remoteBranches.length) {
      toast({ type: 'info', title: 'No remote branches', message: 'Push the branch to create one on a remote.' });
      return;
    }
    const b = this.data.refs.local.find((x) => x.name === name);
    const v = await formDialog({
      title: `Upstream for ${name}`,
      okLabel: 'Set upstream',
      fields: [{ name: 'up', label: 'Track remote branch', type: 'select', value: b.upstream || remoteBranches.find((r) => r.endsWith(`/${name}`)) || remoteBranches[0], options: [{ value: '', label: 'None' }, ...remoteBranches.map((r) => ({ value: r, label: r }))] }],
    });
    if (!v) return;
    await this.run('Set upstream', () => git(this.repo, 'setUpstream', name, v.up || null), { success: v.up ? `${name} now tracks ${v.up}` : `${name} no longer tracks a remote branch` });
  }

  merge(ref) {
    const cur = this.currentBranch || 'HEAD';
    return this.run(`Merge ${ref.name} into ${cur}`, () => git(this.repo, 'merge', this.refName(ref)), {
      success: (r) => (/Already up to date/i.test(r.output || '') ? 'Already up to date' : `Merged ${ref.name} into ${cur}`),
    });
  }

  rebase(ref) {
    const cur = this.currentBranch || 'HEAD';
    return this.run(`Rebase ${cur} onto ${ref.name}`, () => git(this.repo, 'rebase', this.refName(ref)), {
      success: (r) => (/up to date/i.test(r.output || '') ? `${cur} is already up to date` : `Rebased ${cur} onto ${ref.name}`),
    });
  }

  fastForward(branch, targetRef) {
    return this.run(`Fast-forward ${branch}`, () => git(this.repo, 'fastForwardBranch', branch, targetRef), { success: `Fast-forwarded ${branch}` });
  }

  async checkoutThen(name, then) {
    const r = await this.checkoutBranch(name);
    if (r) await then();
  }

  async interactiveRebase(hash) {
    const repo = this.repo;
    if (this.data.opState) {
      toast({ type: 'warn', title: 'Finish the current operation first' });
      return;
    }
    const ancestor = await git(repo, 'isAncestor', hash, 'HEAD').catch(() => false);
    if (!ancestor || hash === this.headHash) {
      toast({ type: 'info', title: 'Pick an older commit on this branch', message: 'Interactive rebase rewrites the commits after the one you choose, up to HEAD.' });
      return;
    }
    const steps = await dialogs.interactiveRebaseDialog(this, { base: hash, baseLabel: shortHash(hash) });
    if (!steps) return;
    const prev = this.headHash;
    const r = await this.run('Interactive rebase', () => git(repo, 'rebaseInteractive', hash, steps), { success: (x) => (x && x.conflicts ? null : 'Rebase complete') });
    if (r && !r.conflicts) this.pushUndo({ label: 'interactive rebase', undo: () => git(repo, 'reset', prev, 'hard'), redo: () => git(repo, 'rebaseInteractive', hash, steps) });
  }

  async editHeadMessage() {
    const repo = this.repo;
    const current = await git(repo, 'lastCommitMessage');
    const v = await formDialog({
      title: 'Edit commit message',
      okLabel: 'Save message',
      width: 560,
      fields: [{ name: 'message', label: 'Message', type: 'textarea', rows: 6, value: current }],
      validate: (x) => (!x.message.trim() ? 'The message cannot be empty.' : null),
    });
    if (!v) return;
    const prev = this.headHash;
    const r = await this.run('Edit commit message', () => git(repo, 'commit', { message: v.message, amend: true, messageOnly: true }));
    if (r) {
      const next = typeof r === 'string' ? r : null;
      this.pushUndo({ label: 'edit commit message', undo: () => git(repo, 'reset', prev, 'soft'), redo: () => (next ? git(repo, 'reset', next, 'soft') : null) });
    }
  }

  async cherryPick(hash) {
    await this.run(`Cherry-pick ${shortHash(hash)}`, () => git(this.repo, 'cherryPick', hash), { success: `Cherry-picked ${shortHash(hash)} onto ${this.currentBranch || 'HEAD'}` });
  }

  async revert(hash) {
    await this.run(`Revert ${shortHash(hash)}`, () => git(this.repo, 'revert', hash), { success: `Reverted ${shortHash(hash)}` });
  }

  async reset(hash, mode) {
    const cur = this.currentBranch || 'HEAD';
    if (mode === 'hard') {
      const ok = await confirmDialog({
        title: `Hard reset ${cur}`,
        message: `Move ${cur} to ${shortHash(hash)} and throw away every uncommitted change? Commits after it stay recoverable with Undo; uncommitted work does not.`,
        okLabel: 'Hard reset',
        danger: true,
      });
      if (!ok) return;
    }
    const repo = this.repo;
    const prev = this.headHash;
    const r = await this.run(`Reset ${cur} (${mode})`, () => git(repo, 'reset', hash, mode), { success: `${cur} reset to ${shortHash(hash)}` });
    if (r) this.pushUndo({ label: `${mode} reset to ${shortHash(hash)}`, undo: () => git(repo, 'reset', prev, mode === 'hard' ? 'hard' : mode), redo: () => git(repo, 'reset', hash, mode) });
  }

  // ------------------------------------------------------------ tags

  async createTag(at) {
    if (!at) return;
    const v = await dialogs.tagDialog(this, { at });
    if (!v) return;
    const repo = this.repo;
    const name = v.name.trim();
    const r = await this.run(`Create tag ${name}`, () => git(repo, 'createTag', name, at, v.message || ''), { success: `Tagged ${shortHash(at)} as ${name}` });
    if (!r) return;
    this.pushUndo({ label: `create tag ${name}`, undo: () => git(repo, 'deleteTag', name), redo: () => git(repo, 'createTag', name, at, v.message || '') });
    if (v.push) await this.pushTag(name);
  }

  defaultRemote() {
    const rs = this.data.remotes;
    if (!rs.length) return null;
    const b = this.data.refs.local.find((x) => x.isHead);
    return (b && b.upstreamRemote) || (rs.some((r) => r.name === 'origin') ? 'origin' : rs[0].name);
  }

  async pushTag(name) {
    const remote = this.defaultRemote();
    if (!remote) return;
    await this.run(`Push tag ${name}`, () => git(this.repo, 'pushTag', remote, name), { success: `Pushed ${name} to ${remote}` });
  }

  async deleteTag(name) {
    const t = this.data.refs.tags.find((x) => x.name === name);
    const ok = await confirmDialog({ title: `Delete tag ${name}?`, message: 'The tag is deleted locally. Remote copies stay until you delete them there too.', okLabel: 'Delete tag', danger: true });
    if (!ok) return;
    const repo = this.repo;
    const r = await this.run(`Delete tag ${name}`, () => git(repo, 'deleteTag', name));
    if (r && t && !t.annotated) this.pushUndo({ label: `delete tag ${name}`, undo: () => git(repo, 'createTag', name, t.hash, ''), redo: () => git(repo, 'deleteTag', name) });
  }

  async deleteRemoteTag(name) {
    const remote = this.defaultRemote();
    if (!remote) return;
    const ok = await confirmDialog({ title: `Delete ${name} from ${remote}?`, message: 'Everyone who fetches will lose this tag from the remote.', okLabel: 'Delete from remote', danger: true });
    if (!ok) return;
    await this.run(`Delete ${name} from ${remote}`, () => git(this.repo, 'deleteRemoteTag', remote, name), { success: `Deleted ${name} from ${remote}` });
  }

  // ------------------------------------------------------------ stashes

  async stash() {
    const st = this.data && this.data.status;
    if (!st || !(st.staged.length + st.unstaged.length)) {
      toast({ type: 'info', title: 'Nothing to stash' });
      return;
    }
    const message = this.panel.summary.value.trim();
    const r = await this.run('Stash', () => git(this.repo, 'stashSave', { message, includeUntracked: true }), { success: 'Changes stashed' });
    if (r && message) this.panel.setMessage('', { amend: false });
  }

  async popStash() {
    const s = this.data && this.data.stashes[0];
    if (!s) {
      toast({ type: 'info', title: 'No stashes to pop' });
      return;
    }
    await this.applyStash(s, { pop: true });
  }

  async applyStash(stash, { pop }) {
    const r = await this.run(`${pop ? 'Pop' : 'Apply'} stash`, () => git(this.repo, 'stashApply', stash.ref, { pop }), { success: pop ? 'Stash popped' : 'Stash applied' });
    if (r) this.selectWip();
  }

  async dropStash(stash) {
    const ok = await confirmDialog({ title: 'Delete stash?', message: `Delete “${stash.summary || stash.message}”? This cannot be undone.`, okLabel: 'Delete stash', danger: true });
    if (!ok) return;
    const r = await this.run('Delete stash', () => git(this.repo, 'stashDrop', stash.ref));
    if (r && this.isSelectedStash(stash)) this.selectWip();
  }

  // ------------------------------------------------------------ remotes

  progressHandler() {
    return on('git:progress', (p) => {
      if (p.repo !== this.repo) return;
      this.progress = p;
      this.renderStatus();
    });
  }

  async fetch({ silent = false } = {}) {
    if (!this.data || !this.data.remotes.length) {
      if (!silent) toast({ type: 'info', title: 'No remotes', message: 'Add a remote to fetch from.', actions: [{ label: 'Add remote', run: () => this.addRemote() }] });
      return;
    }
    if (silent) {
      try {
        await git(this.repo, 'fetch', {});
      } catch {
        // Background fetch failures are not worth interrupting for.
      }
      await this.refresh();
      return;
    }
    const off = this.progressHandler();
    try {
      await this.run('Fetch', () => git(this.repo, 'fetch', {}), { success: 'Fetched all remotes' });
    } finally {
      off();
    }
  }

  async fetchRemote(name) {
    const off = this.progressHandler();
    try {
      await this.run(`Fetch ${name}`, () => git(this.repo, 'fetch', { remote: name }), { success: `Fetched ${name}` });
    } finally {
      off();
    }
  }

  async pull(mode = this.settings.pullMode) {
    const d = this.data;
    if (!d) return;
    if (d.refs.head.detached) {
      toast({ type: 'info', title: 'Not on a branch', message: 'Check out a branch to pull into it.' });
      return;
    }
    if (!d.remotes.length) {
      toast({ type: 'info', title: 'No remotes', message: 'Add a remote to pull from.', actions: [{ label: 'Add remote', run: () => this.addRemote() }] });
      return;
    }
    const b = d.refs.local.find((x) => x.isHead);
    if (!b || !b.upstream) {
      toast({ type: 'info', title: `${d.refs.head.branch} has no upstream`, message: 'Choose which remote branch to pull from.', actions: [{ label: 'Set upstream', run: () => this.setUpstreamFor(d.refs.head.branch) }] });
      return;
    }
    const off = this.progressHandler();
    try {
      await this.run(`Pull ${mode === 'rebase' ? '(rebase)' : mode === 'ff-only' ? '(fast-forward only)' : ''}`.trim(), () => git(this.repo, 'pull', { mode }), {
        success: (r) => (/Already up to date/i.test(r.output || '') ? 'Already up to date' : `Pulled ${b.upstream} into ${b.name}`),
      });
    } finally {
      off();
    }
  }

  async push({ force = false } = {}) {
    const d = this.data;
    if (!d) return;
    const head = d.refs.head;
    if (head.detached || head.unborn) {
      toast({ type: 'info', title: head.unborn ? 'Nothing to push yet' : 'Not on a branch', message: head.unborn ? 'Make the first commit, then push.' : 'Check out a branch to push it.' });
      return;
    }
    if (!d.remotes.length) {
      toast({ type: 'info', title: 'No remotes', message: 'Add a remote to push to.', actions: [{ label: 'Add remote', run: () => this.addRemote() }] });
      return;
    }
    const b = d.refs.local.find((x) => x.isHead);
    let remote = b.upstreamRemote;
    let remoteBranch = b.upstreamBranch;
    let setUpstream = false;
    if (!remote || b.gone) {
      const v = await dialogs.pushUpstreamDialog(this, b.name);
      if (!v) return;
      remote = v.remote;
      remoteBranch = v.name.trim();
      setUpstream = true;
    }
    if (force) {
      const ok = await confirmDialog({ title: `Force push ${b.name}?`, message: `Overwrite ${remote}/${remoteBranch} with your local ${b.name}. Uses --force-with-lease, so it refuses if someone else pushed since your last fetch.`, okLabel: 'Force push', danger: true });
      if (!ok) return;
    }
    const off = this.progressHandler();
    this.beginBusy(`Push ${b.name}`);
    let rejected = null;
    try {
      await git(this.repo, 'push', { remote, branch: b.name, remoteBranch, setUpstream, force });
      toast({ type: 'success', title: `Pushed ${b.name} to ${remote}/${remoteBranch}` });
      this.lastError = null;
    } catch (e) {
      if (e.kind === 'PUSH_REJECTED' && !force) rejected = e;
      else this.handleError('Push', e);
    } finally {
      this.endBusy();
      off();
    }
    await this.refresh();
    if (!rejected) return;
    const choice = await choiceDialog({
      title: 'Push rejected',
      message: `${remote}/${remoteBranch} has commits you don't have yet. Pull them first, or force push to overwrite the remote.`,
      detail: rejected.message,
      choices: [{ id: 'force', label: 'Force push…', danger: true }, { id: 'pull', label: 'Pull' }],
    });
    if (choice === 'pull') await this.pull();
    else if (choice === 'force') await this.push({ force: true });
  }

  async pushTo(branch, remote, remoteBranch) {
    const off = this.progressHandler();
    try {
      await this.run(`Push ${branch} to ${remote}/${remoteBranch}`, () => git(this.repo, 'push', { remote, branch, remoteBranch }), { success: `Pushed ${branch} to ${remote}/${remoteBranch}` });
    } finally {
      off();
    }
  }

  async deleteRemoteBranch(ref) {
    const ok = await confirmDialog({ title: `Delete ${ref.name}?`, message: `Delete the branch ${ref.branchName} from ${ref.remote}. Everyone loses it on their next fetch.`, okLabel: 'Delete from remote', danger: true });
    if (!ok) return;
    await this.run(`Delete ${ref.name}`, () => git(this.repo, 'deleteRemoteBranch', ref.remote, ref.branchName), { success: `Deleted ${ref.name}` });
  }

  async addRemote() {
    if (!this.repo) return;
    const v = await dialogs.remoteDialog(this, null);
    if (!v) return;
    const r = await this.run(`Add remote ${v.name}`, () => git(this.repo, 'addRemote', v.name.trim(), v.url.trim()), { success: `Added ${v.name}` });
    if (r && v.fetch) await this.fetchRemote(v.name.trim());
  }

  async editRemote(remote) {
    const v = await dialogs.remoteDialog(this, remote);
    if (!v) return;
    await this.run(`Edit remote ${remote.name}`, async () => {
      if (v.name.trim() !== remote.name) await git(this.repo, 'renameRemote', remote.name, v.name.trim());
      if (v.url.trim() !== remote.fetchUrl) await git(this.repo, 'setRemoteUrl', v.name.trim(), v.url.trim());
    }, { success: 'Remote updated' });
  }

  async removeRemote(remote) {
    const ok = await confirmDialog({ title: `Remove ${remote.name}?`, message: `Remove the remote ${remote.name} and its remote-tracking branches from this repository. Nothing is deleted on the server.`, okLabel: 'Remove remote', danger: true });
    if (!ok) return;
    await this.run(`Remove ${remote.name}`, () => git(this.repo, 'removeRemote', remote.name), { success: `Removed ${remote.name}` });
  }

  // ------------------------------------------------------------ operations in progress

  async continueOp(message) {
    const op = this.data.opState;
    if (!op) return;
    const r = await this.run(`Continue ${op.type}`, () => git(this.repo, 'continueOperation', op.type, { message }), { success: (x) => (x && x.conflicts ? null : `${op.type[0].toUpperCase()}${op.type.slice(1)} complete`) });
    if (r && !r.conflicts) this.panel.setMessage('', { amend: false });
  }

  async skipRebase() {
    const ok = await confirmDialog({ title: 'Skip this commit?', message: 'The commit being applied is dropped from the rebased branch.', okLabel: 'Skip commit', danger: true });
    if (!ok) return;
    await this.run('Skip commit', () => git(this.repo, 'skipRebase'));
  }

  async abortOp() {
    const op = this.data.opState;
    if (!op) return;
    const ok = await confirmDialog({ title: `Abort ${op.type}?`, message: 'Return the branch and working tree to where they were before it started. Conflict resolutions so far are lost.', okLabel: `Abort ${op.type}`, danger: true });
    if (!ok) return;
    const r = await this.run(`Abort ${op.type}`, () => git(this.repo, 'abortOperation', op.type), { success: `${op.type[0].toUpperCase()}${op.type.slice(1)} aborted` });
    if (r) {
      this.tab.ui.prefilled = null;
      this.panel.setMessage('', { amend: false });
    }
  }

  resolveConflict(path, side) {
    return this.run(`Use ${side} for ${splitPath(path).name}`, () => git(this.repo, 'resolveConflict', path, side));
  }

  markResolved(paths) {
    return this.run('Mark resolved', () => git(this.repo, 'markResolved', paths));
  }

  saveResolution(path, content) {
    return this.run('Save resolution', async () => {
      await git(this.repo, 'writeFile', path, content);
      await git(this.repo, 'markResolved', [path]);
    }, { success: `${splitPath(path).name} resolved` });
  }

  // ------------------------------------------------------------ patch (drag & drop)

  onPatch(src, target, x, y) {
    const cur = this.currentBranch;
    const srcName = this.refName(src);
    const items = [{ header: `${src.name}  →  ${target.name}` }];
    if (target.type === 'local') {
      if (target.name === cur) {
        items.push({ label: `Merge ${src.name} into ${target.name}`, icon: 'git-merge', run: () => this.merge(src) });
        items.push({ label: `Rebase ${target.name} onto ${src.name}`, icon: 'git-pull-request-arrow', run: () => this.rebase(src) });
        items.push({ label: `Fast-forward ${target.name} to ${src.name}`, icon: 'arrow-up', run: () => this.fastForward(target.name, srcName) });
      } else if (src.type === 'local' && src.name === cur) {
        items.push({ label: `Rebase ${src.name} onto ${target.name}`, icon: 'git-pull-request-arrow', run: () => this.rebase(target) });
        items.push({ label: `Merge ${target.name} into ${src.name}`, icon: 'git-merge', run: () => this.merge(target) });
        items.push({ label: `Fast-forward ${target.name} to ${src.name}`, icon: 'arrow-up', run: () => this.fastForward(target.name, srcName) });
      } else {
        items.push({ label: `Fast-forward ${target.name} to ${src.name}`, icon: 'arrow-up', run: () => this.fastForward(target.name, srcName) });
        items.push({ label: `Check out ${target.name}, merge ${src.name} into it`, icon: 'git-merge', run: () => this.checkoutThen(target.name, () => this.merge(src)) });
        items.push({ label: `Check out ${target.name}, rebase onto ${src.name}`, icon: 'git-pull-request-arrow', run: () => this.checkoutThen(target.name, () => this.rebase(src)) });
      }
    } else if (target.type === 'remote') {
      if (src.type === 'local') items.push({ label: `Push ${src.name} to ${target.name}`, icon: 'arrow-up-from-line', run: () => this.pushTo(src.name, target.remote, target.branchName) });
      if (cur && src.type === 'local' && src.name === cur) {
        items.push({ label: `Merge ${target.name} into ${cur}`, icon: 'git-merge', run: () => this.merge(target) });
        items.push({ label: `Rebase ${cur} onto ${target.name}`, icon: 'git-pull-request-arrow', run: () => this.rebase(target) });
      }
    }
    if (items.length === 1) items.push({ label: 'Nothing to patch here', disabled: true });
    contextMenu(x, y, items);
  }

  // ------------------------------------------------------------ menus

  commitMenu(c, x, y) {
    if (!c) return;
    if (c.wip) {
      contextMenu(x, y, [
        { label: 'Stage all changes', icon: 'plus', shortcut: `${kb('⌘⇧S')}`, run: () => this.stageAll() },
        { label: 'Unstage all changes', icon: 'minus', shortcut: `${kb('⌘⇧U')}`, run: () => this.unstageAll() },
        { label: 'Stash changes', icon: 'archive', shortcut: `${kb('⌘⌥S')}`, run: () => this.stash() },
        '-',
        { label: 'Discard all changes…', icon: 'trash-2', danger: true, run: () => this.discardAll() },
      ]);
      return;
    }
    const cur = this.currentBranch;
    const isHead = c.hash === this.headHash;
    const op = this.data.opState;
    contextMenu(x, y, [
      { label: 'Check out this commit', icon: 'crosshair', disabled: isHead && this.data.refs.head.detached, run: () => this.checkoutDetached(c.hash) },
      { label: 'Create branch here…', icon: 'git-branch', shortcut: `${kb('⌘B')}`, run: () => this.createBranch(c.hash, shortHash(c.hash)) },
      { label: 'Create tag here…', icon: 'tag', run: () => this.createTag(c.hash) },
      '-',
      { label: cur ? `Cherry-pick onto ${cur}` : 'Cherry-pick onto HEAD', icon: 'git-commit-horizontal', disabled: isHead || Boolean(op), run: () => this.cherryPick(c.hash) },
      { label: 'Revert this commit', icon: 'rotate-ccw', disabled: Boolean(op), run: () => this.revert(c.hash) },
      {
        label: `Reset ${cur || 'HEAD'} to this commit`,
        icon: 'history',
        disabled: Boolean(op),
        submenu: [
          { label: 'Soft: keep all changes staged', run: () => this.reset(c.hash, 'soft') },
          { label: 'Mixed: keep changes unstaged', run: () => this.reset(c.hash, 'mixed') },
          { label: 'Hard: discard all changes…', danger: true, run: () => this.reset(c.hash, 'hard') },
        ],
      },
      { label: 'Interactive rebase from here…', icon: 'layers', disabled: isHead || Boolean(op), run: () => this.interactiveRebase(c.hash) },
      isHead ? { label: 'Edit commit message…', icon: 'pencil', disabled: Boolean(op), run: () => this.editHeadMessage() } : null,
      '-',
      { label: 'Copy SHA', icon: 'copy', run: () => this.copy(c.hash, 'SHA copied') },
      { label: 'Copy message', icon: 'copy', run: () => this.copy(c.subject, 'Message copied') },
    ]);
  }

  refMenu(ref, x, y) {
    if (!ref) return;
    const cur = this.currentBranch;
    const op = this.data.opState;
    let items = [];
    if (ref.type === 'local') {
      const b = ref.branch;
      items = [
        { header: b.name },
        b.isHead ? null : { label: `Check out ${b.name}`, icon: 'check', run: () => this.checkoutBranch(b.name) },
        b.isHead ? { label: 'Pull', icon: 'arrow-down-to-line', run: () => this.pull() } : null,
        b.isHead ? { label: 'Push', icon: 'arrow-up-from-line', run: () => this.push() } : null,
        !b.isHead && b.upstream && b.behind && !b.ahead ? { label: `Fast-forward to ${b.upstream}`, icon: 'arrow-up', run: () => this.fastForward(b.name, b.upstream) } : null,
        '-',
        !b.isHead && cur ? { label: `Merge ${b.name} into ${cur}`, icon: 'git-merge', disabled: Boolean(op), run: () => this.merge(ref) } : null,
        !b.isHead && cur ? { label: `Rebase ${cur} onto ${b.name}`, icon: 'git-pull-request-arrow', disabled: Boolean(op), run: () => this.rebase(ref) } : null,
        '-',
        { label: 'Create branch here…', icon: 'git-branch', run: () => this.createBranch(b.hash, b.name) },
        { label: 'Create tag here…', icon: 'tag', run: () => this.createTag(b.hash) },
        { label: 'Set upstream…', icon: 'cable', disabled: !this.data.refs.remote.length, run: () => this.setUpstreamFor(b.name) },
        { label: 'Rename…', icon: 'pencil', run: () => this.renameBranch(b.name) },
        { label: `Delete ${b.name}`, icon: 'trash-2', danger: true, disabled: b.isHead, run: () => this.deleteBranch(b.name) },
        '-',
        { label: 'Copy branch name', icon: 'copy', run: () => this.copy(b.name, 'Branch name copied') },
      ];
    } else if (ref.type === 'remote') {
      items = [
        { header: ref.name },
        { label: `Check out ${ref.branchName}`, icon: 'check', run: () => this.checkoutRef(ref) },
        cur ? { label: `Merge ${ref.name} into ${cur}`, icon: 'git-merge', disabled: Boolean(op), run: () => this.merge(ref) } : null,
        cur ? { label: `Rebase ${cur} onto ${ref.name}`, icon: 'git-pull-request-arrow', disabled: Boolean(op), run: () => this.rebase(ref) } : null,
        '-',
        { label: 'Create branch here…', icon: 'git-branch', run: () => this.createBranch(ref.remoteRef.hash, ref.name) },
        { label: `Delete ${ref.branchName} from ${ref.remote}…`, icon: 'trash-2', danger: true, run: () => this.deleteRemoteBranch(ref) },
        '-',
        { label: 'Copy branch name', icon: 'copy', run: () => this.copy(ref.name, 'Branch name copied') },
      ];
    } else if (ref.type === 'remote-root') {
      const r = ref.remote;
      items = [
        { header: r.name },
        { label: `Fetch ${r.name}`, icon: 'refresh-cw', run: () => this.fetchRemote(r.name) },
        { label: 'Edit remote…', icon: 'pencil', run: () => this.editRemote(r) },
        { label: 'Copy URL', icon: 'copy', run: () => this.copy(r.fetchUrl || '', 'URL copied') },
        /^https?:\/\//.test(r.fetchUrl || '') ? { label: 'Open in browser', icon: 'external-link', run: () => invoke('shell:openExternal', r.fetchUrl.replace(/\.git$/, '')) } : null,
        '-',
        { label: `Remove ${r.name}…`, icon: 'trash-2', danger: true, run: () => this.removeRemote(r) },
      ];
    } else if (ref.type === 'tag') {
      const t = ref.tag;
      const remote = this.defaultRemote();
      items = [
        { header: t.name },
        { label: `Check out ${t.name}`, icon: 'crosshair', run: () => this.checkoutDetached(t.hash, t.name) },
        { label: 'Create branch here…', icon: 'git-branch', run: () => this.createBranch(t.hash, t.name) },
        '-',
        remote ? { label: `Push ${t.name} to ${remote}`, icon: 'arrow-up-from-line', run: () => this.pushTag(t.name) } : null,
        remote ? { label: `Delete ${t.name} from ${remote}…`, icon: 'cloud', danger: true, run: () => this.deleteRemoteTag(t.name) } : null,
        { label: `Delete ${t.name}`, icon: 'trash-2', danger: true, run: () => this.deleteTag(t.name) },
        '-',
        { label: 'Copy tag name', icon: 'copy', run: () => this.copy(t.name, 'Tag name copied') },
      ];
    } else if (ref.type === 'stash') {
      const s = ref.stash;
      items = [
        { header: s.summary || s.ref },
        { label: 'Pop stash', icon: 'archive-restore', run: () => this.applyStash(s, { pop: true }) },
        { label: 'Apply stash', icon: 'archive', run: () => this.applyStash(s, { pop: false }) },
        '-',
        { label: 'Delete stash…', icon: 'trash-2', danger: true, run: () => this.dropStash(s) },
      ];
    } else if (ref.type === 'head') {
      items = [{ label: 'Create branch here…', icon: 'git-branch', run: () => this.createBranch(this.headHash) }];
    }
    contextMenu(x, y, items);
  }

  fileMenu(files, kind, x, y) {
    if (!files.length) return;
    const one = files.length === 1 ? files[0] : null;
    const abs = (p) => `${this.repo}/${p}`;
    const ext = one && /\.[^./]+$/.test(one.path) ? one.path.slice(one.path.lastIndexOf('.')) : null;
    const dir = one && one.path.includes('/') ? one.path.slice(0, one.path.lastIndexOf('/') + 1) : null;
    const common = one ? [
      '-',
      { label: 'Open file', icon: 'external-link', disabled: one.status === 'D', run: () => this.openExternal(one.path) },
      { label: revealLabel, icon: 'folder-open', disabled: one.status === 'D', run: () => invoke('shell:showItem', abs(one.path)) },
      { label: 'Copy path', icon: 'copy', run: () => this.copy(one.path, 'Path copied') },
      { label: 'File history', icon: 'history', disabled: !this.headHash || one.untracked || one.status === '?' || one.status === 'A', run: () => this.openFileMode(one, kind, 'history') },
      { label: 'Blame', icon: 'eye', disabled: !this.headHash || one.untracked || one.status === '?' || one.status === 'A' || one.status === 'D', run: () => this.openFileMode(one, kind, 'blame') },
    ] : [];
    let items = [];
    const n = files.length;
    const what = one ? '' : ` ${n} files`;
    if (kind === 'unstaged') {
      items = [
        { label: `Stage${what}`, icon: 'plus', run: () => this.stage(files) },
        { label: `Discard changes${what}…`, icon: 'trash-2', danger: true, run: () => this.discard(files) },
        one && (one.untracked || one.status === '?')
          ? { label: 'Ignore', icon: 'eye', submenu: [
              { label: `Ignore ${one.path}`, run: () => this.ignore(`/${one.path}`) },
              ext ? { label: `Ignore all *${ext} files`, run: () => this.ignore(`*${ext}`) } : null,
              dir ? { label: `Ignore folder ${dir}`, run: () => this.ignore(`/${dir}`) } : null,
            ].filter(Boolean) }
          : null,
        ...common,
      ];
    } else if (kind === 'staged') {
      items = [
        { label: `Unstage${what}`, icon: 'minus', run: () => this.unstage(files) },
        { label: `Discard changes${what}…`, icon: 'trash-2', danger: true, run: () => this.discardStaged(files) },
        ...common,
      ];
    } else if (kind === 'conflicted') {
      items = [
        one ? { label: 'Open merge tool', icon: 'git-merge', run: () => this.openFile({ kind: 'conflict', path: one.path, status: 'U', conflict: one.conflict }) } : null,
        { label: `Take ours${what}`, icon: 'arrow-left', run: async () => { for (const f of files) await this.resolveConflict(f.path, 'ours'); } },
        { label: `Take theirs${what}`, icon: 'arrow-right', run: async () => { for (const f of files) await this.resolveConflict(f.path, 'theirs'); } },
        { label: `Mark${what} resolved`, icon: 'check', run: () => this.markResolved(files.map((f) => f.path)) },
        ...common,
      ];
    } else if (kind === 'commit') {
      items = [
        one ? { label: 'View file at this commit', icon: 'file-text', run: () => this.openFileMode(one, kind, 'file') } : null,
        ...common,
      ];
    }
    contextMenu(x, y, items);
  }

  openFileMode(f, kind, mode) {
    const spec = kind === 'commit'
      ? { ...f, kind: 'commit', hash: f.to }
      : { kind: f.untracked || f.status === '?' ? 'untracked' : kind === 'conflicted' ? 'conflict' : kind, path: f.path, oldPath: f.oldPath, status: f.status, untracked: f.untracked };
    this.tab.ui.detail = spec;
    this.detail.open(spec, { mode });
    this.panel.render();
  }

  openExternal(p) {
    return invoke('shell:openPath', `${this.repo}/${p}`).then((err) => {
      if (err) toast({ type: 'error', title: 'Could not open file', message: err });
    });
  }

  async repoMenu(anchor) {
    const recent = await invoke('recent:list').catch(() => []);
    const items = [
      { header: 'Recent repositories' },
      ...recent.filter((r) => r.exists && r.path !== this.repo).slice(0, 8).map((r) => ({ label: r.name, icon: 'folder-git-2', run: () => this.openRepo(r.path) })),
      '-',
      { label: 'Open repository…', icon: 'folder-open', shortcut: `${kb('⌘O')}`, run: () => this.command('open') },
      { label: 'Clone repository…', icon: 'download', shortcut: `${kb('⌘⇧N')}`, run: () => this.command('clone') },
      { label: 'Start a new repository…', icon: 'plus', shortcut: `${kb('⌘⌥N')}`, run: () => this.command('init') },
      '-',
      { label: revealLabel, icon: 'folder-open', run: () => this.command('reveal') },
      { label: 'Open in Terminal', icon: 'terminal', run: () => this.command('terminal') },
      { label: 'Copy path', icon: 'copy', run: () => this.copy(this.repo, 'Path copied') },
    ];
    menuFromButton(anchor, items);
  }

  branchMenu(anchor) {
    const d = this.data;
    if (!d) return;
    const locals = [...d.refs.local].sort((a, b) => (b.isHead ? 1 : 0) - (a.isHead ? 1 : 0) || a.name.localeCompare(b.name));
    menuFromButton(anchor, [
      { header: 'Check out a branch' },
      ...locals.slice(0, 30).map((b) => ({ label: b.name, checked: b.isHead, disabled: b.isHead, run: () => this.checkoutBranch(b.name) })),
      locals.length > 30 ? { label: `${locals.length - 30} more in the sidebar…`, disabled: true } : null,
      '-',
      { label: 'Create branch…', icon: 'git-branch', shortcut: `${kb('⌘B')}`, run: () => this.createBranch() },
    ]);
  }

  pullMenu(anchor) {
    const m = this.settings.pullMode;
    menuFromButton(anchor, [
      { label: 'Fetch all', icon: 'refresh-cw', shortcut: `${kb('⌘⇧F')}`, run: () => this.fetch() },
      '-',
      { label: 'Pull (fast-forward if possible)', checked: m === 'merge', run: () => this.pull('merge') },
      { label: 'Pull (fast-forward only)', checked: m === 'ff-only', run: () => this.pull('ff-only') },
      { label: 'Pull (rebase)', checked: m === 'rebase', run: () => this.pull('rebase') },
      '-',
      {
        label: 'Default for the Pull button',
        submenu: [
          { label: 'Fast-forward if possible', checked: m === 'merge', run: () => this.setSetting('pullMode', 'merge') },
          { label: 'Fast-forward only', checked: m === 'ff-only', run: () => this.setSetting('pullMode', 'ff-only') },
          { label: 'Rebase', checked: m === 'rebase', run: () => this.setSetting('pullMode', 'rebase') },
        ],
      },
    ]);
  }

  // ------------------------------------------------------------ search

  openSearch() {
    if (!this.repo || !this.data) return;
    this.closeDetail({ focus: false });
    if (!this.search) this.search = { query: '', matches: [], index: -1 };
    const onInput = debounce((q) => this.runSearch(q), 120);
    this.graph.openSearch({
      query: this.search.query,
      onInput,
      onNext: () => this.stepSearch(1),
      onPrev: () => this.stepSearch(-1),
      onClose: () => this.closeSearch(),
      onLoadAll: async () => {
        await this.loadAllCommits();
        this.runSearch(this.search.query);
      },
    });
    if (this.search.query) this.runSearch(this.search.query);
  }

  runSearch(query, { keepIndex = false } = {}) {
    if (!this.search) return;
    const q = query.trim().toLowerCase();
    this.search.query = query;
    if (!q) {
      this.search.matches = [];
      this.search.index = -1;
      this.graph.setMatches(null);
      this.graph.setSearchStatus('');
      return;
    }
    const matches = [];
    this.rows.forEach((c, i) => {
      if (c.wip) return;
      if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.hash.startsWith(q)) matches.push(i);
    });
    this.search.matches = matches;
    if (!keepIndex || this.search.index >= matches.length) this.search.index = matches.length ? 0 : -1;
    this.graph.setMatches(new Set(matches));
    const more = this.data.hasMore;
    this.graph.setSearchStatus(matches.length ? `${this.search.index + 1} of ${matches.length}${more ? '+' : ''}` : 'No matches', { canLoadAll: more });
    if (!keepIndex && matches.length) this.selectRow(matches[0]);
  }

  stepSearch(delta) {
    const s = this.search;
    if (!s || !s.matches.length) return;
    s.index = (s.index + delta + s.matches.length) % s.matches.length;
    this.graph.setSearchStatus(`${s.index + 1} of ${s.matches.length}${this.data.hasMore ? '+' : ''}`, { canLoadAll: this.data.hasMore });
    this.selectRow(s.matches[s.index]);
    this.graph.scrollToIndex(s.matches[s.index], { center: true });
  }

  closeSearch() {
    if (!this.search) return;
    this.search = null;
    this.graph.closeSearch();
    this.graph.setMatches(null);
    this.graph.scroller.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ commands & global events

  command(cmd) {
    const needsRepo = new Set(['fetch', 'pull', 'push', 'branch', 'stash', 'pop', 'stage-all', 'unstage-all', 'discard-all', 'undo', 'redo', 'add-remote', 'identity', 'refresh', 'terminal', 'reveal', 'search', 'filter']);
    if (needsRepo.has(cmd) && !this.repo) return;
    if (hasOpenModal() && !['refresh'].includes(cmd)) return;
    switch (cmd) {
      case 'open': return this.openDialog();
      case 'clone': return dialogs.cloneDialog(this);
      case 'init': return dialogs.initDialog(this);
      case 'new-tab': return this.newTab();
      case 'close-tab': return this.closeTab(this.activeId);
      case 'next-tab': return this.cycleTab(1);
      case 'prev-tab': return this.cycleTab(-1);
      case 'terminal': return invoke('shell:openTerminal', this.repo);
      case 'reveal': return invoke('shell:showItem', this.repo);
      case 'search': return this.openSearch();
      case 'filter':
        if (this.layout.sidebarHidden) this.command('toggle-sidebar');
        return this.sidebar.focusFilter();
      case 'fetch': return this.fetch();
      case 'pull': return this.pull();
      case 'push': return this.push();
      case 'branch': return this.createBranch();
      case 'stash': return this.stash();
      case 'pop': return this.popStash();
      case 'stage-all': return this.stageAll();
      case 'unstage-all': return this.unstageAll();
      case 'discard-all': return this.discardAll();
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      case 'add-remote': return this.addRemote();
      case 'identity': return dialogs.identityDialog(this);
      case 'settings': return dialogs.settingsDialog(this);
      case 'ai-settings': return dialogs.aiSettingsDialog(this);
      case 'shortcuts': return dialogs.shortcutsDialog();
      case 'refresh': return this.refresh();
      case 'check-updates': return this.updates.check();
      case 'toggle-sidebar':
        this.layout.sidebarHidden = !this.layout.sidebarHidden;
        this.applyLayout();
        return this.saveLayout();
      case 'toggle-panel':
        this.layout.panelHidden = !this.layout.panelHidden;
        this.applyLayout();
        return this.saveLayout();
      default:
        return undefined;
    }
  }

  applyAutoFetch() {
    clearInterval(this.autoFetchTimer);
    const minutes = Number(this.settings.autoFetch) || 0;
    if (!minutes) return;
    this.autoFetchTimer = setInterval(() => {
      if (this.repo && this.data && this.data.remotes.length && !this.busy.length) this.fetch({ silent: true });
    }, minutes * 60 * 1000);
  }

  bindGlobal() {
    on('menu', ({ command }) => this.command(command));
    on('repo:changed', ({ root }) => {
      if (root === this.repo) this.refresh();
      else {
        const t = this.tabs.find((x) => x.root === root);
        if (t) t.stale = true;
      }
    });
    on('window:focus', () => {
      if (this.repo) this.refresh();
    });
    on('open-path', ({ path }) => this.openRepo(path));
    // Git or SSH needs a login: answer it with GitDonkey's own dialog.
    on('askpass:request', async (req) => {
      let result = null;
      try {
        result = await dialogs.credentialDialog(this, req);
      } finally {
        invoke('askpass:reply', req.id, result);
      }
    });

    document.addEventListener('keydown', (e) => {
      const inText = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
      const meta = isMac ? e.metaKey : e.ctrlKey;
      if (e.key === 'Escape' && !hasOpenModal()) {
        if (this.search) {
          e.preventDefault();
          this.closeSearch();
        } else if (this.detail.isOpen() && !inText) {
          e.preventDefault();
          this.closeDetail();
        }
        return;
      }
      if (hasOpenModal()) return;
      if (meta && !inText && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (meta && !inText && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (meta && /^[1-9]$/.test(e.key)) {
        const t = this.tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          this.activate(t.id);
        }
      }
    });

    // Drop folders onto the window to open them.
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('drop-target');
    });
    document.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) document.body.classList.remove('drop-target');
    });
    document.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      document.body.classList.remove('drop-target');
      for (const f of e.dataTransfer.files) {
        const p = pathForFile(f);
        if (p) await this.openRepo(p);
      }
    });
    window.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('input, textarea')) e.preventDefault();
    });
  }
}

const app = new App();
window.__gitdonkey = app;
app.init().catch((e) => {
  console.error(e);
  document.body.appendChild(h('pre', { class: 'fatal' }, `GitDonkey failed to start:\n${e.stack || e.message}`));
});
