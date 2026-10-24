// Themes: the 24 colours a theme sets, the built-in themes, and the maths
// that turns a theme into CSS custom properties.
//
// A theme only stores its base colours. Everything else the stylesheet needs
// (hover steps, the brightest legend, shadows, the modal scrim, tints) is
// worked out from those here or with color-mix() in styles.css, so a theme
// can't forget one.

export const TOKENS = [
  { key: 'case', label: 'Case', hint: 'The deepest layer: graph, inputs, wells', group: 'Panels' },
  { key: 'panel', label: 'Panel', hint: 'Sidebars and modules', group: 'Panels' },
  { key: 'panel-2', label: 'Raised', hint: 'Module heads, menus, toasts', group: 'Panels' },
  { key: 'panel-3', label: 'Hover', group: 'Panels' },
  { key: 'panel-4', label: 'Pressed', group: 'Panels' },
  { key: 'seam', label: 'Seam', hint: 'The 1px gaps between modules', group: 'Panels' },
  { key: 'rule', label: 'Rule', group: 'Panels' },
  { key: 'rule-2', label: 'Strong rule', hint: 'Borders of fields and keys', group: 'Panels' },
  { key: 'legend', label: 'Legend', hint: 'Main text', group: 'Text' },
  { key: 'legend-2', label: 'Secondary', group: 'Text' },
  { key: 'legend-3', label: 'Muted', hint: 'Hints and meta text', group: 'Text' },
  { key: 'keycap', label: 'Keycap', hint: 'Primary buttons and highlights', group: 'Keys' },
  { key: 'keycap-hover', label: 'Keycap hover', group: 'Keys' },
  { key: 'keycap-ink', label: 'Keycap ink', hint: 'Text on keycaps and lit plugs', group: 'Keys' },
  { key: 'red', label: 'Red', hint: 'Deletions, errors, danger', group: 'Cables' },
  { key: 'amber', label: 'Amber', hint: 'Current branch, focus, selection', group: 'Cables' },
  { key: 'cyan', label: 'Cyan', hint: 'Info, behind upstream', group: 'Cables' },
  { key: 'green', label: 'Green', hint: 'Additions, success', group: 'Cables' },
  { key: 'violet', label: 'Violet', group: 'Cables' },
  { key: 'pink', label: 'Pink', group: 'Cables' },
  { key: 'blue', label: 'Blue', group: 'Cables' },
  { key: 'orange', label: 'Orange', group: 'Cables' },
  { key: 'teal', label: 'Teal', group: 'Cables' },
  { key: 'bone', label: 'Bone', group: 'Cables' },
];
export const KEYS = TOKENS.map((t) => t.key);
export const GROUPS = ['Panels', 'Text', 'Keys', 'Cables'];
export const CABLES = ['red', 'amber', 'cyan', 'green', 'violet', 'pink', 'blue', 'orange', 'teal', 'bone'];
// Graph lanes alternate warm and cool so neighbouring lanes never blur together.
export const LANE_ORDER = ['amber', 'cyan', 'red', 'violet', 'green', 'pink', 'blue', 'orange', 'teal', 'bone'];
export const DEFAULT_THEME = 'patch-bay';

// ---------------------------------------------------------------- colour maths

/** `#rgb` or `#rrggbb` (any case) as { r, g, b } 0–255, or null. */
export function parseColor(value) {
  const m = String(value || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

export function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Normalise to lower-case #rrggbb, or null. */
export function normalizeColor(value) {
  const c = parseColor(value);
  return c ? toHex(c) : null;
}

/** `a` moved towards `b` by `t` (0–1), in sRGB. */
export function mix(a, b, t) {
  const x = parseColor(a);
  const y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** WCAG relative luminance. */
export function luminance(value) {
  const c = parseColor(value);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function schemeOf(colors) {
  return luminance(colors.case) > 0.35 ? 'light' : 'dark';
}

// ---------------------------------------------------------------- filling in a theme

/** Move `fg` towards `toward` until it reaches `min` contrast on `bg` (or gets there). */
function atLeast(fg, bg, min, toward) {
  let c = fg;
  for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = mix(c, toward, 0.08);
  return c;
}

/**
 * The panel ramp, rules and text shades worked out from Case and Legend, the
 * way the default theme is built: each step is a little more of the legend
 * mixed into the case.
 */
export function deriveShades({ case: base, legend }) {
  const light = luminance(base) > 0.35;
  const step = (t) => mix(base, legend, t);
  const panel2 = step(0.065);
  return {
    panel: step(0.035),
    'panel-2': panel2,
    'panel-3': step(0.1),
    'panel-4': step(0.15),
    seam: light ? step(0.24) : mix(base, '#000000', 0.62),
    rule: step(0.11),
    'rule-2': step(0.19),
    'legend-2': atLeast(mix(legend, base, 0.3), panel2, 6, legend),
    'legend-3': atLeast(mix(legend, base, 0.42), panel2, 4.6, legend),
  };
}

function deriveKeys({ case: base, legend, keycap }) {
  const cap = keycap || legend;
  const light = luminance(cap) > 0.35;
  const dark = '#0e0f11';
  const ink = contrast(base, cap) >= 7 ? base : contrast('#ffffff', cap) > contrast(dark, cap) ? '#ffffff' : dark;
  return {
    keycap: cap,
    'keycap-hover': light ? mix(cap, '#ffffff', 0.6) : mix(cap, base, 0.2),
    'keycap-ink': ink,
  };
}

/** Every base colour, filling any that `colors` leaves out from its case, legend and keycap. */
export function completeColors(colors) {
  const c = {};
  for (const k of KEYS) {
    const v = normalizeColor(colors && colors[k]);
    if (v) c[k] = v;
  }
  if (!c.case) c.case = '#0b0c0e';
  if (!c.legend) c.legend = luminance(c.case) > 0.35 ? '#1d1c1a' : '#ece8df';
  const shades = deriveShades(c);
  const keys = deriveKeys(c);
  const fallbackCables = luminance(c.case) > 0.35 ? THEME_BY_ID['studio-paper'].colors : THEME_BY_ID['patch-bay'].colors;
  const out = {};
  for (const k of KEYS) out[k] = c[k] || shades[k] || keys[k] || fallbackCables[k];
  return out;
}

/** Tokens the stylesheet needs on top of the base colours. */
export function derivedTokens(colors) {
  const light = schemeOf(colors) === 'light';
  const step = (t) => mix(colors.case, colors.legend, t);
  return {
    'panel-5': step(0.21),
    'rule-3': step(0.27),
    'legend-hi': light ? mix(colors.legend, '#000000', 0.6) : mix(colors.legend, '#ffffff', 0.7),
    'legend-dim': mix(colors.legend, colors.case, 0.5),
    'legend-off': mix(colors.legend, colors.case, 0.66),
    shadow: light ? 'rgba(24, 22, 30, 0.32)' : 'rgba(0, 0, 0, 1)',
    scrim: light ? 'rgba(28, 27, 32, 0.34)' : hexToRgba(colors.seam, 0.66),
  };
}

function hexToRgba(value, a) {
  const c = parseColor(value);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** A theme as everything the app applies: scheme, base colours and CSS custom properties. */
export function resolveTheme(theme) {
  const colors = completeColors(theme && theme.colors);
  const scheme = schemeOf(colors);
  const vars = {};
  for (const [k, v] of Object.entries(colors)) vars[`--${k}`] = v;
  for (const [k, v] of Object.entries(derivedTokens(colors))) vars[`--${k}`] = v;
  return { id: theme && theme.id, name: (theme && theme.name) || 'Untitled', scheme, colors, vars };
}

export function lanePalette(colors) {
  return LANE_ORDER.map((k) => colors[k]);
}

// ---------------------------------------------------------------- readability

/**
 * The pairs that have to stay readable, worst first. `min` is WCAG AA for
 * text (4.5), and 3 for cables, which are lanes, LEDs and syntax colours.
 */
export function contrastReport(colors) {
  const c = completeColors(colors);
  const checks = [
    ['Legend on Panel', c.legend, c.panel, 7],
    ['Legend on Case', c.legend, c.case, 7],
    ['Secondary on Raised', c['legend-2'], c['panel-2'], 4.5],
    ['Muted on Raised', c['legend-3'], c['panel-2'], 4.5],
    ['Muted on Panel', c['legend-3'], c.panel, 4.5],
    ['Keycap ink on Keycap', c['keycap-ink'], c.keycap, 4.5],
    ['Keycap on Panel', c.keycap, c.panel, 3],
  ];
  for (const k of CABLES) {
    const label = TOKENS.find((t) => t.key === k).label;
    checks.push([`${label} on Case`, c[k], c.case, 3]);
    checks.push([`${label} on Raised`, c[k], c['panel-2'], 3]);
    checks.push([`Keycap ink on ${label}`, c['keycap-ink'], c[k], 3]);
  }
  return checks
    .map(([label, fg, bg, min]) => ({ label, ratio: Math.round(contrast(fg, bg) * 10) / 10, min, ok: contrast(fg, bg) >= min }))
    .sort((a, b) => a.ratio / a.min - b.ratio / b.min);
}

/**
 * The same colours with every failing pair in contrastReport() nudged just
 * far enough to pass: text and cables move away from the background, and
 * keycap ink flips to whichever of near-black or white reads better.
 * Returns { colors, changed } where `changed` lists the keys it moved.
 */
export function improveContrast(colors) {
  const c = completeColors(colors);
  const before = { ...c };
  // Away from the background it has to read on: towards black on a light one, white on a dark one.
  const away = (bg) => (luminance(bg) > 0.18 ? '#000000' : '#ffffff');
  const worst = (fg, bgs) => bgs.reduce((a, b) => (contrast(fg, a) < contrast(fg, b) ? a : b));
  const lift = (key, bgs, min) => {
    for (let i = 0; i < 3; i++) {
      const bg = worst(c[key], bgs.map((b) => c[b]));
      c[key] = atLeast(c[key], bg, min, away(bg));
    }
  };
  lift('legend', ['panel', 'case'], 7);
  lift('legend-2', ['panel-2'], 4.5);
  lift('legend-3', ['panel', 'panel-2'], 4.6);
  for (const k of CABLES) lift(k, ['case', 'panel-2'], 3);
  const inkFor = (bg) => (contrast('#ffffff', bg) > contrast('#0e0f11', bg) ? '#ffffff' : '#0e0f11');
  if (contrast(c['keycap-ink'], c.keycap) < 4.5) c['keycap-ink'] = inkFor(c.keycap);
  if (contrast(c.keycap, c.panel) < 3) c.keycap = atLeast(c.keycap, c.panel, 3, away(c.panel));
  const changed = KEYS.filter((k) => c[k] !== before[k]);
  return { colors: c, changed };
}

// ---------------------------------------------------------------- sharing

const CODE_VERSION = 1;

/** A theme as text someone can paste into their own GitDonkey. */
export function exportTheme(theme) {
  return JSON.stringify({ gitdonkeyTheme: CODE_VERSION, name: theme.name, colors: completeColors(theme.colors) });
}

/**
 * A pasted or AI-written theme, checked: a name and only known colours, as
 * #rrggbb. Missing colours are filled in. Throws an Error that says what's
 * wrong.
 */
export function sanitizeTheme(input) {
  let data = input;
  if (typeof input === 'string') {
    const text = input.trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('That isn’t a theme code. It should start with {.');
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('That theme code is incomplete or damaged. Copy it again.');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That isn’t a theme.');
  const raw = data.colors && typeof data.colors === 'object' ? data.colors : data;
  const colors = {};
  for (const k of KEYS) {
    const v = normalizeColor(raw[k] ?? raw[`--${k}`]);
    if (v) colors[k] = v;
  }
  if (!colors.case || !colors.legend) throw new Error('A theme needs at least a Case and a Legend colour.');
  const name = String(data.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Untitled theme';
  return { name, colors: completeColors(colors) };
}

export function themeId(name, taken = []) {
  const slug = String(name || 'theme').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'theme';
  let id = `custom-${slug}`;
  for (let n = 2; taken.includes(id); n++) id = `custom-${slug}-${n}`;
  return id;
}

// ---------------------------------------------------------------- built-in themes

const cables = (red, amber, cyan, green, violet, pink, blue, orange, teal, bone) => ({ red, amber, cyan, green, violet, pink, blue, orange, teal, bone });

export const BUILT_IN = [
  // ------------------------------------------------ GitDonkey originals
  {
    id: 'patch-bay',
    name: 'Patch Bay',
    note: 'Matte black ply and patch cables. The original.',
    colors: {
      case: '#0b0c0e', panel: '#131417', 'panel-2': '#191a1e', 'panel-3': '#202227', 'panel-4': '#292b31',
      seam: '#040405', rule: '#24262b', 'rule-2': '#31343a',
      legend: '#ece8df', 'legend-2': '#aaa69e', 'legend-3': '#8e8a81',
      keycap: '#ece8df', 'keycap-hover': '#ffffff', 'keycap-ink': '#0e0f11',
      ...cables('#ff5a3c', '#ffb627', '#36c3d0', '#86d05a', '#a07cff', '#ff6fae', '#4c8dff', '#ff8a3d', '#2fd4a3', '#d9d4c7'),
    },
  },
  {
    id: 'studio-paper',
    name: 'Studio Paper',
    note: 'Warm off-white, like a printed front panel.',
    colors: {
      case: '#fcfaf5', legend: '#24221e', keycap: '#24221e',
      ...cables('#c2361d', '#9a6200', '#0d7c88', '#3d7a1c', '#6a4bc8', '#bb2a6c', '#2556c4', '#b04c0c', '#0d7a5f', '#6b6558'),
    },
  },
  {
    id: 'eurorack-silver',
    name: 'Eurorack Silver',
    note: 'Brushed aluminium and black legends.',
    colors: {
      case: '#f3f5f7', legend: '#1b1f25', keycap: '#1b1f25',
      ...cables('#c4302b', '#9c6500', '#08788c', '#2f7a2f', '#5f4fcf', '#b8306f', '#1f5fc8', '#b14f00', '#08796b', '#5d6470'),
    },
  },
  {
    id: 'hay-bale',
    name: 'Hay Bale',
    note: 'Straw yellow and barn red. The donkey’s favourite.',
    colors: {
      case: '#fbf3dc', legend: '#2f2513', keycap: '#8f2a19',
      ...cables('#b32d17', '#8a5c00', '#1a6f7a', '#4b7015', '#6d4aa8', '#a8325f', '#2f5aa8', '#a54a0a', '#1b7058', '#6e5d3e'),
    },
  },
  {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    note: 'Phosphor green on a black screen.',
    colors: {
      case: '#040806', legend: '#c7f7d4', keycap: '#5dff8f', 'keycap-ink': '#03140a',
      ...cables('#ff6a5a', '#e6f05a', '#4fe3e3', '#5dff8f', '#b49cff', '#ff8fd0', '#62a8ff', '#ffa45a', '#3cf0b4', '#b9e8c6'),
    },
  },
  {
    id: 'amber-crt',
    name: 'Amber CRT',
    note: 'An old terminal that runs warm.',
    colors: {
      case: '#0d0904', legend: '#ffd59a', keycap: '#ffb000', 'keycap-ink': '#1a0f00',
      ...cables('#ff6b4a', '#ffb000', '#5fd6d0', '#a8d65a', '#c79bff', '#ff8cb8', '#7fa8ff', '#ff8c2e', '#4fd6a8', '#e8cfa6'),
    },
  },
  {
    id: 'tape-deck',
    name: 'Tape Deck',
    note: 'Walnut veneer, cream labels, 1974.',
    colors: {
      case: '#17110d', legend: '#f2e6cf', keycap: '#e8833a', 'keycap-ink': '#1a0f08',
      ...cables('#e5553b', '#e8b33a', '#4fbcb4', '#9cc25a', '#b391e0', '#e88aa8', '#6f9ee6', '#e8833a', '#47b894', '#d9c8a8'),
    },
  },
  {
    id: 'neon-arcade',
    name: 'Neon Arcade',
    note: 'Synthwave purple with hot pink and cyan.',
    colors: {
      case: '#110821', legend: '#f6eaff', keycap: '#ff3fa4', 'keycap-ink': '#16051f',
      ...cables('#ff4f6d', '#ffd23f', '#2de2e6', '#7cff6b', '#b98cff', '#ff3fa4', '#5c8dff', '#ff8f3f', '#2ff0c0', '#e6d6f5'),
    },
  },
  {
    id: 'deep-sea',
    name: 'Deep Sea',
    note: 'Navy, foam and coral.',
    colors: {
      case: '#06121c', legend: '#d8edf4', keycap: '#7fe0e8', 'keycap-ink': '#04121a',
      ...cables('#ff7a6b', '#ffcf5c', '#56d8e6', '#8fe08a', '#a99bff', '#ff8fc0', '#5aa5ff', '#ff9f5a', '#45dcb4', '#c7dbe2'),
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    note: 'Pure black, white legends, the brightest cables.',
    colors: {
      case: '#000000', panel: '#0a0a0a', 'panel-2': '#141414', 'panel-3': '#1f1f1f', 'panel-4': '#2b2b2b',
      seam: '#000000', rule: '#3d3d3d', 'rule-2': '#6b6b6b',
      legend: '#ffffff', 'legend-2': '#e0e0e0', 'legend-3': '#c2c2c2',
      keycap: '#ffffff', 'keycap-hover': '#ffe066', 'keycap-ink': '#000000',
      ...cables('#ff6b57', '#ffd000', '#00e5ff', '#7dff4f', '#c49bff', '#ff7ad9', '#6fa8ff', '#ffa040', '#3dffc5', '#ffffff'),
    },
  },

  // ------------------------------------------------ community palettes
  {
    id: 'nord',
    name: 'Nord',
    note: 'Arctic blues and an aurora.',
    colors: {
      case: '#242933', panel: '#2e3440', 'panel-2': '#3b4252', 'panel-3': '#434c5e', 'panel-4': '#4c566a',
      seam: '#1d2129', rule: '#3b4252', 'rule-2': '#4c566a',
      legend: '#eceff4', 'legend-2': '#d8dee9', 'legend-3': '#aeb7c6',
      keycap: '#88c0d0', 'keycap-hover': '#a3d2df', 'keycap-ink': '#242933',
      ...cables('#d57780', '#ebcb8b', '#88c0d0', '#a3be8c', '#b48ead', '#d6a0c0', '#81a1c1', '#d08770', '#8fbcbb', '#d8dee9'),
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    note: 'The vampire one.',
    colors: {
      case: '#1e1f29', panel: '#282a36', 'panel-2': '#2f3241', 'panel-3': '#383a4a', 'panel-4': '#44475a',
      seam: '#16171f', rule: '#363848', 'rule-2': '#4a4d62',
      legend: '#f8f8f2', 'legend-2': '#d3d4dc', 'legend-3': '#a3a8c9',
      keycap: '#bd93f9', 'keycap-hover': '#d3b5fb', 'keycap-ink': '#1e1f29',
      ...cables('#ff5555', '#f1fa8c', '#8be9fd', '#50fa7b', '#bd93f9', '#ff79c6', '#8aa2ff', '#ffb86c', '#6be5c4', '#f8f8f2'),
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    note: 'Ethan Schoonover’s classic, at night.',
    colors: {
      case: '#002b36', panel: '#03313d', 'panel-2': '#073642', 'panel-3': '#0d404d', 'panel-4': '#154a57',
      seam: '#001f27', rule: '#0b3e4a', 'rule-2': '#1d5260',
      legend: '#eee8d5', 'legend-2': '#bcc4c0', 'legend-3': '#9aa8a8',
      keycap: '#eee8d5', 'keycap-hover': '#fdf6e3', 'keycap-ink': '#002b36',
      ...cables('#ef4f4b', '#b58900', '#2aa198', '#859900', '#8b8fe0', '#e05a9a', '#268bd2', '#e0632d', '#36b0a4', '#93a1a1'),
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    note: 'Ethan Schoonover’s classic, by day.',
    colors: {
      case: '#fdf6e3', panel: '#f7f0dc', 'panel-2': '#eee8d5', 'panel-3': '#e6dfc9', 'panel-4': '#ddd5bd',
      seam: '#d3cbb1', rule: '#e4dcc4', 'rule-2': '#cfc6aa',
      legend: '#073642', 'legend-2': '#3f565d', 'legend-3': '#53686e',
      keycap: '#073642', 'keycap-hover': '#1c4f5c', 'keycap-ink': '#fdf6e3',
      ...cables('#c92a27', '#8a6800', '#1f7f78', '#5f6e00', '#5a5fb8', '#b92a73', '#1f6fae', '#b2410f', '#16786f', '#657b83'),
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    note: 'Retro groove, warm and earthy.',
    colors: {
      case: '#1d2021', panel: '#282828', 'panel-2': '#32302f', 'panel-3': '#3c3836', 'panel-4': '#504945',
      seam: '#141617', rule: '#3c3836', 'rule-2': '#504945',
      legend: '#fbf1c7', 'legend-2': '#d5c4a1', 'legend-3': '#bdae93',
      keycap: '#fabd2f', 'keycap-hover': '#fcd36b', 'keycap-ink': '#1d2021',
      ...cables('#fb4934', '#fabd2f', '#83a598', '#b8bb26', '#d3869b', '#f38ba0', '#7fa2c9', '#fe8019', '#8ec07c', '#ebdbb2'),
    },
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    note: 'Retro groove on cream.',
    colors: {
      case: '#fbf1c7', panel: '#f5ebc2', 'panel-2': '#f2e5bc', 'panel-3': '#ebdbb2', 'panel-4': '#d5c4a1',
      seam: '#d5c4a1', rule: '#e6d6ab', 'rule-2': '#c9b893',
      legend: '#282828', 'legend-2': '#504945', 'legend-3': '#5f554c',
      keycap: '#3c3836', 'keycap-hover': '#504945', 'keycap-ink': '#fbf1c7',
      ...cables('#9d0006', '#9a6200', '#076678', '#6b6b00', '#8f3f71', '#a83a62', '#2b5f8a', '#af3a03', '#427b58', '#7c6f64'),
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    note: 'The one every editor ships.',
    colors: {
      case: '#1e1f1a', panel: '#272822', 'panel-2': '#2e2f29', 'panel-3': '#383930', 'panel-4': '#49483e',
      seam: '#161712', rule: '#3a3b33', 'rule-2': '#4f5046',
      legend: '#f8f8f2', 'legend-2': '#cfcfc2', 'legend-3': '#a8a796',
      keycap: '#a6e22e', 'keycap-hover': '#c1ee68', 'keycap-ink': '#1e1f1a',
      ...cables('#f92672', '#e6db74', '#66d9ef', '#a6e22e', '#ae81ff', '#ff6fb5', '#6fa8ff', '#fd971f', '#4ee0b4', '#f8f8f2'),
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    note: 'Soothing pastels, dark roast.',
    colors: {
      case: '#11111b', panel: '#181825', 'panel-2': '#1e1e2e', 'panel-3': '#313244', 'panel-4': '#45475a',
      seam: '#0b0b12', rule: '#2a2b3c', 'rule-2': '#45475a',
      legend: '#cdd6f4', 'legend-2': '#bac2de', 'legend-3': '#a6adc8',
      keycap: '#cba6f7', 'keycap-hover': '#dcc3fa', 'keycap-ink': '#11111b',
      ...cables('#f38ba8', '#f9e2af', '#89dceb', '#a6e3a1', '#cba6f7', '#f5c2e7', '#89b4fa', '#fab387', '#94e2d5', '#f5e0dc'),
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    note: 'Soothing pastels, with milk.',
    colors: {
      case: '#eff1f5', panel: '#e6e9ef', 'panel-2': '#dce0e8', 'panel-3': '#ccd0da', 'panel-4': '#bcc0cc',
      seam: '#bcc0cc', rule: '#ccd0da', 'rule-2': '#acb0be',
      legend: '#3d405a', 'legend-2': '#4a4d63', 'legend-3': '#555872',
      keycap: '#8839ef', 'keycap-hover': '#9a55f2', 'keycap-ink': '#ffffff',
      ...cables('#d20f39', '#9a5e00', '#0b7aa0', '#2f7d1f', '#8839ef', '#c0399f', '#1e66f5', '#c44c00', '#137e84', '#6c6f85'),
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    note: 'Downtown lights after dark.',
    colors: {
      case: '#16161e', panel: '#1a1b26', 'panel-2': '#1f2335', 'panel-3': '#292e42', 'panel-4': '#343a55',
      seam: '#101016', rule: '#292e42', 'rule-2': '#3b4261',
      legend: '#c0caf5', 'legend-2': '#a9b1d6', 'legend-3': '#8f99c4',
      keycap: '#7aa2f7', 'keycap-hover': '#9ab8f9', 'keycap-ink': '#16161e',
      ...cables('#f7768e', '#e0af68', '#7dcfff', '#9ece6a', '#bb9af7', '#ff7eb6', '#7aa2f7', '#ff9e64', '#2ac3a2', '#c0caf5'),
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    note: 'All natural pine, faux fur and a bit of soho vibes.',
    colors: {
      case: '#13111c', panel: '#191724', 'panel-2': '#1f1d2e', 'panel-3': '#26233a', 'panel-4': '#403d52',
      seam: '#0d0c14', rule: '#26233a', 'rule-2': '#403d52',
      legend: '#e0def4', 'legend-2': '#c3c0db', 'legend-3': '#a5a1c2',
      keycap: '#ebbcba', 'keycap-hover': '#f3d4d3', 'keycap-ink': '#191724',
      ...cables('#eb6f92', '#f6c177', '#9ccfd8', '#8fc7a0', '#c4a7e7', '#ebbcba', '#7aa7d6', '#f0a070', '#3e8fb0', '#e0def4'),
    },
  },
];

export const THEME_BY_ID = Object.fromEntries(BUILT_IN.map((t) => [t.id, t]));

/** The theme with this id, from the built-ins or the user's own, falling back to the default. */
export function findTheme(id, custom = []) {
  return THEME_BY_ID[id] || (custom || []).find((t) => t.id === id) || THEME_BY_ID[DEFAULT_THEME];
}
