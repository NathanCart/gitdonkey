// Commit graph lane layout.
//
// Input: commits in display order (every child appears before its parents),
// each { hash, parents, wip? }.
// Output: one row per commit: { col, color, edges } where `edges` are the line
// segments drawn from the previous row (column `from`) into this row (column
// `to`). Lanes keep their column for their whole life, so colors are stable.

// The patch-cable palette (the --red … --bone tokens of the current theme),
// alternating warm and cool so neighbouring lanes never blur together.
let PALETTE = [
  '#ffb627', '#36c3d0', '#ff5a3c', '#a07cff', '#86d05a',
  '#ff6fae', '#4c8dff', '#ff8a3d', '#2fd4a3', '#d9d4c7',
];

/** Use a theme's cable colours for lanes laid out from now on. */
export function setPalette(colors) {
  if (Array.isArray(colors) && colors.length) PALETTE = [...colors];
}

export function colorFor(col) {
  return PALETTE[col % PALETTE.length];
}

export function computeGraph(commits) {
  const lanes = []; // { hash, src, dashed } | null
  let pending = []; // merge edges from the previous node into an existing lane
  const rows = new Array(commits.length);
  let width = 0;

  for (let r = 0; r < commits.length; r++) {
    const c = commits[r];

    let col = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] && lanes[i].hash === c.hash) {
        col = i;
        break;
      }
    }
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
    }

    const edges = [];
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (!l) continue;
      const to = l.hash === c.hash ? col : i;
      edges.push({ from: l.src, to, color: colorFor(i), dashed: l.dashed });
    }
    for (const p of pending) {
      const l = lanes[p.lane];
      const to = l && l.hash === c.hash ? col : p.lane;
      edges.push({ from: p.src, to, color: colorFor(p.lane), dashed: false });
    }
    pending = [];

    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] && lanes[i].hash === c.hash) lanes[i] = null;
    }
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]) lanes[i].src = i;
    }

    const parents = c.parents || [];
    if (parents.length) {
      lanes[col] = { hash: parents[0], src: col, dashed: Boolean(c.wip) };
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k];
        const existing = lanes.findIndex((l) => l && l.hash === p);
        if (existing !== -1) {
          pending.push({ src: col, lane: existing });
          continue;
        }
        let j = lanes.indexOf(null);
        if (j === -1) j = lanes.length;
        lanes[j] = { hash: p, src: col, dashed: false };
      }
    } else if (col < lanes.length) {
      lanes[col] = null;
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();

    width = Math.max(width, lanes.length, col + 1);
    rows[r] = { col, color: colorFor(col), edges };
  }

  // Lanes still open at the bottom (history continues past what is loaded).
  const tail = lanes.map((l, i) => (l ? { from: l.src, to: i, color: colorFor(i), dashed: l.dashed } : null)).filter(Boolean);
  return { rows, width, tail };
}
