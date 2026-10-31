// Snap four roughly tapped table corners onto the table's white border lines.
// Every table top has a white edge line (2 cm) around a darker top. Along each of the four
// sides of the tapped quad, scan across the side for the brightest narrow ridge (brighter than
// the pixels a few px to either side), take its outer edge, fit a straight line through those
// points with outliers dropped (players, the net post, a banner right behind the far edge), and
// intersect neighbouring lines for the corners. If a side does not show a clear line, or the
// fit would move a corner further than it searched, the taps are kept as they were.
import { makeCalibration, orderCorners } from "./geom.js";
import { tableUniformity } from "./pipeline.js";

const SAMPLES = 48;

function rgbAt(rgba, w, h, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
  const o = (yi * w + xi) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2]];
}

function lumAt(rgba, w, h, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
  const o = (yi * w + xi) * 4;
  return (rgba[o] * 77 + rgba[o + 1] * 151 + rgba[o + 2] * 28) >> 8;
}

// Outer edges of the white ridges on the profile across one side (a scan near a corner can
// cross two border lines). s runs from -r (inside the table) to +r (outside); a ridge is
// brighter than the table top d px inside by minRidge and than the outside by half that (a
// light floor or wall sits right behind some end lines), kept if strongest within d.
function edgesOnProfile(prof, r, d, minRidge) {
  const resp = prof.map((v, i) => (i < d || i >= prof.length - d || v < 0 || prof[i - d] < 0 || prof[i + d] < 0 ? -1 : Math.min(v - prof[i - d], 2 * (v - prof[i + d]))));
  const out = [];
  for (let i = d; i < prof.length - d; i++) {
    if (resp[i] < minRidge) continue;
    let peak = true;
    for (let k = i - d; k <= i + d && peak; k++) if (k !== i && resp[k] > resp[i]) peak = false;
    if (!peak) continue;
    // Walk outward to where the brightness falls halfway back to the outside level.
    const half = (prof[i] + prof[i + d]) / 2;
    let j = i;
    while (j + 1 < prof.length && prof[j + 1] >= half) j++;
    out.push({ s: j - r, resp: resp[i] });
  }
  return out;
}

function fitLine(pts) {
  // Total least squares: centroid + principal direction.
  const n = pts.length;
  const cx = pts.reduce((a, p) => a + p.x, 0) / n;
  const cy = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - cx) ** 2;
    sxy += (p.x - cx) * (p.y - cy);
    syy += (p.y - cy) ** 2;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(ang), dy: Math.sin(ang) };
}

const lineDist = (L, p) => Math.abs((p.x - L.cx) * L.dy - (p.y - L.cy) * L.dx);

// RANSAC over point pairs (deterministic order so results repeat), then refit on the inliers.
// Only lines within the angle limit of the tapped side's direction count (rough taps tilt a
// short end line more, so the limit grows with search width / side length, 10-30 deg): near a corner the scan of a
// short, steep end line also crosses the long side's border and would otherwise fit that.
function robustLine(pts, tol, dir, minCos) {
  if (pts.length < 6) return null;
  let bestIn = null;
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + Math.max(3, n >> 2); j < n; j += 3) {
      const L = fitLine([pts[i], pts[j]]);
      if (Math.abs(L.dx * dir.x + L.dy * dir.y) < minCos) continue;
      const inl = pts.filter((p) => lineDist(L, p) <= tol);
      if (!bestIn || inl.length > bestIn.length) bestIn = inl;
    }
  }
  if (!bestIn || bestIn.length < 6) return null;
  let L = fitLine(bestIn);
  const inl = pts.filter((p) => lineDist(L, p) <= tol);
  L = fitLine(inl);
  if (Math.abs(L.dx * dir.x + L.dy * dir.y) < minCos) return null;
  return { line: L, inliers: inl.length, of: n };
}

function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / den;
  return { x: a.cx + a.dx * t, y: a.cy + a.dy * t };
}

// rgba: w x h frame; corners in video px; scale = video px per frame px (1 for a full-size frame).
// Returns { ok, corners (video px, same order as given), moved: [px per corner], sides, reason }.
export function refineCorners(rgba, w, h, corners, { scale = 1, minInlierShare = 0.45, minRidge = 12, minUniform = 0.4, minEdgeContrast = 28, minEdgeShare = 0.6, debug = false } = {}) {
  const given = corners.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  const quad = orderCorners(given);
  const cx = quad.reduce((a, p) => a + p.x, 0) / 4;
  const cy = quad.reduce((a, p) => a + p.y, 0) / 4;
  const diag = Math.hypot(quad[0].x - quad[2].x, quad[0].y - quad[2].y);
  const lines = [];
  const sides = [];
  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    let nx = -ty;
    let ny = tx;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const d = Math.max(2, Math.round(diag / 400));
    let line = null;
    let stat = null;
    // Pass 1 searches wide (taps can be tens of px off); pass 2 re-scans tightly around the fit.
    for (const [r, ref] of [[Math.round(Math.min(90, Math.max(16, diag * 0.05))), null], [Math.max(6, d * 3), "fit"]]) {
      const pts = [];
      for (let k = 0; k < SAMPLES; k++) {
        const t = 0.08 + (0.84 * k) / (SAMPLES - 1);
        let px = a.x + (b.x - a.x) * t;
        let py = a.y + (b.y - a.y) * t;
        if (ref && line) {
          const u = (px - line.cx) * line.dx + (py - line.cy) * line.dy;
          px = line.cx + line.dx * u;
          py = line.cy + line.dy * u;
        }
        const prof = [];
        for (let s = -r; s <= r; s++) prof.push(lumAt(rgba, w, h, px + nx * s, py + ny * s));
        for (const hit of edgesOnProfile(prof, r, d, minRidge)) pts.push({ x: px + nx * hit.s, y: py + ny * hit.s });
      }
      const maxAng = Math.min(30, Math.max(10, (Math.atan2(r, len * 0.5) * 180) / Math.PI));
      const dir = ref && line ? { x: line.dx, y: line.dy } : { x: tx, y: ty };
      const fit = robustLine(pts, Math.max(1.5, d * 0.8), dir, Math.cos((maxAng * Math.PI) / 180));
      if (!fit) {
        line = null;
        stat = { found: pts.length, inliers: 0 };
        break;
      }
      line = fit.line;
      stat = { found: pts.length, inliers: fit.inliers, searchPx: r, ...(debug ? { pts: pts.map((q) => [Math.round(q.x), Math.round(q.y)]) } : {}) };
    }
    sides.push(stat);
    if (!line || stat.inliers < SAMPLES * minInlierShare) return { ok: false, corners, moved: null, sides, reason: `side ${e} has no clear border line` };
    lines.push(line);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return { ok: false, corners, moved: null, sides, reason: "parallel sides" };
    out.push(p);
  }
  const refined = given.map((g) => {
    const q = out[quad.indexOf(g)];
    return { x: Math.round(q.x * scale * 10) / 10, y: Math.round(q.y * scale * 10) / 10 };
  });
  const moved = refined.map((p, i) => Math.round(Math.hypot(p.x - corners[i].x, p.y - corners[i].y) * 10) / 10);
  const limit = Math.min(90, Math.max(16, diag * 0.05)) * 1.5 * scale;
  // A line fit always returns something, and on a small or low-contrast table it can land tens of
  // px off while every side still has "inliers". So the snapped quad has to prove it is a table
  // top: its colour uniformity must pass the pipeline's own gate and must not be worse than the
  // tapped quad's. Without this, a 1152x648 test_2 frame snapped 58 px off, confidently.
  const uniform = (pts) => {
    const cal = makeCalibration(pts);
    return cal ? tableUniformity(rgba, w, h, cal, 1) : 0;
  };
  // A table edge has the table top on one side and floor, apron or a banner on the other. The
  // line fit alone cannot tell that apart from a line drawn across the table: on a 1152x648
  // frame it snapped the far side onto a line with blue table on BOTH sides, 58 px off. So every
  // final side must show the colour actually changing across it.
  const sideContrast = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const cx2 = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy2 = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    const out = (a.x + b.x) / 2 - cx2 === 0 && (a.y + b.y) / 2 - cy2 === 0 ? 1 : Math.sign(((a.x + b.x) / 2 - cx2) * nx + ((a.y + b.y) / 2 - cy2) * ny) || 1;
    const off = Math.max(3, Math.round(len * 0.02));
    let changed = 0;
    let n = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const t = 0.15 + (0.7 * i) / (SAMPLES - 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const inside = rgbAt(rgba, w, h, px - nx * out * off, py - ny * out * off);
      const outside = rgbAt(rgba, w, h, px + nx * out * off, py + ny * out * off);
      if (!inside || !outside) continue;
      n++;
      if (Math.hypot(inside[0] - outside[0], inside[1] - outside[1], inside[2] - outside[2]) >= minEdgeContrast) changed++;
    }
    return n ? changed / n : 0;
  };
  const contrast = out.map((_, i) => Math.round(sideContrast(out[i], out[(i + 1) % 4]) * 100) / 100);
  const weak = contrast.findIndex((c) => c < minEdgeShare);
  if (weak >= 0) return { ok: false, corners, moved, sides, contrast, reason: `side ${weak} shows no colour change across it (not a table edge)` };
  const uTap = uniform(given);
  const uSnap = uniform(refined.map((p) => ({ x: p.x / scale, y: p.y / scale })));
  if (!(uSnap >= minUniform && uSnap >= uTap - 0.02)) return { ok: false, corners, moved, sides, uniform: [uTap, uSnap], reason: "the snapped quad does not look like the table top" };
  if (new Set(refined.map((p) => `${p.x},${p.y}`)).size < 4) return { ok: false, corners, moved, sides, reason: "corners collapsed" };
  if (moved.some((m) => m > limit)) return { ok: false, corners, moved, sides, reason: "a corner would move further than searched" };
  return { ok: true, corners: refined, moved, sides, uniform: [uTap, uSnap], contrast, reason: null };
}

// Players lean over the table and hide a side in one frame but not the next: refine on a few
// frames (say 5 over 2 s) and take each corner's median over the frames that snapped. Needs a
// majority of frames to snap, else the taps stay.
export function refineCornersMulti(frames, corners, opts = {}) {
  const runs = frames.map(({ rgba, w, h }) => refineCorners(rgba, w, h, corners, opts));
  const good = runs.filter((r) => r.ok);
  if (good.length * 2 <= runs.length) return { ok: false, corners, moved: null, frames: runs.length, snapped: good.length, reason: (runs.find((r) => !r.ok) || {}).reason };
  const med = (v) => v.sort((a, b) => a - b)[v.length >> 1];
  const refined = corners.map((_, i) => ({ x: med(good.map((r) => r.corners[i].x)), y: med(good.map((r) => r.corners[i].y)) }));
  const moved = refined.map((p, i) => Math.round(Math.hypot(p.x - corners[i].x, p.y - corners[i].y) * 10) / 10);
  return { ok: true, corners: refined, moved, frames: runs.length, snapped: good.length, reason: null };
}
