// The GitDonkey mark, shared by the renderer (as inline SVG) and the icon
// build script. Front-facing donkey head: bone-white face, jack-socket eyes,
// a pale muzzle, and a forelock of three patch cables between the long ears.

export const COLORS = {
  bone: '#ece8df',
  boneShade: '#d5cebf',
  case: '#0b0c0e',
  earInner: '#2a2b30',
  red: '#ff5a3c',
  amber: '#ffb627',
  cyan: '#36c3d0',
};

export function markSvgBody({ mono = false } = {}) {
  const c = mono
    ? { bone: 'currentColor', boneShade: 'currentColor', case: 'var(--case, #0b0c0e)', earInner: 'var(--case, #0b0c0e)', red: 'currentColor', amber: 'currentColor', cyan: 'currentColor' }
    : COLORS;
  const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${+(64 - Number(x)).toFixed(2)} ${y}`);
  const ear = 'M20.5 24.5 C 15 17.5, 11 9, 12 3 C 12.4 1.2, 14.6 0.8, 16.2 2.2 C 21 6.5, 26 12.5, 28.8 19.5 Z';
  const earInner = 'M22.6 20.2 C 19.4 15.6, 17.4 10.6, 16.9 7.2 C 19.6 10.2, 22.4 14, 24.8 18.2 Z';
  const head = 'M32 15 C 40.6 15, 45.6 20.2, 45.6 28 C 45.6 34, 43.6 39, 43.6 44 C 43.6 47, 45.2 49.4, 45.2 53 C 45.2 58.6, 39.6 62.6, 32 62.6 C 24.4 62.6, 18.8 58.6, 18.8 53 C 18.8 49.4, 20.4 47, 20.4 44 C 20.4 39, 18.4 34, 18.4 28 C 18.4 20.2, 23.4 15, 32 15 Z';
  const muzzle = 'M32 44.6 C 39.8 44.6, 45.2 48.2, 45.2 53 C 45.2 58.6, 39.6 62.6, 32 62.6 C 24.4 62.6, 18.8 58.6, 18.8 53 C 18.8 48.2, 24.2 44.6, 32 44.6 Z';
  return `
  <path d="${ear}" fill="${c.bone}"/>
  <path d="${mirror(ear)}" fill="${c.bone}"/>
  <path d="${earInner}" fill="${c.earInner}"/>
  <path d="${mirror(earInner)}" fill="${c.earInner}"/>
  <path d="${head}" fill="${c.bone}"/>
  ${mono ? '' : `<path d="${muzzle}" fill="${c.boneShade}"/>`}
  <ellipse cx="27.6" cy="54.6" rx="1.55" ry="2.7" transform="rotate(-22 27.6 54.6)" fill="${c.case}"/>
  <ellipse cx="36.4" cy="54.6" rx="1.55" ry="2.7" transform="rotate(22 36.4 54.6)" fill="${c.case}"/>
  <circle cx="24.6" cy="31" r="3.4" fill="${c.case}"/>
  <circle cx="39.4" cy="31" r="3.4" fill="${c.case}"/>
  <circle cx="24.6" cy="31" r="1.25" fill="${c.bone}"/>
  <circle cx="39.4" cy="31" r="1.25" fill="${c.bone}"/>
  <path d="M29.2 17.6 C 28 13.2, 25.6 10.2, 22.4 8.4" stroke="${c.red}" stroke-width="3.3" fill="none" stroke-linecap="round"/>
  <path d="M32 17 L 32 5.6" stroke="${c.amber}" stroke-width="3.3" fill="none" stroke-linecap="round"/>
  <path d="M34.8 17.6 C 36 13.2, 38.4 10.2, 41.6 8.4" stroke="${c.cyan}" stroke-width="3.3" fill="none" stroke-linecap="round"/>`;
}

export function markSvg(size = 64, opts = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${markSvgBody(opts)}</svg>`;
}

/**
 * App icon: anodized plate with the mark. 'mac' keeps the padded squircle of
 * the macOS grid; 'win' fills the canvas the way Windows icons do.
 */
export function appIconSvg(size = 1024, { variant = 'mac' } = {}) {
  const g = variant === 'win'
    ? { x: 40, w: 944, rx: 200, t: 'translate(166 150) scale(10.8)' }
    : { x: 100, w: 824, rx: 185, t: 'translate(212 198) scale(9.4)' };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
  <rect x="${g.x}" y="${g.x}" width="${g.w}" height="${g.w}" rx="${g.rx}" fill="#16171a"/>
  <rect x="${g.x + 0.5}" y="${g.x + 0.5}" width="${g.w - 1}" height="${g.w - 1}" rx="${g.rx - 0.5}" fill="none" stroke="#33363d" stroke-width="3"/>
  <g transform="${g.t}">${markSvgBody()}</g>
</svg>`;
}

