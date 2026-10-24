// Shared UI primitives: toasts, modal dialogs, context menus.
import { h, icon, clear, led } from './dom.js';

const layer = () => document.getElementById('layer');

// ---------------------------------------------------------------- toasts

let toastStack = null;

function toasts() {
  if (!toastStack) {
    toastStack = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

/** Seat a card someone else manages (it carries .toast-pinned) in the toast stack. */
export function mountToast(el) {
  toasts().appendChild(el);
}

export function toast({ type = 'info', title, message, detail, actions = [], timeout } = {}) {
  toasts();
  const ledState = { success: 'green', error: 'red', warn: 'amber', info: 'cyan' }[type] || 'cyan';
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 90);
  };
  const el = h('div', { class: ['toast', `toast-${type}`] },
    h('div', { class: 'toast-head' },
      led(ledState),
      h('div', { class: 'toast-title' }, title || ''),
      h('button', { class: 'icon-btn toast-x', title: 'Dismiss', 'aria-label': 'Dismiss', onClick: close }, icon('x', { size: 14 }))),
    message ? h('div', { class: 'toast-msg' }, message) : null,
    detail ? h('pre', { class: 'toast-detail' }, detail) : null,
    actions.length
      ? h('div', { class: 'toast-actions' }, actions.map((a) => h('button', {
          class: ['btn', 'btn-small', a.primary && 'btn-key'],
          onClick: async () => {
            close();
            await a.run();
          },
        }, a.label)))
      : null);
  toastStack.appendChild(el);
  const passing = [...toastStack.children].filter((c) => !c.classList.contains('toast-pinned'));
  while (passing.length > 5) passing.shift().remove();
  const ms = timeout ?? (type === 'error' ? 12000 : type === 'warn' ? 8000 : 4500);
  if (ms > 0) {
    timer = setTimeout(close, ms);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      timer = setTimeout(close, 3000);
    });
  }
  return { close };
}

// ---------------------------------------------------------------- modals

const modalStack = [];

export function openModal({ title, body, actions = [], width = 460, onClose, className, dismissable = true }) {
  closeMenus();
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    modalStack.splice(modalStack.indexOf(api), 1);
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose(result);
  };
  const buttons = actions.map((a) => h('button', {
    class: ['btn', a.primary && 'btn-key', a.danger && 'btn-danger'],
    type: a.primary ? 'submit' : 'button',
    dataset: { action: a.id || a.label },
    disabled: a.disabled,
    onClick: (e) => {
      if (a.primary) return; // handled by submit
      e.preventDefault();
      a.run ? a.run(close) : close(null);
    },
  }, a.label));
  const primary = actions.find((a) => a.primary);
  const form = h('form', {
    class: ['modal', className],
    style: { width: `min(${width}px, calc(100vw - 48px))` },
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    onSubmit: (e) => {
      e.preventDefault();
      if (primary && primary.run) primary.run(close);
      else close(true);
    },
  },
  h('div', { class: 'module-head' }, h('span', { class: 'legend' }, title)),
  h('div', { class: 'modal-body' }, body),
  buttons.length ? h('div', { class: 'modal-foot' }, buttons) : null);
  const overlay = h('div', {
    class: 'overlay',
    onMousedown: (e) => {
      if (e.target === overlay && dismissable) close(null);
    },
  }, form);
  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissable) {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  layer().appendChild(overlay);
  const api = { close, el: form, overlay, buttons };
  modalStack.push(api);
  requestAnimationFrame(() => {
    // Never steal focus from a field the user (or a test) is already typing in.
    if (form.contains(document.activeElement)) return;
    const first = form.querySelector('[autofocus], input:not([type=checkbox]):not([disabled]), textarea, select');
    if (first) {
      first.focus();
      if (first.select && first.dataset.select !== 'no') first.select();
    } else {
      const p = form.querySelector('.btn-key') || form.querySelector('button');
      if (p) p.focus();
    }
  });
  return api;
}

export function hasOpenModal() {
  return modalStack.length > 0;
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK', validate, hint, mono = false }) {
  return new Promise((resolve) => {
    const input = h('input', { class: ['input', mono && 'mono'], value, placeholder, spellcheck: 'false', autocomplete: 'off' });
    const err = h('div', { class: 'field-error', role: 'alert' });
    const m = openModal({
      title,
      body: h('div', { class: 'stack' }, field(label, input, hint), err),
      actions: [
        { label: 'Cancel', run: (close) => close(null) },
        {
          label: okLabel,
          primary: true,
          run: async (close) => {
            const v = input.value.trim();
            const problem = validate ? await validate(v) : v ? null : 'Required';
            if (problem) {
              err.textContent = problem;
              input.focus();
              return;
            }
            close(v);
          },
        },
      ],
      onClose: (r) => resolve(r ?? null),
    });
    input.addEventListener('input', () => {
      err.textContent = '';
    });
    return m;
  });
}

export function confirmDialog({ title, message, okLabel = 'Confirm', danger = false, detail }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: h('div', { class: 'stack' }, h('p', { class: 'modal-text' }, message), detail ? h('pre', { class: 'modal-detail' }, detail) : null),
      actions: [
        { label: 'Cancel', run: (close) => close(false) },
        { label: okLabel, primary: true, danger, run: (close) => close(true) },
      ],
      onClose: (r) => resolve(Boolean(r)),
    });
  });
}

export function choiceDialog({ title, message, choices, detail }) {
  return new Promise((resolve) => {
    openModal({
      title,
      width: 500,
      body: h('div', { class: 'stack' }, h('p', { class: 'modal-text' }, message), detail ? h('pre', { class: 'modal-detail' }, detail) : null),
      actions: [
        { label: 'Cancel', run: (close) => close(null) },
        ...choices.map((c) => ({ label: c.label, danger: c.danger, run: (close) => close(c.id) })),
      ],
      onClose: (r) => resolve(r ?? null),
    });
  });
}

/**
 * fields: [{ name, label, type: 'text'|'textarea'|'checkbox'|'select'|'folder', value, placeholder, options:[{value,label}], hint, mono }]
 */
export function formDialog({ title, fields, okLabel = 'OK', validate, width = 480, onChange, pickFolder, intro, extra }) {
  return new Promise((resolve) => {
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'textarea') input = h('textarea', { class: ['input', f.mono && 'mono'], rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: 'false' }, f.value || '');
      else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', checked: f.value });
        inputs[f.name] = input;
        return h('label', { class: 'check' }, input, h('span', { class: 'check-box' }, icon('check', { size: 12, stroke: 3 })), h('span', null, f.label), f.hint ? h('span', { class: 'field-hint' }, f.hint) : null);
      } else if (f.type === 'select') {
        input = h('select', { class: 'input' }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      } else if (f.type === 'password') {
        input = h('input', { class: 'input', type: 'password', value: f.value || '', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
      } else {
        input = h('input', { class: ['input', f.mono && 'mono'], value: f.value || '', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off', 'data-select': f.select === false ? 'no' : undefined });
      }
      inputs[f.name] = input;
      if (f.type === 'folder') {
        return field(f.label, h('div', { class: 'input-row' }, input, h('button', {
          type: 'button',
          class: 'btn',
          onClick: async () => {
            const p = await pickFolder(input.value);
            if (p) {
              input.value = p;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          },
        }, 'Browse…')), f.hint);
      }
      return field(f.label, input, f.hint);
    });
    const err = h('div', { class: 'field-error', role: 'alert' });
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    const m = openModal({
      title,
      width,
      body: h('div', { class: 'stack' }, intro || null, rows, extra || null, err),
      actions: [
        { label: 'Cancel', run: (close) => close(null) },
        {
          label: okLabel,
          primary: true,
          run: async (close) => {
            const v = values();
            const problem = validate ? await validate(v) : null;
            if (problem) {
              err.textContent = problem;
              return;
            }
            close(v);
          },
        },
      ],
      onClose: (r) => resolve(r ?? null),
    });
    m.el.addEventListener('input', () => {
      err.textContent = '';
      if (onChange) onChange(values(), inputs);
    });
    if (onChange) onChange(values(), inputs);
  });
}

// ---------------------------------------------------------------- context menus

let openMenus = [];
let menuCleanup = null;

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  if (menuCleanup) menuCleanup();
  menuCleanup = null;
}

function buildMenu(items, depth) {
  const menu = h('div', { class: 'menu', role: 'menu' });
  const rows = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.header) {
      menu.appendChild(h('div', { class: 'menu-header' }, it.header));
      continue;
    }
    const row = h('button', {
      class: ['menu-item', it.danger && 'danger', it.checked && 'checked'],
      role: 'menuitem',
      type: 'button',
      disabled: it.disabled,
      onClick: (e) => {
        e.stopPropagation();
        if (it.submenu) return;
        closeMenus();
        if (it.run) it.run();
      },
    },
    h('span', { class: 'menu-icon' }, it.icon ? icon(it.icon, { size: 14 }) : it.checked ? icon('check', { size: 14 }) : null),
    h('span', { class: 'menu-label' }, it.label),
    it.shortcut ? h('span', { class: 'menu-key' }, it.shortcut) : null,
    it.submenu ? h('span', { class: 'menu-chev' }, icon('chevron-right', { size: 12 })) : null);
    if (it.submenu) {
      let sub = null;
      const openSub = () => {
        for (const m of openMenus.slice(depth + 1)) m.remove();
        openMenus = openMenus.slice(0, depth + 1);
        sub = buildMenu(it.submenu, depth + 1);
        const r = row.getBoundingClientRect();
        place(sub, r.right - 2, r.top - 5, r.left);
      };
      row.addEventListener('mouseenter', openSub);
      row.addEventListener('click', openSub);
    } else {
      row.addEventListener('mouseenter', () => {
        for (const m of openMenus.slice(depth + 1)) m.remove();
        openMenus = openMenus.slice(0, depth + 1);
      });
    }
    rows.push(row);
    menu.appendChild(row);
  }
  menu.addEventListener('keydown', (e) => {
    const enabled = rows.filter((r) => !r.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      enabled[(i + 1) % enabled.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'ArrowRight' && document.activeElement?.querySelector('.menu-chev')) {
      document.activeElement.click();
      openMenus[depth + 1]?.querySelector('.menu-item:not([disabled])')?.focus();
    } else if (e.key === 'ArrowLeft' && depth > 0) {
      e.preventDefault();
      openMenus[depth].remove();
      openMenus = openMenus.slice(0, depth);
    }
  });
  openMenus.push(menu);
  layer().appendChild(menu);
  return menu;
}

function place(menu, x, y, altX) {
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  let top = y;
  if (left + r.width > vw - 6) left = altX !== undefined ? altX - r.width + 2 : vw - r.width - 6;
  if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}

export function contextMenu(x, y, items) {
  closeMenus();
  const list = items.filter(Boolean);
  // Trim leading/trailing/double separators.
  const clean = list.filter((it, i) => it !== '-' || (i > 0 && i < list.length - 1 && list[i - 1] !== '-'));
  if (!clean.length) return;
  const menu = buildMenu(clean, 0);
  place(menu, x, y);
  const onDown = (e) => {
    if (!openMenus.some((m) => m.contains(e.target))) closeMenus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenus();
    }
  };
  const onBlur = () => closeMenus();
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  }, 0);
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
  };
}

export function menuFromButton(button, items) {
  const r = button.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 4, items);
}

export { clear };
