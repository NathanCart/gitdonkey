// Finding text in a view. Pure: strings in, offsets out.

/** Start offsets of `query` in `text`, without overlaps. */
export function findAll(text, query, { matchCase = false } = {}) {
  if (!query) return [];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * Turn [start, end) in an element's text into a Range over its text nodes
 * (the text may be split across syntax-highlighting spans).
 */
export function rangeIn(el, start, end, doc = el.ownerDocument) {
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const range = doc.createRange();
  let pos = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue.length;
    if (!started && start < pos + len) {
      range.setStart(node, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}
