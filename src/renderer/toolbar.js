// Top toolbar: repository + branch plugs, then rows of keyed modules.
import { h, icon, clear, jack, legend } from './dom.js';
import { shortHash } from './lib/util.js';
import { kb } from './api.js';

function key({ id, ico, label, title, onClick, disabled, badge, badgeKind, menu }) {
  const btn = h('button', {
    class: ['key', menu && 'has-menu'],
    dataset: { key: id },
    title,
    'aria-label': title || label,
    disabled,
    onClick,
  },
  h('span', { class: 'key-ico' }, icon(ico, { size: 19, stroke: 1.6 }), badge ? h('span', { class: ['key-badge', badgeKind] }, String(badge)) : null),
  legend(label, 'key-legend'));
  if (!menu) return btn;
  return h('div', { class: 'key-split' }, btn, h('button', {
    class: 'key-menu',
    title: `${label} options`,
    'aria-label': `${label} options`,
    disabled,
    onClick: (e) => menu(e.currentTarget.parentElement),
  }, icon('chevron-down', { size: 12, stroke: 2 })));
}

export function renderToolbar(el, app) {
  clear(el);
  const tab = app.tab;
  if (!tab || !tab.root) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const d = app.data;
  const head = d ? d.refs.head : null;
  const branch = d ? d.refs.local.find((b) => b.isHead) : null;
  const color = head ? app.laneColorFor(head.hash) || 'var(--legend-3)' : 'var(--legend-3)';
  const dirty = d ? d.status.staged.length + d.status.unstaged.length > 0 : false;
  const undo = tab.ui.undo[tab.ui.undo.length - 1];
  const redo = tab.ui.redo[tab.ui.redo.length - 1];

  const repoPlug = h('div', { class: 'tb-plug' },
    legend('Repository'),
    h('button', { class: 'plug-btn', title: tab.root, onClick: (e) => app.repoMenu(e.currentTarget) },
      icon('folder-git-2', { size: 15 }), h('span', { class: 'plug-btn-label' }, tab.name), icon('chevron-down', { size: 12, stroke: 2 })));
  const branchLabel = !head ? '…' : head.detached ? `HEAD ${shortHash(head.hash)}` : head.branch;
  const branchPlug = h('div', { class: 'tb-plug' },
    legend('Branch'),
    h('button', { class: 'plug-btn', title: 'Switch branch', onClick: (e) => app.branchMenu(e.currentTarget), style: { '--jack': color } },
      head && head.detached ? icon('crosshair', { size: 14 }) : jack(color, { lit: true, size: 10 }),
      h('span', { class: 'plug-btn-label' }, branchLabel),
      branch && branch.upstream ? null : head && !head.detached && !head.unborn && d.remotes.length ? h('span', { class: 'no-upstream', title: 'No upstream branch: push to publish it' }, 'local') : null,
      icon('chevron-down', { size: 12, stroke: 2 })));

  const keys = h('div', { class: 'tb-keys' },
    h('div', { class: 'key-group' },
      key({ id: 'undo', ico: 'undo-2', label: 'Undo', title: undo ? `Undo: ${undo.label} (${kb('⌘Z')})` : 'Nothing to undo', disabled: !undo, onClick: () => app.undo() }),
      key({ id: 'redo', ico: 'redo-2', label: 'Redo', title: redo ? `Redo: ${redo.label} (${kb('⌘⇧Z')})` : 'Nothing to redo', disabled: !redo, onClick: () => app.redo() })),
    h('div', { class: 'key-group' },
      key({
        id: 'pull', ico: 'arrow-down-to-line', label: 'Pull', title: `Pull (${kb('⌘⇧L')})`, onClick: () => app.pull(),
        badge: branch && branch.behind ? branch.behind : null, badgeKind: 'behind', menu: (anchor) => app.pullMenu(anchor), disabled: !d,
      }),
      key({ id: 'push', ico: 'arrow-up-from-line', label: 'Push', title: `Push (${kb('⌘⇧P')})`, onClick: () => app.push(), badge: branch && branch.ahead ? branch.ahead : null, badgeKind: 'ahead', disabled: !d })),
    h('div', { class: 'key-group' },
      key({ id: 'branch', ico: 'git-branch', label: 'Branch', title: `Create branch (${kb('⌘B')})`, onClick: () => app.createBranch(), disabled: !d || head.unborn }),
      key({ id: 'stash', ico: 'archive', label: 'Stash', title: `Stash changes (${kb('⌘⌥S')})`, onClick: () => app.stash(), disabled: !dirty }),
      key({ id: 'pop', ico: 'archive-restore', label: 'Pop', title: `Pop latest stash (${kb('⌘⌥P')})`, onClick: () => app.popStash(), disabled: !d || !d.stashes.length, badge: d && d.stashes.length > 1 ? d.stashes.length : null, badgeKind: 'neutral' })));

  const right = h('div', { class: 'tb-right' },
    key({ id: 'fetch', ico: 'refresh-cw', label: 'Fetch', title: `Fetch all remotes (${kb('⌘⇧F')})`, onClick: () => app.fetch(), disabled: !d || !d.remotes.length }),
    key({ id: 'search', ico: 'search', label: 'Find', title: `Find commits (${kb('⌘F')})`, onClick: () => app.openSearch() }),
    key({ id: 'terminal', ico: 'terminal', label: 'Terminal', title: `Open in Terminal (${kb('⌘⌥T')})`, onClick: () => app.command('terminal') }),
    key({ id: 'settings', ico: 'settings', label: 'Settings', title: `Settings (${kb('⌘,')})`, onClick: () => app.command('settings') }));

  el.append(h('div', { class: 'tb-left' }, repoPlug, branchPlug), keys, right);
}
