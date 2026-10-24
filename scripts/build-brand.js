'use strict';

// Renders the GitDonkey brand assets with Electron's own Chromium:
//   assets/icon.png (1024), assets/icon.icns, assets/icon.ico + icon-win.png (Windows),
//   assets/logo.svg, assets/brand-sheet.png
// Run: npx electron scripts/build-brand.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

let markSvg;
let appIconSvg;

const ASSETS = path.join(__dirname, '..', 'assets');
const FONT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts', 'michroma-latin-400-normal.woff2');

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

let win = null;
async function render(html, width, height, out) {
  if (!win) win = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.setContentSize(width, height);
  const file = path.join(ASSETS, '.render.html');
  fs.writeFileSync(file, html);
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(out, img.resize({ width, height }).toPNG());
  fs.rmSync(file, { force: true });
}

const page = (body, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Michroma; src: url('${pathToFileURL(FONT).href}') format('woff2'); }
html,body{margin:0;background:${bg};}
</style></head><body>${body}</body></html>`;

app.whenReady().then(async () => {
  ({ markSvg, appIconSvg } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'logo-mark.js')).href));
  fs.writeFileSync(path.join(ASSETS, 'logo.svg'), `${markSvg(256).replace('aria-hidden="true"', 'role="img" aria-label="GitDonkey"')}\n`);
  fs.writeFileSync(path.join(ASSETS, 'icon.svg'), `${appIconSvg(1024)}\n`);

  await render(page(appIconSvg(1024)), 1024, 1024, path.join(ASSETS, 'icon.png'));

  const iconset = path.join(os.tmpdir(), `gitdonkey-${Date.now()}.iconset`);
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 64, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), path.join(ASSETS, 'icon.png'), '--out', path.join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), path.join(ASSETS, 'icon.png'), '--out', path.join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });

  // Windows: full-bleed variant packed into a multi-size .ico (PNG entries).
  const winPng = path.join(os.tmpdir(), `gitdonkey-win-${Date.now()}.png`);
  await render(page(appIconSvg(1024, { variant: 'win' })), 1024, 1024, winPng);
  const entries = [16, 24, 32, 48, 64, 128, 256].map((s) => {
    const out = path.join(os.tmpdir(), `gitdonkey-win-${s}.png`);
    execFileSync('sips', ['-z', String(s), String(s), winPng, '--out', out], { stdio: 'ignore' });
    const buf = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return { size: s, buf };
  });
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(entries));
  fs.copyFileSync(winPng, path.join(ASSETS, 'icon-win.png'));
  fs.rmSync(winPng, { force: true });

  const sheet = `
  <div style="width:1600px;height:900px;background:#0b0c0e;color:#ece8df;font-family:-apple-system,sans-serif;display:grid;grid-template-columns:560px 1fr;gap:1px;">
    <div style="background:#131417;display:grid;place-items:center;">${appIconSvg(460)}</div>
    <div style="background:#131417;display:flex;flex-direction:column;justify-content:center;gap:56px;padding:0 64px;">
      <div style="display:flex;align-items:center;gap:28px;">${markSvg(132)}<div><div style="font-family:Michroma;font-size:58px;letter-spacing:.04em;line-height:1.05">GitDonkey</div><div style="color:#aaa69e;font-size:22px;margin-top:12px">Every branch in view. Every change within reach.</div></div></div>
      <div style="display:flex;align-items:flex-end;gap:36px;">
        ${[96, 64, 48, 32, 24, 16].map((s) => `<div style="display:grid;justify-items:center;gap:10px">${markSvg(s)}<span style="font:12px Menlo, monospace;color:#7a7770">${s}px</span></div>`).join('')}
        <div style="display:grid;justify-items:center;gap:10px;color:#7a7770">${markSvg(32, { mono: true })}<span style="font:12px Menlo, monospace">mono</span></div>
        <div style="display:grid;justify-items:center;gap:10px;padding:12px;background:#ece8df;border-radius:8px">${markSvg(48)}<span style="font:12px Menlo, monospace;color:#555">on light</span></div>
      </div>
    </div>
  </div>`;
  await render(page(sheet), 1600, 900, path.join(ASSETS, 'brand-sheet.png'));
  console.log('Wrote assets/icon.png, icon.icns, icon.ico, icon-win.png, icon.svg, logo.svg, brand-sheet.png');
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
