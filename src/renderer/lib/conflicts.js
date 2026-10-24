// Parse and resolve files containing git conflict markers.

export function parseConflicts(text) {
  const lines = text.split('\n');
  const segments = [];
  let plain = [];
  let i = 0;
  const flush = () => {
    if (plain.length) segments.push({ type: 'text', lines: plain });
    plain = [];
  };
  const isMarker = (line, ch) => line.startsWith(ch.repeat(7)) && (line.length === 7 || line[7] === ' ' || line[7] === '\r');
  while (i < lines.length) {
    const line = lines[i];
    if (isMarker(line, '<')) {
      const start = i;
      const block = { type: 'conflict', oursLabel: line.slice(8).trim(), theirsLabel: '', ours: [], base: null, theirs: [] };
      let section = 'ours';
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (section === 'ours' && isMarker(l, '|')) {
          section = 'base';
          block.base = [];
        } else if ((section === 'ours' || section === 'base') && isMarker(l, '=')) {
          section = 'theirs';
        } else if (section === 'theirs' && isMarker(l, '>')) {
          block.theirsLabel = l.slice(8).trim();
          closed = true;
          i++;
          break;
        } else {
          block[section].push(l);
        }
        i++;
      }
      if (closed) {
        flush();
        segments.push(block);
      } else {
        plain.push(...lines.slice(start, i));
      }
      continue;
    }
    plain.push(line);
    i++;
  }
  flush();
  return segments;
}

export function conflictCount(segments) {
  return segments.filter((s) => s.type === 'conflict').length;
}

/**
 * resolutions: array indexed by conflict number, each one of
 * 'ours' | 'theirs' | 'both' | 'both-theirs-first' | undefined (keep markers)
 */
export function resolveConflicts(segments, resolutions) {
  const out = [];
  let n = 0;
  for (const s of segments) {
    if (s.type === 'text') {
      out.push(...s.lines);
      continue;
    }
    const r = resolutions[n++];
    if (r === 'ours') out.push(...s.ours);
    else if (r === 'theirs') out.push(...s.theirs);
    else if (r === 'both') out.push(...s.ours, ...s.theirs);
    else if (r === 'both-theirs-first') out.push(...s.theirs, ...s.ours);
    else {
      out.push(`<<<<<<< ${s.oursLabel}`.trimEnd(), ...s.ours);
      if (s.base) out.push('|||||||', ...s.base);
      out.push('=======', ...s.theirs, `>>>>>>> ${s.theirsLabel}`.trimEnd());
    }
  }
  return out.join('\n');
}
