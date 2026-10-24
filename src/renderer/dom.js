import { ICONS } from './lib/icons.js';
import { hashString, initials } from './lib/util.js';
import { avatarUrl, whenAvatar, avatarsEnabled } from './avatars.js';
import { markSvgBody } from './lib/logo-mark.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hyperscript: h('div', { class, style, dataset, onClick, ...attrs }, ...children) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function icon(name, { size = 16, stroke = 1.75, cls } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', stroke);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  if (cls) svg.classList.add(cls);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** The GitDonkey mark (see lib/logo-mark.js). */
export function logoMark(size = 32, { mono = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo-mark');
  svg.innerHTML = markSvgBody({ mono });
  return svg;
}

// The theme's cable colours, so author colours follow the theme.
const AVATAR_HUES = ['red', 'amber', 'cyan', 'green', 'violet', 'pink', 'blue', 'orange', 'teal', 'bone'].map((k) => `var(--${k})`);

export function authorColor(key) {
  return AVATAR_HUES[hashString(String(key || '').toLowerCase()) % AVATAR_HUES.length];
}

/**
 * Author avatar: the GitHub / Gravatar picture when one exists, an initials
 * disc in the author's colour while loading or when there is none, and the
 * plain pin LED when avatars are switched off.
 */
export function avatar(name, email, size = 18) {
  if (!avatarsEnabled()) return authorDot(name, email, Math.max(7, Math.round(size * 0.4)));
  const color = authorColor(email || name);
  const el = h('span', {
    class: 'avatar',
    style: { '--av': color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(7, Math.round(size * 0.42))}px` },
    title: email ? `${name} <${email}>` : name,
  }, initials(name));
  const show = (url) => {
    if (!url) return;
    el.textContent = '';
    el.classList.add('has-img');
    el.appendChild(h('img', { src: url, alt: '', draggable: 'false' }));
  };
  const known = avatarUrl(email);
  if (known) show(known);
  else if (known === undefined) whenAvatar(email).then(show);
  return el;
}

/** A small pin LED in the author's colour (used when avatars are off). */
export function authorDot(name, email, size = 7) {
  return h('span', { class: 'author-dot', style: { background: authorColor(email || name), width: `${size}px`, height: `${size}px` }, title: email ? `${name} <${email}>` : name });
}

/** Jack glyph used beside refs in the sidebar and pills. */
export function jack(color, { lit = false, size = 10 } = {}) {
  return h('span', { class: ['jack', lit && 'lit'], style: { '--jack': color, width: `${size}px`, height: `${size}px` } });
}

export function led(state = 'off', title) {
  return h('span', { class: ['led', `led-${state}`], title });
}

export function legend(text, extra) {
  return h('span', { class: ['legend', extra] }, text);
}

const STATUS_ICON = { M: 'file-pen-line', A: 'file-plus', '?': 'file-plus', D: 'file-minus', R: 'arrow-right', C: 'copy', T: 'file', U: 'triangle-alert' };
const STATUS_LABEL = { M: 'Modified', A: 'Added', '?': 'Untracked', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflicted' };

export function statusBadge(status) {
  const s = status || 'M';
  return h('span', { class: ['st', `st-${s === '?' ? 'N' : s}`], title: STATUS_LABEL[s] || s }, icon(STATUS_ICON[s] || 'file', { size: 14 }));
}

export function kbd(text) {
  return h('kbd', null, text);
}

export function onOutside(el, cb) {
  const handler = (e) => {
    if (!el.contains(e.target)) cb(e);
  };
  setTimeout(() => document.addEventListener('mousedown', handler, true), 0);
  return () => document.removeEventListener('mousedown', handler, true);
}
