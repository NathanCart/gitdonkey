import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  BUILT_IN, KEYS, CABLES, LANE_ORDER, THEME_BY_ID, DEFAULT_THEME, parseColor, mix, contrast, schemeOf, completeColors, deriveShades,
  resolveTheme, lanePalette, contrastReport, improveContrast, exportTheme, sanitizeTheme, themeId, findTheme,
} from '../../src/renderer/lib/themes.js';
import { computeGraph, setPalette } from '../../src/renderer/lib/graph-layout.js';

const require = createRequire(import.meta.url);
const { buildThemePrompt, THEME_KEYS } = require('../../src/main/ai.js');

test('themes: colour maths', () => {
  assert.deepEqual(parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc });
  assert.equal(parseColor('nope'), null);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
});

test('themes: every built-in theme is complete, unique and readable', () => {
  assert.ok(BUILT_IN.length >= 20);
  assert.equal(new Set(BUILT_IN.map((t) => t.id)).size, BUILT_IN.length);
  assert.ok(THEME_BY_ID[DEFAULT_THEME]);
  assert.ok(BUILT_IN.some((t) => resolveTheme(t).scheme === 'light'), 'has light themes');
  for (const t of BUILT_IN) {
    const r = resolveTheme(t);
    assert.deepEqual(Object.keys(r.colors).sort(), [...KEYS].sort(), t.name);
    for (const v of Object.values(r.colors)) assert.match(v, /^#[0-9a-f]{6}$/, t.name);
    for (const k of ['--panel-5', '--rule-3', '--legend-hi', '--legend-dim', '--legend-off', '--shadow', '--scrim']) assert.ok(r.vars[k], `${t.name} ${k}`);
    const fails = contrastReport(t.colors).filter((x) => !x.ok);
    assert.deepEqual(fails, [], `${t.name} has unreadable pairs`);
    assert.equal(new Set(CABLES.map((k) => r.colors[k])).size, CABLES.length, `${t.name} cables are distinct`);
  }
});

test('themes: the default theme is exactly the stylesheet it replaces', () => {
  const c = resolveTheme(THEME_BY_ID['patch-bay']).colors;
  assert.equal(c.case, '#0b0c0e');
  assert.equal(c.legend, '#ece8df');
  assert.deepEqual(lanePalette(c).slice(0, 3), ['#ffb627', '#36c3d0', '#ff5a3c']);
});

test('themes: missing colours are worked out, light or dark', () => {
  const dark = completeColors({ case: '#101820', legend: '#e8eef4' });
  assert.equal(schemeOf(dark), 'dark');
  assert.ok(contrast(dark['legend-3'], dark['panel-2']) >= 4.5);
  const light = completeColors({ case: '#ffffff', legend: '#202020' });
  assert.equal(schemeOf(light), 'light');
  assert.ok(contrast(light['keycap-ink'], light.keycap) >= 4.5);
  const s = deriveShades({ case: '#0b0c0e', legend: '#ece8df' });
  assert.ok(contrast(s.panel, '#0b0c0e') < contrast(s['panel-4'], '#0b0c0e'), 'panels step away from the case');
});

test('themes: improveContrast fixes what the report flags and leaves good themes alone', () => {
  const bad = { ...THEME_BY_ID['studio-paper'].colors, legend: '#d9d2c4', amber: '#fff3c0' };
  assert.ok(contrastReport(bad).some((x) => !x.ok));
  const { colors, changed } = improveContrast(bad);
  assert.deepEqual(contrastReport(colors).filter((x) => !x.ok), []);
  assert.ok(changed.includes('legend') && changed.includes('amber'));
  assert.deepEqual(improveContrast(THEME_BY_ID.nord.colors).changed, []);
});

test('themes: codes round-trip, and junk is refused with a reason', () => {
  const t = { name: 'Round Trip', colors: THEME_BY_ID.dracula.colors };
  const back = sanitizeTheme(exportTheme(t));
  assert.equal(back.name, 'Round Trip');
  assert.deepEqual(back.colors, completeColors(t.colors));
  // Fenced, chatty AI replies and CSS-variable names are fine.
  const ai = sanitizeTheme('Here you go:\n```json\n{"name":"Dusk","colors":{"--case":"#112233","legend":"#EEEEEE","bogus":"red"}}\n```');
  assert.equal(ai.name, 'Dusk');
  assert.equal(ai.colors.case, '#112233');
  assert.equal(ai.colors.legend, '#eeeeee');
  assert.ok(!('bogus' in ai.colors));
  assert.throws(() => sanitizeTheme('hello'), /isn’t a theme code/);
  assert.throws(() => sanitizeTheme('{"colors":{"case":"#000"}}'), /Case and a Legend/);
  assert.throws(() => sanitizeTheme('{"case": "#000", }'), /incomplete/);
});

test('themes: ids and lookups', () => {
  assert.equal(themeId('Sunset Strip'), 'custom-sunset-strip');
  assert.equal(themeId('Sunset Strip', ['custom-sunset-strip']), 'custom-sunset-strip-2');
  assert.equal(findTheme('nope').id, DEFAULT_THEME);
  assert.equal(findTheme('custom-x', [{ id: 'custom-x', name: 'X', colors: {} }]).name, 'X');
});

test('themes: graph lanes take the theme’s cables', () => {
  const nord = resolveTheme(THEME_BY_ID.nord).colors;
  setPalette(lanePalette(nord));
  const g = computeGraph([{ hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }]);
  assert.equal(g.rows[0].color, nord[LANE_ORDER[0]]);
  setPalette(lanePalette(resolveTheme(THEME_BY_ID[DEFAULT_THEME]).colors));
});

test('AI themes: the prompt names every colour the renderer knows', () => {
  assert.deepEqual(THEME_KEYS, KEYS);
  const p = buildThemePrompt('  sunset over the sea  ');
  assert.equal(p.user, 'Theme: sunset over the sea');
  for (const k of KEYS) assert.ok(p.system.includes(k), k);
  assert.match(p.system, /JSON only/);
});
