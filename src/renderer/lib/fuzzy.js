// Fuzzy matching for the command palette. Pure.

const WORD = /[\s/._:#()-]/;

/**
 * How well `query` matches `text`: -1 for no match, higher is better. Every
 * query character must appear in order; runs, word starts and an early start
 * score more. Returns { score, hits } where hits are the matched indices.
 */
export function fuzzy(query, text) {
  const q = query.trim().toLowerCase();
  const t = String(text).toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const exact = t.indexOf(q);
  if (exact !== -1) {
    const atWord = exact === 0 || WORD.test(t[exact - 1]);
    return { score: 1000 - exact + (atWord ? 300 : 0) + (exact === 0 ? 200 : 0) - t.length * 0.1, hits: [...Array(q.length).keys()].map((i) => exact + i) };
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    // Every word somewhere, in any order.
    let score = 0;
    const hits = [];
    for (const w of words) {
      const r = fuzzy(w, text);
      if (r.score < 0) return { score: -1, hits: [] };
      score += r.score;
      hits.push(...r.hits);
    }
    return { score: score / words.length - 50, hits: [...new Set(hits)].sort((a, b) => a - b) };
  }
  // Letters in order: once taking the first one each time, once preferring word starts ("pr" → Pull Request).
  const a = scatter(q, t, false);
  const b = scatter(q, t, true);
  return a.score >= b.score ? a : b;
}

function scatter(q, t, wordStarts) {
  let score = 0;
  let ti = 0;
  let run = 0;
  const hits = [];
  const isWord = (i) => i === 0 || WORD.test(t[i - 1]);
  for (const ch of q) {
    let at = t.indexOf(ch, ti);
    if (wordStarts && at !== -1 && !isWord(at)) {
      for (let j = t.indexOf(ch, at + 1); j !== -1; j = t.indexOf(ch, j + 1)) {
        if (isWord(j)) {
          at = j;
          break;
        }
      }
    }
    if (at === -1) return { score: -1, hits: [] };
    run = at === ti && hits.length ? run + 1 : 0;
    score += 10 + run * 15 + (isWord(at) ? 25 : 0) - Math.min(at - ti, 20);
    hits.push(at);
    ti = at + 1;
  }
  return { score: score - hits[0] * 0.5 - t.length * 0.1, hits };
}

/** Items that match, best first; `textOf` gives the text to match. */
export function rank(items, query, textOf = (x) => x.label) {
  if (!query.trim()) return items.map((item) => ({ item, hits: [] }));
  return items
    .map((item, i) => ({ item, i, ...fuzzy(query, textOf(item)) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ item, hits }) => ({ item, hits }));
}
