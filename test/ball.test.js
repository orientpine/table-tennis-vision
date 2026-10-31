import { describe, expect, test } from "bun:test";
import { BallDetector, BallTracker, isOrange } from "../public/js/ball.js";
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

describe("orange ball colour", () => {
  test("blurred and deep orange ball pixels pass; skin, red-orange shirt, red, yellow, white, table and dim wood do not", () => {
    // ball pixels at 640 px from the synthetic orange test_2 (blur mixed with the table) and a deep orange
    for (const [r, g, b] of [[132, 109, 58], [151, 108, 33], [173, 134, 26], [154, 140, 79], [255, 130, 15]]) expect(isOrange(r, g, b)).toBe(true);
    // skin, the far player's red-orange shirt, red board, yellow, white, table blue, green, dim wood
    for (const [r, g, b] of [[220, 170, 140], [180, 70, 40], [200, 50, 40], [250, 235, 40], [240, 240, 235], [30, 40, 160], [60, 140, 60], [125, 100, 40]]) expect(isOrange(r, g, b)).toBe(false);
  });

  test("the orange detector finds a moving orange ball on a blue table and ignores a moving white one", () => {
    const w = 64, h = 48;
    const frame = (bx, color) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) px.set([30, 40, 150, 255], i * 4);
      for (let y = 20; y < 24; y++) for (let x = bx; x < bx + 4; x++) px.set([...color, 255], (y * w + x) * 4);
      return px;
    };
    for (const [color, want] of [[[230, 140, 40], 1], [[235, 235, 235], 0]]) {
      const det = new BallDetector({ width: w, height: h, color: "orange" });
      let found = 0;
      for (let i = 0; i < 6; i++) found = det.detect(frame(6 + i * 8, color)).length;
      expect(found).toBe(want);
    }
  });
});

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

  test("a ball flying over the table takes over from a fast, rough blob beside it (a swinging arm)", () => {
    const tr = tracker();
    tr.overTable = { x0: 200, x1: 560 };
    const rand = rng(9);
    let onBall = 0;
    let frames = 0;
    for (let i = 0; i < 90; i++) {
      const t = i / 60;
      // Arm: circles beside the table at ~420 px/s with 3 px of jitter, there from the start.
      const arm = { x: 80 + 40 * Math.cos(t * 12) + rand() * 6 - 3, y: 200 + 40 * Math.sin(t * 12) + rand() * 6 - 3, area: 8 };
      const cands = [arm];
      const tb = t - 0.5;
      const ball = tb >= 0 ? { x: 230 + 300 * tb, y: 150 - 200 * tb + 400 * tb * tb, area: 6 } : null;
      if (ball) cands.push(ball);
      const hit = tr.update(cands, t);
      if (ball && tb >= 0.25) {
        frames++;
        if (hit && hit.locked && Math.hypot(hit.x - ball.x, hit.y - ball.y) < 3) onBall++;
      }
    }
    expect(onBall).toBeGreaterThan(frames * 0.9);
  });

  test("a flight towards the lens with blurry blobs locks only with the end-on cubic", () => {
    // Pinhole camera low behind the table, the ball coming at the lens (2.5 m to 0.4 m), plus
    // the +-2.5 px centroid jitter of a compressed club clip's blurred ball blobs (quadratic
    // residual there 3.6-7.5 px, cubic 1.7-3.1 px).
    const sign = [1, -1, -1, 1, 1, -1, 1, -1, -1, 1];
    const path = (t, i) => {
      const Z = 2.5 - 6 * t;
      const j = 2.5 * sign[i % 10];
      return { x: 320 + (900 * 0.3 * t) / Z + j, y: 180 + (900 * (0.9 - t + 4.9 * t * t)) / Z - j, area: 6 };
    };
    const lockedWith = (lockCubic) => {
      const tr = tracker();
      tr.lockCubic = lockCubic;
      let locked = 0;
      for (let i = 0; i < 21; i++) {
        const hit = tr.update([path(i / 60, i)], i / 60);
        if (hit && hit.locked) locked++;
      }
      return locked;
    };
    expect(lockedWith(0)).toBe(0);
    expect(lockedWith(1.5)).toBeGreaterThan(8);
  });
});

describe("end-on view", () => {
  test("the cubic lock is off by default, and when turned on it applies to an end-on view only", () => {
    const END_ON = [{ x: 358, y: 311 }, { x: 615, y: 320 }, { x: 733, y: 273 }, { x: 551, y: 268 }];
    const pipe = new Pipeline();
    pipe.setVideoSize(1068, 600);
    pipe.setCalibration(END_ON);
    expect(pipe.tracker.lockCubic).toBe(0);
    pipe.setEndOnCubic(true);
    expect(pipe.tracker.lockCubic).toBeGreaterThan(0);
    pipe.setCalibration(CORNERS.map((p) => ({ x: p.x * (1068 / 1920), y: p.y * (600 / 1080) })));
    expect(pipe.tracker.lockCubic).toBe(0);
  });
});

// Synthetic 640x360 frames for a 1920x1080 video: a flat blue table colour (or a cluttered room),
// optionally shifted like a hand-held phone, with a small white ball on a parabola.
function frames({ room = false, shake = false, n = 90, ball = [250, 250, 250] }) {
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
      rgba[o] = ball[0];
      rgba[o + 1] = ball[1];
      rgba[o + 2] = ball[2];
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

describe("ball colour setting", () => {
  const runColor = (ballColor, ball) => {
    const p = new Pipeline({ ballColor });
    p.setVideoSize(1920, 1080);
    p.setCalibration(CORNERS);
    let locked = 0, hint = null;
    for (const { t, rgba } of frames({ ball, n: 150 })) {
      p.processPixels(rgba, t);
      const s = p.snapshot(t);
      if (s.ball.lock) locked++;
      hint = s.colorHint;
    }
    return { locked, hint };
  };

  test("orange chosen: an orange ball is locked with no hint; a white ball is not locked and the hint asks to check the colour", () => {
    const orange = runColor("orange", [235, 135, 30]);
    expect(orange.locked).toBeGreaterThan(30);
    expect(orange.hint).toBeNull();
    const white = runColor("orange", [250, 250, 250]);
    expect(white.locked).toBe(0);
    expect(white.hint).toBe("공 색이 흰색 같아요");
    // white chosen never shows the hint
    expect(runColor("white", [250, 250, 250]).hint ?? null).toBeNull();
  });
});

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
