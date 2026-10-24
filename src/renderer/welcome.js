// Welcome / new-tab screen.
import { h, icon, clear, legend, logoMark, kbd } from './dom.js';
import { relativeTime } from './lib/util.js';
import { invoke, isMac, kb } from './api.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Authored illustration: a strip of jacks with patch cables hanging between them. */
function cableField() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1200 190');
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('cable-field');
  const jacks = [70, 190, 300, 430, 545, 660, 790, 905, 1020, 1135];
  // [from jack, to jack, colour, sag]; the lowest point of each cable sits at 34 + sag.
  const cables = [
    [0, 3, '#ff5a3c', 118], [1, 2, '#ffb627', 56], [2, 6, '#36c3d0', 146], [4, 5, '#86d05a', 52],
    [5, 9, '#a07cff', 128], [7, 8, '#ff6fae', 62], [3, 7, '#4c8dff', 100], [6, 8, '#d9d4c7', 84],
  ];
  let out = '<line x1="0" y1="34" x2="1200" y2="34" class="cf-rule"/>';
  for (const [a, b, color, sag] of cables) {
    const x1 = jacks[a];
    const x2 = jacks[b];
    const mx = (x1 + x2) / 2;
    out += `<path d="M ${x1} 34 Q ${mx} ${34 + sag * 2} ${x2} 34" stroke="${color}" class="cf-cable"/>`;
  }
  for (const x of jacks) out += `<circle cx="${x}" cy="34" r="11" class="cf-nut"/><circle cx="${x}" cy="34" r="5" class="cf-hole"/>`;
  svg.innerHTML = out;
  return svg;
}

export async function renderWelcome(el, app) {
  const recent = await invoke('recent:list').catch(() => []);
  const k = kb;
  const action = (ico, title, sub, shortcut, run, id) => h('button', { class: 'w-action', dataset: { action: id }, onClick: run },
    h('span', { class: 'w-action-ico' }, icon(ico, { size: 22, stroke: 1.6 })),
    h('span', { class: 'w-action-text' }, h('span', { class: 'w-action-title' }, title), h('span', { class: 'w-action-sub' }, sub)),
    kbd(k(shortcut)));

  const recentList = recent.length
    ? h('div', { class: 'w-recent-list' }, recent.slice(0, 10).map((r) => h('div', { class: ['w-recent', !r.exists && 'missing'] },
        h('button', {
          class: 'w-recent-open',
          disabled: !r.exists,
          title: r.exists ? r.path : `${r.path} (missing)`,
          onClick: () => app.openRepo(r.path),
        },
        icon('folder-git-2', { size: 16 }),
        h('span', { class: 'w-recent-text' }, h('span', { class: 'w-recent-name' }, r.name), h('span', { class: 'w-recent-path' }, r.path.replace(app.info?.home || '\0', '~'))),
        h('span', { class: 'w-recent-when' }, r.exists ? relativeTime(r.opened) : 'missing')),
        h('button', {
          class: 'icon-btn w-recent-x',
          title: 'Remove from list',
          'aria-label': `Remove ${r.name} from recent repositories`,
          onClick: async () => {
            await invoke('recent:remove', r.path);
            renderWelcome(el, app);
          },
        }, icon('x', { size: 14 })))))
    : h('div', { class: 'w-recent-empty' }, 'Repositories you open will be listed here.');

  clear(el).append(
    cableField(),
    h('div', { class: 'w-inner' },
      h('div', { class: 'w-brand' },
        logoMark(64),
        h('div', null, h('h1', { class: 'wordmark' }, 'GitDonkey'), h('p', { class: 'w-tag' }, 'Every branch in view. Every change within reach.'))),
      h('div', { class: 'w-grid' },
        h('section', { class: 'w-col' },
          legend('Start'),
          action('folder-open', 'Open a repository', isMac ? 'Any Git folder on this Mac' : 'Any Git folder on this PC', '⌘O', () => app.command('open'), 'open'),
          action('download', 'Clone a repository', 'From GitHub, GitLab or any Git URL', '⌘⇧N', () => app.command('clone'), 'clone'),
          action('plus', 'Start a new repository', 'Create a folder with Git ready to go', '⌘⌥N', () => app.command('init'), 'init')),
        h('section', { class: 'w-col' }, legend('Recent'), recentList)),
      h('div', { class: 'w-drop' }, icon('plug', { size: 14 }), 'Drop a folder anywhere in this window to open it')));
}
