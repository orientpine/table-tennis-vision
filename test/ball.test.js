import { describe, expect, test } from "bun:test";
import { BallTracker } from "../public/js/ball.js";
import { Pipeline } from "../public/js/pipeline.js";

const CORNERS = [
  { x: 356, y: 634 },
  { x: 482, y: 520 },
  { x: 1370, y: 532 },
  { x: 1484, y: 660 },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// The pipeline's tracker settings for a 640 px wide processing frame.
const tracker = () => new BallTracker({ gate: 640 * 0.12 * 0.35, initGate: 640 * 0.12, minSpeed: 64 });

describe("BallTracker lock", () => {
  test("a ball flying a parabola is locked within about 0.13 s, at 60 and at 30 fps", () => {
    for (const fps of [60, 30]) {
      const tr = tracker();
      let lockedAt = null;
      for (let i = 0; i < fps * 0.5; i++) {
        const t = i / fps;
        const hit = tr.update([{ x: 100 + 420 * t, y: 220 - 260 * t + 500 * t * t, area: 6 }], t);
        if (hit && hit.locked && lockedAt == null) lockedAt = t;
      }
      expect(lockedAt).not.toBeNull();
      expect(lockedAt).toBeLessThanOrEqual(0.14);
    }
  });

  test("blobs flickering at random places almost never lock, though the tracker follows them", () => {
    let followed = 0, locked = 0, frames = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = rng(seed);
      const tr = tracker();
      for (let i = 0; i < 600; i++) {
        const cands = Array.from({ length: 25 }, () => ({ x: rand() * 640, y: rand() * 360, area: 5 }));
        const hit = tr.update(cands, i / 60);
        frames++;
        if (hit) followed++;
        if (hit && hit.locked) locked++;
      }
    }
    expect(followed).toBeGreaterThan(frames * 0.5);
    expect(locked).toBeLessThan(frames * 0.01);
  });
});

// Synthetic 640x360 frames for a 1920x1080 video: a flat blue table colour (or a cluttered room),
// optionally shifted like a hand-held phone, with a small white ball on a parabola.
function frames({ room = false, shake = false, n = 90 }) {
  const w = 640, h = 360;
  const rand = rng(3);
  const tex = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const blocky = ((Math.floor((i % w) / 12) * 7 + Math.floor(i / w / 12) * 13) % 5) * 45;
    tex[i * 3] = room ? blocky + rand() * 30 : 16;
    tex[i * 3 + 1] = room ? 200 - blocky : 1;
    tex[i * 3 + 2] = room ? 90 + rand() * 60 : 173;
  }
  const out = [];
  for (let f = 0; f < n; f++) {
    const t = f / 60;
    const dx = shake ? Math.round(3 * Math.sin(f * 0.9)) : 0;
    const dy = shake ? Math.round(2 * Math.cos(f * 1.3)) : 0;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x + dx));
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        const s = (sy * w + sx) * 3;
        const o = (y * w + x) * 4;
        rgba[o] = tex[s];
        rgba[o + 1] = tex[s + 1];
        rgba[o + 2] = tex[s + 2];
        rgba[o + 3] = 255;
      }
    }
    const bx = Math.round(160 + 300 * t), by = Math.round(150 - 120 * t + 200 * t * t);
    for (let y = by - 2; y <= by + 2; y++) for (let x = bx - 2; x <= bx + 2; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 250;
    }
    out.push({ t, rgba });
  }
  return out;
}

function run(opts, corners = CORNERS) {
  const p = new Pipeline();
  p.setVideoSize(1920, 1080);
  p.setCalibration(corners);
  let locked = 0, trail = 0;
  const tracking = new Set();
  for (const { t, rgba } of frames(opts)) {
    p.processPixels(rgba, t);
    const s = p.snapshot(t);
    if (s.ball.lock) locked++;
    trail = Math.max(trail, s.ball.trail.length);
    tracking.add(s.tracking);
  }
  return { locked, trail, tracking };
}

describe("Pipeline gates", () => {
  test("a ball over a calibrated table is locked and drawn", () => {
    const r = run({});
    expect(r.locked).toBeGreaterThan(30);
    expect(r.tracking.has("locked")).toBe(true);
  });

  test("no calibration: nothing is tracked", () => {
    const r = run({}, null);
    expect(r.locked).toBe(0);
    expect(r.trail).toBe(0);
    expect([...r.tracking]).toEqual(["no-calibration"]);
  });

  test("corners tapped on a room instead of a table: nothing is tracked", () => {
    const r = run({ room: true });
    expect(r.locked).toBe(0);
    expect(r.trail).toBe(0);
    expect([...r.tracking]).toEqual(["no-table"]);
  });

  test("a shaking phone: the moving ball is not trusted while the picture moves", () => {
    const r = run({ shake: true, room: false });
    // a flat table colour has no edges to shake; use a textured table to make shake visible
    const textured = (() => {
      const p = new Pipeline();
      p.setVideoSize(1920, 1080);
      p.setCalibration(CORNERS);
      p.tableChecks = [1];
      let locked = 0;
      const states = new Set();
      for (const { t, rgba } of frames({ room: true, shake: true })) {
        p.tableChecks = [1];
        p.processPixels(rgba, t);
        if (p.snapshot(t).ball.lock) locked++;
        states.add(p.tracking);
      }
      return { locked, states };
    })();
    expect(r.locked).toBeGreaterThan(30);
    expect(textured.locked).toBe(0);
    expect(textured.states.has("unstable")).toBe(true);
  });
});
