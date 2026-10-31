export const TABLE_LENGTH = 2.74;
export const TABLE_WIDTH = 1.525;
export const TABLE_HEIGHT = 0.76;

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

export function apply(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

// Corners arrive as [my end corner, my end corner, opponent end corner, opponent end corner];
// pair each of my corners with the opponent corner on the same long side so the quad does not self-cross.
export function orderCorners(corners) {
  const [a, b, c, d] = corners;
  return segmentsCross(a, c, b, d) ? [a, b, c, d] : [a, b, d, c];
}

export function makeCalibration(corners) {
  if (!corners || corners.length !== 4) return null;
  const quad = orderCorners(corners);
  const table = [
    { x: 0, y: 0 },
    { x: 0, y: TABLE_WIDTH },
    { x: TABLE_LENGTH, y: TABLE_WIDTH },
    { x: TABLE_LENGTH, y: 0 },
  ];
  const toTable = homography(quad, table);
  const toImage = homography(table, quad);
  if (!toTable || !toImage) return null;
  // Players stand on the floor, TABLE_HEIGHT below the table top. Drop each corner by the table
  // height at that end's image scale (end line px / TABLE_WIDTH) to get the floor under it, and
  // map floor points through that quad. Mapping feet through the table-top homography instead
  // would read the height drop as distance.
  const pxPerM = [dist(quad[0], quad[1]), dist(quad[0], quad[1]), dist(quad[2], quad[3]), dist(quad[2], quad[3])].map((d) => d / TABLE_WIDTH);
  const floorQuad = quad.map((p, i) => ({ x: p.x, y: p.y + TABLE_HEIGHT * pxPerM[i] }));
  const floorToTable = homography(floorQuad, table);
  const floorToImage = homography(table, floorQuad);
  const myEnd = mid(quad[0], quad[1]);
  const oppEnd = mid(quad[2], quad[3]);
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    corners,
    quad,
    toTable,
    toImage,
    floorToTable,
    floorToImage,
    myEnd,
    oppEnd,
    axis: unit({ x: oppEnd.x - myEnd.x, y: oppEnd.y - myEnd.y }),
    lengthPx: dist(myEnd, oppEnd),
    bbox: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) },
  };
}

export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function unit(v) {
  const n = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / n, y: v.y / n };
}

export function insidePolygon(p, poly, margin = 0) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (inside || margin <= 0) return inside;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distToSegment(p, poly[i], poly[j]) <= margin) return true;
  }
  return false;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// The picture's box inside a stage. Contain shows all of it; cover fills the stage and the box runs
// past the stage edges. Either way one scale and one offset map video px to stage px.
export function fitBox(stageW, stageH, vidW, vidH, cover = false) {
  const s = (cover ? Math.max : Math.min)(stageW / vidW, stageH / vidH);
  const w = vidW * s, h = vidH * s;
  return { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h, scale: s };
}
