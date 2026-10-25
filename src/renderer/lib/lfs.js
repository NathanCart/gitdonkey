// Git LFS pointer files: what a big file looks like when LFS isn't there to fetch it.

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:[a-z0-9.-]+ [^\n]*\n)*?oid sha256:([0-9a-f]{64})\nsize (\d+)\n?/;

/** { oid, size } when `text` is an LFS pointer, else null. */
export function parseLfsPointer(text) {
  const m = POINTER.exec(String(text || ''));
  return m && m.index === 0 && String(text).length < 1024 ? { oid: m[1], size: Number(m[2]) } : null;
}

/** The old and new pointers in a diff of a pointer file, when that's all the diff is. */
export function lfsDiff(file) {
  if (!file || !file.hunks || !file.hunks.length) return null;
  const side = (keep) => file.hunks.flatMap((h) => h.lines.filter((l) => keep.includes(l.type)).map((l) => l.text)).join('\n');
  const before = side([' ', '-']);
  const after = side([' ', '+']);
  const a = before.trim() ? parseLfsPointer(`${before}\n`) : null;
  const b = after.trim() ? parseLfsPointer(`${after}\n`) : null;
  if (!a && !b) return null;
  if ((before.trim() && !a) || (after.trim() && !b)) return null;
  return { before: a, after: b };
}
