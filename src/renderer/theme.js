// Painting the window in a theme: its colours as custom properties on <html>,
// its cables as the graph's lane colours, and (unless it's only a preview) a
// copy for the main process, so the next launch is in this theme from the
// first frame.
import { resolveTheme, lanePalette } from './lib/themes.js';
import { setPalette } from './lib/graph-layout.js';
import { invoke } from './api.js';

export function applyTheme(theme, { remember = true } = {}) {
  const r = resolveTheme(theme);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = r.scheme;
  root.dataset.scheme = r.scheme;
  setPalette(lanePalette(r.colors));
  if (remember) invoke('theme:remember', { vars: r.vars, scheme: r.scheme }).catch(() => {});
  return r;
}
