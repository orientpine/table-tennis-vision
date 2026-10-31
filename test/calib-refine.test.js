import { describe, expect, test } from "bun:test";
import { refineCorners, refineCornersMulti } from "../public/js/calib-refine.js";

// A 960x540 frame: yellow floor, a blue table top with a 3 px white border on the quad below.
const TRUE = [
  { x: 180, y: 330 },
  { x: 260, y: 260 },
  { x: 700, y: 268 },
  { x: 770, y: 340 },
];

function inside(p, q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) {
      if (s && Math.sign(c) !== s) return false;
      s = Math.sign(c);
    }
  }
  return true;
}

function distToQuadEdge(p, q) {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

function tableFrame(w = 960, h = 540) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const p = { x: x + 0.5, y: y + 0.5 };
      let c = [150, 120, 40];
      if (inside(p, TRUE)) c = distToQuadEdge(p, TRUE) <= 3 ? [235, 235, 235] : [20, 30, 140];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return { rgba, w, h };
}

describe("corner snapping", () => {
  test("taps 20 px off land within 3 px of the table's outer border corners", () => {
    const { rgba, w, h } = tableFrame();
    const taps = TRUE.map((p, i) => ({ x: p.x + [18, -15, 12, -20][i], y: p.y + [-12, 16, 15, -10][i] }));
    const res = refineCorners(rgba, w, h, taps);
    expect(res.ok).toBe(true);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });

  test("no table in view: the taps are kept as they were", () => {
    const w = 960;
    const h = 540;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(128);
    const res = refineCorners(rgba, w, h, TRUE);
    expect(res.ok).toBe(false);
    expect(res.corners).toEqual(TRUE);
  });

  test("several frames: the median holds when one frame has the table hidden", () => {
    const good = tableFrame();
    const blank = { rgba: new Uint8ClampedArray(960 * 540 * 4).fill(128), w: 960, h: 540 };
    const taps = TRUE.map((p) => ({ x: p.x + 10, y: p.y - 8 }));
    const res = refineCornersMulti([good, blank, good], taps);
    expect(res.ok).toBe(true);
    expect(res.snapped).toBe(2);
    res.corners.forEach((p, i) => expect(Math.hypot(p.x - TRUE[i].x, p.y - TRUE[i].y)).toBeLessThan(3));
  });
});
