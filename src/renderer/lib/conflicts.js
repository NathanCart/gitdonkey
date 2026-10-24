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
 * 'ours' | 'theirs' | 'both' | 'both-theirs-first' | { lines } (an accepted
 * AI suggestion) | undefined (keep markers)
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
    else if (r && Array.isArray(r.lines)) out.push(...r.lines);
    else {
      out.push(`<<<<<<< ${s.oursLabel}`.trimEnd(), ...s.ours);
      if (s.base) out.push('|||||||', ...s.base);
      out.push('=======', ...s.theirs, `>>>>>>> ${s.theirsLabel}`.trimEnd());
    }
  }
  return out.join('\n');
}

/**
 * Every conflict with the lines around it, for asking an AI to resolve them:
 * [{ index, ours, base, theirs, before, after }], `around` lines either side.
 */
export function conflictContext(segments, around = 8) {
  const out = [];
  let n = 0;
  segments.forEach((s, i) => {
    if (s.type !== 'conflict') return;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    out.push({
      index: n++,
      ours: s.ours,
      base: s.base,
      theirs: s.theirs,
      oursLabel: s.oursLabel,
      theirsLabel: s.theirsLabel,
      before: prev && prev.type === 'text' ? prev.lines.slice(-around) : [],
      after: next && next.type === 'text' ? next.lines.slice(0, around) : [],
    });
  });
  return out;
}

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * An AI's reply to a conflict prompt, checked: a Map from conflict index
 * (0-based) to { lines, why, confidence }. Entries for conflicts that don't
 * exist, or without lines, are dropped; a reply that isn't the JSON asked
 * for throws.
 */
export function parseResolutionReply(text, count) {
  const raw = String(text || '').trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('The AI didn’t answer in the format GitDonkey asked for. Try again.');
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.resolutions) ? data.resolutions : [];
  const out = new Map();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const index = Number(r.conflict) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= count || out.has(index)) continue;
    let lines = r.lines;
    if (typeof lines === 'string') lines = lines.replace(/\r\n?/g, '\n').split('\n');
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) continue;
    // Never hand back conflict markers as a resolution.
    if (lines.some((l) => /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(l))) continue;
    out.set(index, {
      lines,
      why: typeof r.why === 'string' ? r.why.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
      confidence: CONFIDENCE.has(r.confidence) ? r.confidence : 'medium',
    });
  }
  if (!out.size) throw new Error('The AI didn’t suggest a resolution for any of these conflicts.');
  return out;
}
