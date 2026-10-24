// Left jack field: local branches, remotes, stashes, tags.
import { h, icon, clear, jack } from './dom.js';
import { buildRefTree, relativeTime } from './lib/util.js';
import { kb } from './api.js';

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
      if (ref) this.app.revealRef(ref);
    });
    this.body.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.sb-item');
      if (!item) return;
      const ref = this.refs.get(item);
      if (!ref) return;
      if (ref.type === 'stash') this.app.applyStash(ref.stash, { pop: false });
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

    // STASHES
    const stashes = d.stashes.filter((s) => match(s.summary) || match(s.ref));
    this.body.appendChild(this.section('stashes', 'Stashes', d.stashes.length, [
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
    if (b.ahead) badges.push(h('span', { class: 'ab ahead', title: `${b.ahead} commit(s) to push` }, icon('arrow-up', { size: 11, stroke: 2.25 }), b.ahead));
    if (b.behind) badges.push(h('span', { class: 'ab behind', title: `${b.behind} commit(s) to pull` }, icon('arrow-down', { size: 11, stroke: 2.25 }), b.behind));
    if (b.gone) badges.push(h('span', { class: 'ab gone', title: 'Upstream branch is gone' }, 'gone'));
    const ref = { type: 'local', name: b.name, isHead: b.isHead, branch: b };
    const item = h('div', {
      class: ['sb-item', 'sb-branch', b.isHead && 'head'],
      draggable: 'true',
      dataset: { patchable: '1' },
      style: { '--jack': color },
      title: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\nDouble-click to check out · drag onto another branch to patch`,
    }, jack(color, { lit: b.isHead }), h('span', { class: 'sb-name' }, leaf), badges);
    this.refs.set(item, ref);
    return item;
  }

  remoteItem(b, leaf, color) {
    const ref = { type: 'remote', name: b.shortName, remote: b.remote, branchName: b.name, remoteRef: b };
    const item = h('div', {
      class: 'sb-item sb-branch remote',
      draggable: 'true',
      dataset: { patchable: '1' },
      style: { '--jack': color },
      title: `${b.shortName}\nDouble-click to check out a local tracking branch`,
    }, jack(color), h('span', { class: 'sb-name' }, leaf));
    this.refs.set(item, ref);
    return item;
  }
}
