// Formatting and data helpers shared by the views. No DOM access.

export function shortHash(hash, n = 7) {
  return hash ? hash.slice(0, n) : '';
}

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  if (d < 31) {
    const w = Math.round(d / 7);
    return `${w} wk${w === 1 ? '' : 's'} ago`;
  }
  const mo = Math.round(d / 30.4);
  if (mo < 12) return `${mo} mo ago`;
  const y = Math.round(d / 365);
  return `${y} yr${y === 1 ? '' : 's'} ago`;
}

export function shortDate(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function fullDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

export function extname(p) {
  const { name } = splitPath(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };

export function imageMime(p) {
  return IMAGE_EXT[extname(p)] || null;
}

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml',
  xml: 'xml', svg: 'xml', vue: 'xml', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', lua: 'lua',
  pl: 'perl', r: 'r', dart: 'dart', scala: 'scala', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile',
  makefile: 'makefile', mk: 'makefile', diff: 'diff', patch: 'diff', ex: 'elixir', exs: 'elixir', m: 'objectivec',
  mm: 'objectivec', vb: 'vbnet', wasm: 'wasm',
};

export function languageFor(p) {
  const { name } = splitPath(p);
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  return LANG[extname(p)] || null;
}

/** Group files into a folder tree: [{ type:'dir', name, path, children } | { type:'file', file }] */
export function buildTree(files) {
  const root = { children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `${parts[i]}/`;
      if (!node.children.has(`d:${parts[i]}`)) node.children.set(`d:${parts[i]}`, { type: 'dir', name: parts[i], path: acc, children: new Map() });
      node = node.children.get(`d:${parts[i]}`);
    }
    node.children.set(`f:${parts[parts.length - 1]}`, { type: 'file', name: parts[parts.length - 1], file: f });
  }
  const finish = (node) => {
    const list = [...node.children.values()].map((c) => (c.type === 'dir' ? { ...c, children: finish(c) } : c));
    // Collapse single-child directory chains: a/b/c/
    const collapsed = list.map((c) => {
      let d = c;
      while (d.type === 'dir' && d.children.length === 1 && d.children[0].type === 'dir') {
        const child = d.children[0];
        d = { ...child, name: `${d.name}/${child.name}` };
      }
      return d;
    });
    return collapsed.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  };
  return finish(root);
}

/** Build a nested folder structure from slash-separated branch names. */
export function buildRefTree(items, nameOf) {
  const root = { folders: new Map(), leaves: [] };
  for (const it of items) {
    const parts = nameOf(it).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { folders: new Map(), leaves: [], name: parts[i], path: parts.slice(0, i + 1).join('/') });
      node = node.folders.get(parts[i]);
    }
    node.leaves.push({ item: it, leaf: parts[parts.length - 1] });
  }
  return root;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function pluralize(n, word, plural = `${word}s`) {
  return `${n} ${n === 1 ? word : plural}`;
}

export function guessRepoName(url) {
  const m = String(url || '').trim().replace(/\/+$/, '').match(/([^/:]+?)(\.git)?$/);
  return m ? m[1] : '';
}
