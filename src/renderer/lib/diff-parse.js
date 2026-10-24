// Unified diff parsing and partial-patch construction (hunk / line staging).

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseDiff(text) {
  const files = [];
  if (!text) return files;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (line) => {
    file = { header: [line], oldPath: null, newPath: null, binary: false, isNew: false, isDeleted: false, isRename: false, hunks: [] };
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      file.oldPath = m[1];
      file.newPath = m[2];
    }
    files.push(file);
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      startFile(line);
      continue;
    }
    if (!file) continue;
    const hm = line.match(HUNK_RE);
    if (hm) {
      hunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldCount: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newCount: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5].trim(),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      file.header.push(line);
      if (line.startsWith('--- ')) file.oldPath = line === '--- /dev/null' ? null : line.replace(/^--- (a\/)?/, '');
      else if (line.startsWith('+++ ')) file.newPath = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ (b\/)?/, '');
      else if (line.startsWith('new file mode')) file.isNew = true;
      else if (line.startsWith('deleted file mode')) file.isDeleted = true;
      else if (line.startsWith('rename from') || line.startsWith('rename to')) file.isRename = true;
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true;
      continue;
    }
    const t = line[0];
    if (t === '+') {
      hunk.lines.push({ type: '+', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (t === '-') {
      hunk.lines.push({ type: '-', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (t === '\\') {
      hunk.lines.push({ type: '\\', text: line.slice(1), oldNo: null, newNo: null });
    } else {
      hunk.lines.push({ type: ' ', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

/**
 * Build a patch containing only the selected changes.
 * selection: Map<hunkIndex, 'all' | Set<lineIndex>>
 * reverse=false: patch is applied forward (staging: index -> index+selection).
 * reverse=true:  patch will be applied with --reverse (unstage / discard).
 */
export function buildPatch(file, selection, { reverse = false } = {}) {
  const out = [...file.header];
  let delta = 0;
  let any = false;
  file.hunks.forEach((h, hi) => {
    const sel = selection.get(hi);
    if (!sel) return;
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    let changes = 0;
    let lastKept = true;
    for (let li = 0; li < h.lines.length; li++) {
      const l = h.lines[li];
      const selected = sel === 'all' || sel.has(li);
      if (l.type === ' ') {
        body.push(` ${l.text}`);
        oldCount++;
        newCount++;
        lastKept = true;
      } else if (l.type === '\\') {
        if (lastKept) body.push(`\\${l.text}`);
      } else if (l.type === '-') {
        if (selected) {
          body.push(`-${l.text}`);
          oldCount++;
          changes++;
          lastKept = true;
        } else if (!reverse) {
          body.push(` ${l.text}`);
          oldCount++;
          newCount++;
          lastKept = true;
        } else lastKept = false;
      } else if (l.type === '+') {
        if (selected) {
          body.push(`+${l.text}`);
          newCount++;
          changes++;
          lastKept = true;
        } else if (reverse) {
          body.push(` ${l.text}`);
          oldCount++;
          newCount++;
          lastKept = true;
        } else lastKept = false;
      }
    }
    if (!changes) return;
    any = true;
    let oldStart;
    let newStart;
    if (!reverse) {
      oldStart = h.oldStart;
      newStart = oldCount === 0 && newCount > 0 ? h.oldStart + delta + 1 : h.oldStart + delta;
      if (newCount === 0) newStart = Math.max(0, h.oldStart + delta - 1);
    } else {
      newStart = h.newStart;
      oldStart = newCount === 0 && oldCount > 0 ? h.newStart - delta + 1 : h.newStart - delta;
      if (oldCount === 0) oldStart = Math.max(0, h.newStart - delta - 1);
    }
    delta += newCount - oldCount;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  });
  return any ? `${out.join('\n')}\n` : null;
}

/** Count of +/- lines in a parsed file. */
export function diffStats(file) {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === '+') add++;
      else if (l.type === '-') del++;
    }
  }
  return { add, del };
}

/** Pair removed/added lines of a hunk for side-by-side display. */
export function splitRows(hunk) {
  const rows = [];
  let i = 0;
  const L = hunk.lines;
  while (i < L.length) {
    const l = L[i];
    if (l.type === ' ') {
      rows.push({ left: { ...l, index: i }, right: { ...l, index: i } });
      i++;
    } else if (l.type === '\\') {
      i++;
    } else {
      const dels = [];
      const adds = [];
      while (i < L.length && (L[i].type === '-' || L[i].type === '\\')) {
        if (L[i].type === '-') dels.push({ ...L[i], index: i });
        i++;
      }
      while (i < L.length && (L[i].type === '+' || L[i].type === '\\')) {
        if (L[i].type === '+') adds.push({ ...L[i], index: i });
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
    }
  }
  return rows;
}
