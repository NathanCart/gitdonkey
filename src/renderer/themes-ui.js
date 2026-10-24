// Themes: the picker (built-in themes and your own, applied as you click)
// and the theme builder (every colour, live on the app behind it, with an
// AI box that designs a theme from a description using the AI commit
// message provider).
//
// Both dock to the right with no scrim, so the window behind them shows the
// theme while you choose or edit it.
import { h, icon, clear, led } from './dom.js';
import { openModal, toast, promptDialog, confirmDialog, menuFromButton } from './ui.js';
import { invoke } from './api.js';
import { applyTheme } from './theme.js';
import { aiSettingsDialog } from './dialogs.js';
import {
  BUILT_IN, TOKENS, GROUPS, DEFAULT_THEME, completeColors, deriveShades, contrastReport, improveContrast,
  exportTheme, sanitizeTheme, themeId, normalizeColor, findTheme, schemeOf,
} from './lib/themes.js';

function dock(m) {
  m.overlay.classList.add('docked');
  return m;
}

/** A small picture of a theme: a panel with legends and a keycap beside a few graph lanes on the case. */
function swatch(colors) {
  const c = completeColors(colors);
  return h('span', { class: 'th-swatch', style: { background: c.case, borderColor: c['rule-2'] }, 'aria-hidden': 'true' },
    h('span', { class: 'th-sw-panel', style: { background: c.panel, borderColor: c.seam } },
      h('span', { class: 'th-sw-line', style: { background: c.legend } }),
      h('span', { class: 'th-sw-line short', style: { background: c['legend-3'] } }),
      h('span', { class: 'th-sw-key', style: { background: c.keycap } })),
    h('span', { class: 'th-sw-lanes' }, ['amber', 'cyan', 'red', 'violet', 'green'].map((k) => h('span', { style: { '--c': c[k] } }))));
}

async function copyCode(theme) {
  await invoke('clipboard:write', exportTheme(theme));
  toast({ type: 'success', title: 'Theme code copied', message: `Anyone can paste it into Themes → Import… to get “${theme.name}”.` });
}

async function importTheme(app) {
  let parsed = null;
  const code = await promptDialog({
    title: 'Import a theme',
    label: 'Theme code',
    placeholder: '{"gitdonkeyTheme":1,"name":…}',
    okLabel: 'Import',
    mono: true,
    hint: 'Paste the code from Copy theme code in someone’s GitDonkey.',
    validate: (v) => {
      try {
        parsed = sanitizeTheme(v);
        return null;
      } catch (e) {
        return e.message;
      }
    },
  });
  if (!code || !parsed) return null;
  const list = [...app.customThemes];
  const id = themeId(parsed.name, [...list.map((t) => t.id), ...BUILT_IN.map((t) => t.id)]);
  list.push({ id, name: parsed.name, colors: parsed.colors });
  app.saveCustomThemes(list);
  app.useTheme(id);
  toast({ type: 'success', title: `Imported “${parsed.name}”` });
  return id;
}

// ---------------------------------------------------------------- the picker

export function themesDialog(app) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'themes' });
    const cards = new Map();

    const markCurrent = () => {
      const cur = app.theme().id;
      for (const [id, el] of cards) {
        el.setAttribute('aria-pressed', String(id === cur));
      }
    };

    const choose = (t) => {
      app.useTheme(t.id);
      markCurrent();
    };

    const edit = async (opts) => {
      await themeBuilderDialog(app, opts);
      render();
    };

    const menuFor = (t, custom) => (custom ? [
      { label: 'Edit…', icon: 'pencil', run: () => edit({ editing: t }) },
      { label: 'Duplicate', icon: 'copy', run: () => {
        const list = [...app.customThemes];
        const name = `${t.name} copy`.slice(0, 40);
        list.push({ id: themeId(name, list.map((x) => x.id)), name, colors: { ...t.colors } });
        app.saveCustomThemes(list);
        render();
      } },
      { label: 'Copy theme code', icon: 'clipboard-paste', run: () => copyCode(t) },
      '-',
      { label: 'Delete…', icon: 'trash-2', danger: true, run: async () => {
        const yes = await confirmDialog({ title: 'Delete theme', message: `Delete “${t.name}”? You can’t undo this, unless you copied its theme code.`, okLabel: 'Delete', danger: true });
        if (!yes) return;
        app.saveCustomThemes(app.customThemes.filter((x) => x.id !== t.id));
        if (app.settings.theme === t.id) app.useTheme(DEFAULT_THEME);
        render();
      } },
    ] : [
      { label: 'Customise…', icon: 'pencil', run: () => edit({ base: t }) },
      { label: 'Copy theme code', icon: 'clipboard-paste', run: () => copyCode(t) },
    ]);

    const card = (t, custom = false) => {
      const el = h('button', {
        type: 'button',
        class: 'th-card',
        dataset: { theme: t.id },
        'aria-pressed': 'false',
        title: t.note || t.name,
        onClick: () => choose(t),
      }, swatch(t.colors), h('span', { class: 'th-name' }, t.name), h('span', { class: 'th-check' }, icon('check', { size: 12, stroke: 3 })));
      cards.set(t.id, el);
      const more = h('button', {
        type: 'button',
        class: 'icon-btn th-more',
        'aria-label': `More for ${t.name}`,
        title: custom ? 'Edit, duplicate, share or delete' : 'Customise or share',
        onClick: (e) => menuFromButton(e.currentTarget, menuFor(t, custom)),
      }, icon('ellipsis', { size: 14 }));
      return h('div', { class: 'th-item' }, el, more);
    };

    const section = (title, items) => h('section', { class: 'th-section', 'aria-label': title },
      h('div', { class: 'th-head' }, title), h('div', { class: 'th-grid' }, items));

    const render = () => {
      clear(body);
      cards.clear();
      const dark = BUILT_IN.filter((t) => schemeOf(completeColors(t.colors)) === 'dark');
      const light = BUILT_IN.filter((t) => schemeOf(completeColors(t.colors)) === 'light');
      const newCard = h('div', { class: 'th-item' }, h('button', {
        type: 'button',
        class: 'th-card th-new',
        onClick: () => edit({}),
      }, h('span', { class: 'th-swatch th-new-swatch' }, icon('plus', { size: 18 })), h('span', { class: 'th-name' }, 'New theme…')));
      body.append(
        section('Your themes', [...app.customThemes.map((t) => card(t, true)), newCard]),
        section('Dark', dark.map((t) => card(t))),
        section('Light', light.map((t) => card(t))),
      );
      markCurrent();
    };

    dock(openModal({
      title: 'Themes',
      width: 452,
      className: 'themes-modal',
      body,
      actions: [
        { label: 'Import…', run: async () => {
          if (await importTheme(app)) render();
        } },
        { label: 'Done', primary: true },
      ],
      onClose: () => resolve(),
    }));
    render();
    requestAnimationFrame(() => {
      const cur = cards.get(app.theme().id);
      if (cur) {
        cur.focus();
        cur.scrollIntoView({ block: 'nearest' });
      }
    });
  });
}

// ---------------------------------------------------------------- the builder

/**
 * Edit a theme with the app behind it as the preview.
 * `editing`: one of your themes, saved back in place. `base`: a theme to start
 * a new one from (the current theme when neither is given).
 */
export function themeBuilderDialog(app, { editing = null, base = null } = {}) {
  return new Promise((resolve) => {
    const start = editing || base || app.theme();
    let colors = completeColors(start.colors);
    let saved = false;
    let nameTouched = Boolean(editing);
    const isBuiltIn = (t) => BUILT_IN.some((b) => b.id === t.id);

    const nameInput = h('input', { class: 'input', value: editing ? editing.name : isBuiltIn(start) ? `My ${start.name}` : `${start.name} copy`, maxlength: '40', spellcheck: 'false', autocomplete: 'off', onInput: () => {
      nameTouched = true;
    } });

    // ------------------------------------------------ preview
    let frame = 0;
    const preview = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        applyTheme({ colors }, { remember: false });
        app.recolor();
      });
    };

    // ------------------------------------------------ colour rows
    const rows = {};
    const syncRow = (key, { keepHex = false } = {}) => {
      const r = rows[key];
      r.swatch.value = colors[key];
      if (!keepHex) r.hex.value = colors[key];
      r.hex.classList.remove('bad');
    };
    const set = (key, value, opts) => {
      colors = { ...colors, [key]: value };
      syncRow(key, opts);
      preview();
      report();
    };
    const setAll = (next) => {
      colors = completeColors(next);
      for (const t of TOKENS) syncRow(t.key);
      preview();
      report();
    };
    const row = (t) => {
      const sw = h('input', { type: 'color', class: 'tb-swatch', value: colors[t.key], 'aria-label': `${t.label} colour`, onInput: () => set(t.key, sw.value) });
      const hex = h('input', { class: 'input mono tb-hex', value: colors[t.key], maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${t.label} hex value`,
        onInput: () => {
          const v = normalizeColor(hex.value);
          hex.classList.toggle('bad', !v);
          if (v && v !== colors[t.key]) set(t.key, v, { keepHex: true });
        },
        onBlur: () => syncRow(t.key),
      });
      rows[t.key] = { swatch: sw, hex };
      return h('div', { class: 'tb-row', dataset: { token: t.key } },
        h('span', { class: 'tb-label' }, h('span', null, t.label), t.hint ? h('span', { class: 'tb-hint' }, t.hint) : null), sw, hex);
    };

    // ------------------------------------------------ readability
    const reportEl = h('div', { class: 'tb-report', role: 'status' });
    const fixBtn = h('button', { type: 'button', class: 'btn btn-small', onClick: () => {
      const r = improveContrast(colors);
      setAll(r.colors);
      aiSay(r.changed.length ? `Adjusted ${r.changed.length} colour${r.changed.length === 1 ? '' : 's'} so everything reads.` : '');
    } }, 'Fix readability');
    function report() {
      const fails = contrastReport(colors).filter((x) => !x.ok);
      clear(reportEl);
      if (!fails.length) {
        reportEl.append(h('p', { class: 'tb-report-line' }, led('green'), 'Everything is readable.'));
        fixBtn.hidden = true;
        return;
      }
      fixBtn.hidden = false;
      reportEl.append(
        h('p', { class: 'tb-report-line' }, led('amber'), `${fails.length} pair${fails.length === 1 ? ' is' : 's are'} hard to read`),
        h('ul', { class: 'tb-fails' }, fails.slice(0, 5).map((f) => h('li', null, h('span', null, f.label), h('span', { class: 'tb-ratio' }, `${f.ratio}:1, needs ${f.min}`)))),
      );
      if (fails.length > 5) reportEl.append(h('p', { class: 'tb-more' }, `and ${fails.length - 5} more`));
    }

    // ------------------------------------------------ AI
    const describe = h('input', { class: 'input', placeholder: 'Describe a theme: sunset, forest at dawn, 1980s arcade…', maxlength: '300', spellcheck: 'true', autocomplete: 'off' });
    const genLabel = h('span', null);
    const genBtn = h('button', { type: 'button', class: 'btn btn-small tb-generate' }, icon('sparkles', { size: 13 }), genLabel);
    const aiStatus = h('p', { class: 'tb-ai-status', role: 'status' });
    const aiSay = (text, bad = false) => {
      aiStatus.textContent = text;
      aiStatus.classList.toggle('bad', bad);
    };
    const syncAi = () => {
      const ai = app.aiConfig();
      genLabel.textContent = ai ? 'Generate' : 'Set up AI…';
      genBtn.title = ai ? `Design it with ${ai.label}` : 'Uses the same provider and key as AI commit messages';
    };
    let busy = false;
    const generate = async () => {
      if (busy) return;
      const ai = app.aiConfig();
      if (!ai) {
        await aiSettingsDialog(app);
        syncAi();
        return;
      }
      const description = describe.value.trim();
      if (!description) {
        aiSay('Describe the theme first, like “sunset” or “deep forest”.', true);
        describe.focus();
        return;
      }
      busy = true;
      genBtn.setAttribute('aria-busy', 'true');
      genLabel.textContent = 'Designing…';
      aiSay(`Asking ${ai.label}…`);
      try {
        const text = await invoke('ai:theme', { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, description });
        const t = sanitizeTheme(text);
        const fixed = improveContrast(t.colors);
        setAll(fixed.colors);
        if (!nameTouched) nameInput.value = t.name;
        aiSay(fixed.changed.length
          ? `Designed by ${ai.label}. GitDonkey adjusted ${fixed.changed.length} colour${fixed.changed.length === 1 ? '' : 's'} so text stays readable.`
          : `Designed by ${ai.label}. Tweak anything below, then save.`);
      } catch (e) {
        aiSay(e.message || 'That didn’t work. Try again.', true);
      } finally {
        busy = false;
        genBtn.removeAttribute('aria-busy');
        syncAi();
      }
    };
    genBtn.addEventListener('click', generate);
    describe.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
    });
    syncAi();

    // ------------------------------------------------ start from
    const startSelect = h('select', { class: 'input', 'aria-label': 'Start from a theme' },
      h('option', { value: '' }, 'Start from…'),
      h('optgroup', { label: 'Built in' }, BUILT_IN.map((t) => h('option', { value: t.id }, t.name))),
      app.customThemes.length ? h('optgroup', { label: 'Yours' }, app.customThemes.map((t) => h('option', { value: t.id }, t.name))) : null);
    startSelect.addEventListener('change', () => {
      if (!startSelect.value) return;
      const t = findTheme(startSelect.value, app.customThemes);
      setAll(t.colors);
      if (!nameTouched) nameInput.value = isBuiltIn(t) ? `My ${t.name}` : `${t.name} copy`;
      startSelect.value = '';
    });
    const deriveBtn = h('button', { type: 'button', class: 'btn btn-small', title: 'Recalculate panels, rules and text shades from Case and Legend', onClick: () => setAll({ ...colors, ...deriveShades(colors) }) }, 'Shades from Case + Legend');

    const body = h('div', { class: 'tb' },
      h('section', { class: 'tb-ai' },
        h('div', { class: 'tb-ai-row' }, describe, genBtn),
        aiStatus),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput),
      h('div', { class: 'tb-tools' }, startSelect, deriveBtn),
      GROUPS.map((g) => h('section', { class: 'tb-group', 'aria-label': g },
        h('div', { class: 'th-head' }, g),
        TOKENS.filter((t) => t.group === g).map(row))),
      h('section', { class: 'tb-group tb-read', 'aria-label': 'Readability' },
        h('div', { class: 'th-head' }, 'Readability'), reportEl, fixBtn));

    // Enter in a colour field applies it; it shouldn't save the whole theme.
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('tb-hex')) {
        e.preventDefault();
        e.target.blur();
      }
    });

    const m = dock(openModal({
      title: editing ? `Edit ${editing.name}` : 'Theme builder',
      width: 452,
      className: 'themes-modal theme-builder',
      dismissable: false,
      body,
      actions: [
        { label: 'Copy theme code', run: () => copyCode({ name: nameInput.value.trim() || 'Untitled theme', colors }) },
        { label: 'Cancel', run: (close) => close(null) },
        { label: editing ? 'Save' : 'Save theme', primary: true, run: (close) => {
          const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'My theme';
          const list = [...app.customThemes];
          let id;
          if (editing) {
            id = editing.id;
            const i = list.findIndex((t) => t.id === id);
            if (i === -1) list.push({ id, name, colors });
            else list[i] = { id, name, colors };
          } else {
            id = themeId(name, [...list.map((t) => t.id), ...BUILT_IN.map((t) => t.id)]);
            list.push({ id, name, colors });
          }
          app.saveCustomThemes(list);
          saved = true;
          app.useTheme(id);
          toast({ type: 'success', title: `Saved “${name}”`, message: 'It’s in Themes under Your themes.' });
          close(id);
        } },
      ],
      onClose: (id) => {
        cancelAnimationFrame(frame);
        // Cancelled: back to the theme that was chosen before.
        if (!saved) app.useTheme(app.settings.theme, { save: false });
        resolve(id || null);
      },
    }));
    m.el.querySelector('.modal-foot [data-action="Copy theme code"]').classList.add('tb-copy');
    report();
    preview();
  });
}
