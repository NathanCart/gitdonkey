// Command palette (⌘P): every action, branch, changed file, tab, recent
// repository and pull request, one fuzzy search away.
import { h, icon, clear } from './dom.js';
import { invoke, kb } from './api.js';
import { openModal } from './ui.js';
import { rank } from './lib/fuzzy.js';

const MAX_ROWS = 80;

function highlight(text, hits) {
  if (!hits.length) return text;
  const set = new Set(hits);
  const out = [];
  let buf = '';
  let on = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on && buf) {
      out.push(on ? h('mark', null, buf) : buf);
      buf = '';
    }
    on = hit;
    buf += text[i];
  }
  if (buf) out.push(on ? h('mark', null, buf) : buf);
  return out;
}

/** Everything the palette can do right now, as { label, kind, icon, keys, run }. */
async function entries(app) {
  const list = [...app.paletteCommands()];
  const d = app.data;
  if (d) {
    for (const b of d.refs.local) {
      if (b.isHead) continue;
      const wt = app.worktreeOf(b.name);
      list.push({ label: wt ? `Open the worktree with ${b.name}` : `Check out ${b.name}`, kind: 'Branch', icon: wt ? 'folder-tree' : 'git-branch', run: () => (wt ? app.openRepo(wt.path) : app.checkoutBranch(b.name)) });
    }
    const locals = new Set(d.refs.local.map((b) => b.name));
    for (const r of d.refs.remote) {
      if (locals.has(r.name)) continue;
      list.push({ label: `Check out ${r.shortName}`, kind: 'Remote branch', icon: 'cloud', run: () => app.checkoutRef({ type: 'remote', name: r.shortName, remote: r.remote, branchName: r.name, remoteRef: r }) });
    }
    const st = d.status;
    const seen = new Set();
    for (const [kind, files] of [['conflicted', st.conflicted], ['unstaged', st.unstaged], ['staged', st.staged]]) {
      for (const f of files) {
        const key = `${kind}:${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          label: f.path,
          kind: kind === 'conflicted' ? 'Conflicted file' : kind === 'staged' ? 'Staged file' : 'Changed file',
          icon: kind === 'conflicted' ? 'triangle-alert' : 'file-diff',
          run: () => app.openFile(kind === 'conflicted'
            ? { kind: 'conflict', path: f.path, status: 'U', conflict: f.conflict }
            : { kind: f.untracked ? 'untracked' : kind, path: f.path, oldPath: f.oldPath, status: f.status, untracked: f.untracked }),
        });
      }
    }
    const prs = app.pulls.state();
    for (const pr of prs.list || []) list.push({ label: `#${pr.number} ${pr.title}`, kind: 'Pull request', icon: 'git-pull-request', run: () => app.pulls.reveal(pr) });
    for (const s of d.stashes) list.push({ label: `Stash: ${s.summary || s.message}`, kind: 'Stash', icon: 'archive', run: () => app.selectStash(s) });
  }
  for (const t of app.tabs) {
    if (t.id === app.activeId || !t.root) continue;
    list.push({ label: `Switch to ${t.name}`, kind: 'Tab', icon: 'folder-git-2', run: () => app.activate(t.id) });
  }
  const recent = await invoke('recent:list').catch(() => []);
  for (const r of recent) {
    if (!r.exists || app.tabs.some((t) => t.root === r.path)) continue;
    list.push({ label: `Open ${r.name}`, hint: r.path, kind: 'Repository', icon: 'folder-open', run: () => app.openRepo(r.path) });
  }
  return list;
}

export async function openPalette(app) {
  const all = await entries(app);
  const input = h('input', { class: 'input palette-input', placeholder: 'Type a command, branch, file or repository', spellcheck: 'false', 'aria-label': 'Command palette', autocomplete: 'off' });
  const listEl = h('div', { class: 'palette-list', role: 'listbox' });
  let rows = [];
  let active = 0;
  let modal = null;

  const choose = (i) => {
    const r = rows[i];
    if (!r) return;
    modal.close(null);
    Promise.resolve(r.item.run()).catch((e) => console.error(e));
  };
  const mark = () => {
    [...listEl.children].forEach((el, i) => {
      el.classList.toggle('on', i === active);
      el.setAttribute('aria-selected', String(i === active));
    });
    const el = listEl.children[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = input.value;
    rows = rank(all, q, (x) => x.label).slice(0, MAX_ROWS);
    active = 0;
    clear(listEl);
    if (!rows.length) {
      listEl.appendChild(h('div', { class: 'palette-empty' }, `Nothing matches “${q}”.`));
      return;
    }
    rows.forEach(({ item, hits }, i) => {
      listEl.appendChild(h('div', {
        class: ['palette-row', item.disabled && 'disabled'],
        role: 'option',
        title: item.hint || '',
        onMousemove: () => {
          if (active !== i) {
            active = i;
            mark();
          }
        },
        onMousedown: (e) => {
          e.preventDefault();
          if (!item.disabled) choose(i);
        },
      },
      h('span', { class: 'palette-ico' }, icon(item.icon || 'command', { size: 15 })),
      h('span', { class: 'palette-label' }, highlight(item.label, hits)),
      item.keys ? h('kbd', null, item.keys) : null,
      h('span', { class: 'palette-kind' }, item.kind || 'Command')));
    });
    mark();
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      active = Math.min(rows.length - 1, active + 1);
      mark();
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[active] && !rows[active].item.disabled) choose(active);
    }
  });
  modal = openModal({
    title: 'Command palette',
    width: 640,
    className: 'palette',
    body: h('div', { class: 'palette-body' }, h('div', { class: 'palette-search' }, icon('command', { size: 15 }), input), listEl,
      h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑↓'), ' move'), h('span', null, h('kbd', null, '↵'), ' run'), h('span', null, h('kbd', null, 'Esc'), ' close'), h('span', { class: 'spacer' }), h('span', null, `${kb('⌘P')} opens this`))),
  });
  render();
  input.focus();
}
