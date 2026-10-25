// Left jack field: local branches, remotes, stashes, tags.
import { h, icon, clear, jack } from './dom.js';
import { buildRefTree, relativeTime } from './lib/util.js';
import { kb } from './api.js';
import { syncText } from './graph-view.js';
import { pullTag } from './pulls.js';

const NEUTRAL = 'var(--legend-3)';

export class Sidebar {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.filter = '';
    this.refs = new WeakMap();
    this.filterInput = h('input', { class: 'input sb-filter-input', placeholder: 'Filter branches, tags, stashes', spellcheck: 'false', 'aria-label': 'Filter' });
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.render();
    });
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.filterInput.value = '';
        this.filter = '';
        this.render();
        this.filterInput.blur();
      }
    });
    this.body = h('div', { class: 'sb-body' });
    this.el.append(h('div', { class: 'sb-filter' }, icon('search', { size: 14 }), this.filterInput), this.body);

    this.body.addEventListener('click', (e) => {
      const fold = e.target.closest('[data-fold]');
      if (fold) {
        this.toggle(fold.dataset.fold);
        return;
      }
      const item = e.target.closest('.sb-item');
      if (!item || e.target.closest('button')) return;
      const ref = this.refs.get(item);
      if (ref && ref.type === 'submodule') return;
      if (ref && ref.type === 'worktree') {
        if (ref.worktree.branch) {
          const b = this.app.data.refs.local.find((x) => x.name === ref.worktree.branch);
          if (b) this.app.selectCommit(b.hash, { scroll: true });
        }
        return;
      }
      if (ref) this.app.revealRef(ref);
    });
    this.body.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.sb-item');
      if (!item) return;
      const ref = this.refs.get(item);
      if (!ref) return;
      if (ref.type === 'pr') this.app.pulls.checkout(ref.pr);
      else if (ref.type === 'worktree') this.app.checkoutRef(ref);
      else if (ref.type === 'submodule' && ref.submodule.state !== 'missing') this.app.openRepo(ref.submodule.root);
      else if (ref.type === 'stash') this.app.applyStash(ref.stash, { pop: false });
      else if (ref.type === 'local' || ref.type === 'remote') this.app.checkoutRef(ref);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.sb-item, .sb-remote');
      if (!item) return;
      e.preventDefault();
      const ref = this.refs.get(item);
      if (ref) this.app.refMenu(ref, e.clientX, e.clientY);
    });
    this.app.patch.bindTargets(this.body, (el) => this.refs.get(el.closest('.sb-item')));
  }

  focusFilter() {
    this.filterInput.focus();
    this.filterInput.select();
  }

  collapsed() {
    const tab = this.app.tab;
    if (!tab.ui.collapsed) tab.ui.collapsed = { 'sec:tags': false };
    return tab.ui.collapsed;
  }

  toggle(key) {
    const c = this.collapsed();
    c[key] = !c[key];
    this.render();
  }

  render() {
    const d = this.app.data;
    clear(this.body);
    if (!d) return;
    const f = this.filter;
    const match = (s) => !f || s.toLowerCase().includes(f);
    const colorOf = (hash) => this.app.laneColorFor(hash) || NEUTRAL;
    const col = this.collapsed();

    // LOCAL
    const locals = d.refs.local.filter((b) => match(b.name));
    this.body.appendChild(this.section('local', 'Local', d.refs.local.length, [
      { icon: 'plus', title: `Create branch at HEAD (${kb('⌘B')})`, run: () => this.app.createBranch() },
    ], () => {
      if (!d.refs.local.length && d.refs.head.unborn) return [h('div', { class: 'sb-empty' }, `${d.refs.head.branch} (no commits yet)`)];
      const tree = buildRefTree(locals, (b) => b.name);
      return this.tree(tree, 'local', 0, (b, leaf) => this.branchItem(b, leaf, colorOf(b.hash)));
    }));

    // REMOTE
    const remoteCount = d.refs.remote.length;
    this.body.appendChild(this.section('remote', 'Remote', remoteCount, [
      { icon: 'plus', title: 'Add remote', run: () => this.app.addRemote() },
    ], () => {
      if (!d.remotes.length) return [h('div', { class: 'sb-empty' }, 'No remotes. Add one to push and pull.')];
      const out = [];
      for (const r of d.remotes) {
        const branches = d.refs.remote.filter((b) => b.remote === r.name && match(b.shortName));
        if (f && !branches.length && !match(r.name)) continue;
        const key = `remote:${r.name}`;
        const open = f ? true : !col[key];
        const header = h('div', { class: 'sb-remote', dataset: { fold: key }, title: r.fetchUrl || '' },
          h('span', { class: ['chev', open && 'open'] }, icon('chevron-right', { size: 12 })),
          icon('cloud', { size: 14 }),
          h('span', { class: 'sb-name' }, r.name),
          h('span', { class: 'sb-count' }, String(d.refs.remote.filter((b) => b.remote === r.name).length)));
        this.refs.set(header, { type: 'remote-root', name: r.name, remote: r });
        out.push(header);
        if (open) {
          const tree = buildRefTree(branches, (b) => b.name);
          out.push(...this.tree(tree, key, 1, (b, leaf) => this.remoteItem(b, leaf, colorOf(b.hash))));
        }
      }
      return out;
    }));

    // WORKTREES (only when there's more than one)
    const wts = d.worktrees || [];
    if (wts.length > 1) {
      this.body.appendChild(this.section('worktrees', 'Worktrees', wts.length, [
        { icon: 'plus', title: 'New worktree…', run: () => this.app.newWorktree() },
      ], () => wts.filter((w) => match(`${w.path} ${w.branch || ''}`)).map((w) => {
        const name = w.path.split(/[\\/]/).pop();
        const item = h('div', {
          class: ['sb-item', 'sb-worktree', w.current && 'head', w.prunable && 'missing'],
          style: { '--indent': '0' },
          title: `${w.path}${w.branch ? `\n${w.branch}` : ''}${w.current ? '\nThis tab' : w.prunable ? '\nThe folder is gone' : '\nDouble-click to open in a new tab'}`,
        }, icon(w.current ? 'folder-open' : 'folder-tree', { size: 13 }), h('span', { class: 'sb-name' }, name),
        h('span', { class: 'sb-meta' }, w.prunable ? 'missing' : w.branch || (w.head ? `${w.head.slice(0, 7)}` : '')));
        this.refs.set(item, { type: 'worktree', name, worktree: w });
        return item;
      })));
    }

    // SUBMODULES
    const subs = d.submodules || [];
    if (subs.length) {
      const words = { ok: '', moved: 'moved', missing: 'not set up', conflict: 'conflict' };
      this.body.appendChild(this.section('submodules', 'Submodules', subs.length, [
        { icon: 'download', title: 'Update all submodules to the commits this branch records', run: () => this.app.updateSubmodules() },
      ], () => subs.filter((x) => match(x.path)).map((x) => {
        const item = h('div', {
          class: ['sb-item', 'sb-submodule', `sub-${x.state}`],
          style: { '--indent': '0' },
          title: `${x.path}${x.url ? `\n${x.url}` : ''}${x.sha ? `\n${x.sha.slice(0, 10)}${x.describe ? ` (${x.describe})` : ''}` : ''}${x.state === 'moved' ? '\nChecked out at a different commit from the one this branch records' : x.state === 'missing' ? '\nNot set up yet: right-click to set it up' : ''}`,
        }, icon('package', { size: 13 }), h('span', { class: 'sb-name' }, x.path), words[x.state] ? h('span', { class: 'sb-meta' }, words[x.state]) : null);
        this.refs.set(item, { type: 'submodule', name: x.path, submodule: x });
        return item;
      })));
    }

    // PULL REQUESTS (repositories on GitHub)
    const prs = this.app.pulls.state();
    if (prs.status !== 'none' && prs.status !== 'idle') {
      const count = prs.list ? prs.list.length : 0;
      const shown = prs.status === 'ready' && f ? prs.list.filter((p) => match(`#${p.number} ${p.title} ${p.head}`)) : null;
      this.body.appendChild(this.section('pulls', 'Pull requests', prs.status === 'ready' ? count : '', [
        { icon: 'rotate-cw', title: 'Refresh pull requests', run: () => this.app.pulls.load(this.app.tab, { force: true }) },
        { icon: 'plus', title: 'Open a pull request for the current branch', run: () => this.app.pulls.create() },
      ], () => this.app.pulls.sidebarItems((el, ref) => {
        if (shown && !shown.includes(ref.pr)) el.hidden = true;
        this.refs.set(el, ref);
      })));
    }

    // STASHES
    const stashes = d.stashes.filter((s) => match(s.summary) || match(s.ref));
    this.body.appendChild(this.section('stashes', 'Stashes', d.stashes.length, [
      { icon: 'life-buoy', title: 'Recover lost work: discarded changes, dropped stashes, lost commits', run: () => this.app.command('recover') },
      { icon: 'archive', title: `Stash changes (${kb('⌘⌥S')})`, run: () => this.app.stash() },
    ], () => {
      if (!d.stashes.length) return [h('div', { class: 'sb-empty' }, 'No stashes')];
      return stashes.map((s) => {
        const item = h('div', {
          class: ['sb-item', 'sb-stash', this.app.isSelectedStash(s) && 'selected'],
          style: { '--indent': '0' },
          title: `${s.message}\n${relativeTime(s.date)} · double-click to apply`,
        }, icon('archive', { size: 13 }), h('span', { class: 'sb-name' }, s.summary || s.message), h('span', { class: 'sb-meta' }, `{${s.index}}`));
        this.refs.set(item, { type: 'stash', name: s.ref, stash: s });
        return item;
      });
    }));

    // TAGS
    const tags = d.refs.tags.filter((t) => match(t.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    this.body.appendChild(this.section('tags', 'Tags', d.refs.tags.length, [
      { icon: 'plus', title: 'Create tag at HEAD', run: () => this.app.createTag(this.app.headHash) },
    ], () => {
      if (!d.refs.tags.length) return [h('div', { class: 'sb-empty' }, 'No tags')];
      return tags.map((t) => {
        const item = h('div', { class: 'sb-item sb-tag', style: { '--indent': '0' }, title: t.message || t.name },
          icon('tag', { size: 13 }), h('span', { class: 'sb-name' }, t.name));
        this.refs.set(item, { type: 'tag', name: t.name, tag: t });
        return item;
      });
    }));
  }

  section(id, title, count, actions, content) {
    const key = `sec:${id}`;
    const col = this.collapsed();
    const open = this.filter ? true : !col[key];
    const head = h('div', { class: 'sb-head' },
      h('button', { class: 'sb-head-toggle', dataset: { fold: key }, 'aria-expanded': String(open) },
        h('span', { class: ['chev', open && 'open'] }, icon('chevron-right', { size: 12 })),
        h('span', { class: 'legend' }, title),
        h('span', { class: 'sb-count' }, String(count))),
      h('span', { class: 'sb-actions' }, actions.map((a) => h('button', { class: 'icon-btn', title: a.title, 'aria-label': a.title, onClick: (e) => {
        e.stopPropagation();
        a.run();
      } }, icon(a.icon, { size: 14 })))));
    return h('section', { class: ['sb-section', `sb-sec-${id}`] }, head, open ? h('div', { class: 'sb-list' }, content()) : null);
  }

  tree(node, prefix, depth, leafFn) {
    const out = [];
    const col = this.collapsed();
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) {
      const key = `${prefix}/${folder.path}`;
      const open = this.filter ? true : !col[key];
      out.push(h('div', { class: 'sb-folder', dataset: { fold: key }, style: { '--indent': String(depth) } },
        h('span', { class: ['chev', open && 'open'] }, icon('chevron-right', { size: 12 })),
        icon(open ? 'folder-open' : 'folder', { size: 13 }),
        h('span', { class: 'sb-name' }, folder.name)));
      if (open) out.push(...this.tree(folder, prefix, depth + 1, leafFn).map((el) => el));
    }
    const leaves = [...node.leaves].sort((a, b) => a.leaf.localeCompare(b.leaf));
    for (const { item, leaf } of leaves) {
      const el = leafFn(item, leaf);
      el.style.setProperty('--indent', String(depth));
      out.push(el);
    }
    return out;
  }

  branchItem(b, leaf, color) {
    const badges = [];
    if (b.ahead && b.behind) badges.push(h('span', { class: 'ab split', title: syncText(b) }, 'split'));
    if (b.ahead) badges.push(h('span', { class: 'ab ahead', title: `${b.ahead} commit(s) to push` }, icon('arrow-up', { size: 11, stroke: 2.25 }), b.ahead));
    if (b.behind) badges.push(h('span', { class: 'ab behind', title: `${b.behind} commit(s) to pull` }, icon('arrow-down', { size: 11, stroke: 2.25 }), b.behind));
    if (b.gone) badges.push(h('span', { class: 'ab gone', title: 'Upstream branch is gone' }, 'gone'));
    const pr = this.app.pulls.forBranch(b.name);
    if (pr) badges.push(pullTag(pr));
    const wt = this.app.worktreeOf(b.name);
    if (wt) badges.push(h('span', { class: 'wt-mark', title: `Checked out in the worktree ${wt.path}` }, icon('folder-tree', { size: 12 })));
    const ref = { type: 'local', name: b.name, isHead: b.isHead, branch: b };
    const hidden = !b.isHead && this.app.hiddenInGraph(`refs/heads/${b.name}`, b.hash);
    if (hidden) badges.push(h('button', { class: 'gh-eye', title: 'Hidden in the graph. Click to show it.', 'aria-label': `Show ${b.name} in the graph`, onClick: (e) => {
      e.stopPropagation();
      this.app.toggleHidden(`refs/heads/${b.name}`);
    } }, icon('eye-off', { size: 12 })));
    const item = h('div', {
      class: ['sb-item', 'sb-branch', b.isHead && 'head', b.ahead && b.behind && 'diverged', hidden && 'graph-hidden'],
      draggable: 'true',
      dataset: { patchable: '1' },
      style: { '--jack': color },
      title: `${b.name}${b.upstream ? `\n${syncText(b)}` : ''}\nDouble-click to check out · drag onto another branch to patch`,
    }, jack(color, { lit: b.isHead }), h('span', { class: 'sb-name' }, leaf), badges);
    this.refs.set(item, ref);
    return item;
  }

  remoteItem(b, leaf, color) {
    const ref = { type: 'remote', name: b.shortName, remote: b.remote, branchName: b.name, remoteRef: b };
    const hidden = this.app.hiddenInGraph(`refs/remotes/${b.shortName}`, b.hash);
    const item = h('div', {
      class: ['sb-item', 'sb-branch', 'remote', hidden && 'graph-hidden'],
      draggable: 'true',
      dataset: { patchable: '1' },
      style: { '--jack': color },
      title: `${b.shortName}\nDouble-click to check out a local tracking branch`,
    }, jack(color), h('span', { class: 'sb-name' }, leaf), hidden ? h('span', { class: 'gh-eye', title: 'Hidden in the graph' }, icon('eye-off', { size: 12 })) : null);
    this.refs.set(item, ref);
    return item;
  }
}
