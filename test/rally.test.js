import { describe, expect, test } from "bun:test";
import { apply, makeCalibration, TABLE_LENGTH, TABLE_WIDTH } from "../public/js/geom.js";
import { classifyKind, RallyEngine, strokeSide } from "../public/js/rally.js";

const CORNERS = [
  { x: 356, y: 634 },
  { x: 482, y: 520 },
  { x: 1370, y: 532 },
  { x: 1484, y: 660 },
];

describe("geom", () => {
  test("homography maps tapped corners to table corners in any tap order within an end", () => {
    for (const corners of [CORNERS, [CORNERS[1], CORNERS[0], CORNERS[3], CORNERS[2]], [CORNERS[0], CORNERS[1], CORNERS[3], CORNERS[2]]]) {
      const cal = makeCalibration(corners);
      const ends = corners.map((c) => apply(cal.toTable, c));
      expect(ends[0].x).toBeCloseTo(0, 6);
      expect(ends[1].x).toBeCloseTo(0, 6);
      expect(ends[2].x).toBeCloseTo(TABLE_LENGTH, 6);
      expect(ends[3].x).toBeCloseTo(TABLE_LENGTH, 6);
      const widths = [ends[0].y, ends[1].y].sort((a, b) => a - b);
      expect(widths[0]).toBeCloseTo(0, 6);
      expect(widths[1]).toBeCloseTo(TABLE_WIDTH, 6);
    }
  });
});

function simulate(cal, legs, fps = 60) {
  const pxPerM = cal.lengthPx / TABLE_LENGTH;
  const frames = [];
  let t = 0;
  for (const { from, to, bounceAt, duration, apex } of legs) {
    const n = Math.round(duration * fps);
    for (let i = 0; i < n; i++) {
      const s = i / n;
      const tx = from + (to - from) * s;
      const sb = (bounceAt - from) / (to - from);
      const h = s < sb ? apex * (1 - (s / sb) ** 2) : apex * 0.6 * Math.sin((Math.PI * (s - sb)) / (1 - sb));
      const p = apply(cal.toImage, { x: tx, y: TABLE_WIDTH / 2 });
      frames.push({ t, ball: { x: p.x, y: p.y - Math.max(0, h) * pxPerM } });
      t += 1 / fps;
    }
  }
  return frames;
}

describe("RallyEngine", () => {
  test("counts shots by direction reversals and bounces on each side, then ends the rally", () => {
    const cal = makeCalibration(CORNERS);
    const events = [];
    const eng = new RallyEngine({ calibration: cal, onEvent: (e) => events.push(e) });
    const frames = simulate(cal, [
      { from: 0.1, to: 2.7, bounceAt: 2.0, duration: 0.45, apex: 0.25 },
      { from: 2.7, to: 0.1, bounceAt: 0.8, duration: 0.45, apex: 0.25 },
    ]);
    for (const f of frames) eng.update(f.t, f.ball, null);
    eng.update(frames[frames.length - 1].t + 2, null, null);
    const shots = events.filter((e) => e.type === "shot");
    const bounces = events.filter((e) => e.type === "bounce");
    const end = events.find((e) => e.type === "rallyEnd");
    expect(shots.map((s) => s.shot.side)).toEqual(["near", "far"]);
    expect(bounces.map((b) => b.bounce.side)).toEqual(["far", "near"]);
    expect(bounces[0].bounce.tx).toBeGreaterThan(1.8);
    expect(bounces[0].bounce.tx).toBeLessThan(2.2);
    expect(end.shots).toBe(2);
    const expected = (2.6 / 0.45) * 3.6;
    expect(end.maxSpeedKmh).toBeGreaterThan(expected * 0.8);
    expect(end.maxSpeedKmh).toBeLessThan(expected * 1.2);
  });
});

test("infers the hit from opposite-side bounces when the ball is lost at the paddle", () => {
  const cal = makeCalibration(CORNERS);
  const events = [];
  const eng = new RallyEngine({ calibration: cal, onEvent: (e) => events.push(e) });
  const frames = simulate(cal, [
    { from: 0.1, to: 2.7, bounceAt: 2.0, duration: 0.45, apex: 0.25 },
    { from: 2.7, to: 0.1, bounceAt: 0.8, duration: 0.45, apex: 0.25 },
  ], 30);
  const half = frames.length / 2;
  frames.forEach((f, i) => {
    if (i >= half - 1 && i < half + 6) return;
    eng.update(f.t, { ...f.ball, id: i < half ? 1 : 2 }, null);
  });
  eng.update(frames[frames.length - 1].t + 2, null, null);
  const bounces = events.filter((e) => e.type === "bounce").map((e) => e.bounce.side);
  const end = events.find((e) => e.type === "rallyEnd");
  expect(bounces).toEqual(["far", "near"]);
  expect(end.shots).toBe(2);
});

test("a shot's speed is frozen once it lands on the receiver's side", () => {
  const cal = makeCalibration(CORNERS);
  const events = [];
  const eng = new RallyEngine({ calibration: cal, onEvent: (e) => events.push(e) });
  const frames = simulate(cal, [{ from: 0.1, to: 2.7, bounceAt: 2.0, duration: 0.45, apex: 0.25 }]);
  for (const f of frames) eng.update(f.t, f.ball, null);
  const landedSpeed = events.filter((e) => e.type === "shotUpdate").pop().shot.speedKmh;
  const last = frames[frames.length - 1];
  const midTable = apply(cal.toImage, { x: 1.4, y: TABLE_WIDTH / 2 });
  for (let i = 1; i <= 20; i++) eng.update(last.t + i / 60, { x: midTable.x, y: midTable.y - 60 }, null);
  const shot = events.filter((e) => e.type === "shot" || e.type === "shotUpdate").pop().shot;
  expect(shot.speedKmh).toBe(landedSpeed);
  expect(landedSpeed).toBeGreaterThan(((2.6 / 0.45) * 3.6) * 0.8);
});

test("a serve's own-side bounce then opponent-side bounce is one shot, not two", () => {
  const cal = makeCalibration(CORNERS);
  const events = [];
  const eng = new RallyEngine({ calibration: cal, onEvent: (e) => events.push(e) });
  const pxPerM = cal.lengthPx / TABLE_LENGTH;
  const height = (tx) => {
    if (tx < 0.6) return 0.15 * (1 - ((tx - 0.1) / 0.5) ** 2) * ((0.6 - tx) / 0.5) + 0.0;
    if (tx < 2.1) return 0.25 * Math.sin((Math.PI * (tx - 0.6)) / 1.5);
    return 0.2 * Math.sin((Math.PI * (tx - 2.1)) / 1.2);
  };
  const n = 36;
  let t = 0;
  for (let i = 0; i <= n; i++) {
    const tx = 0.1 + (2.6 * i) / n;
    const p = apply(cal.toImage, { x: tx, y: TABLE_WIDTH / 2 });
    eng.update(t, { x: p.x, y: p.y - height(tx) * pxPerM, id: 1 }, null);
    t += 1 / 60;
  }
  eng.update(t + 2, null, null);
  const bounces = events.filter((e) => e.type === "bounce").map((e) => e.bounce.side);
  const end = events.find((e) => e.type === "rallyEnd");
  expect(bounces).toEqual(["near", "far"]);
  expect(end.shots).toBe(1);
});

test("the HUD keeps showing the last measured shot while a new shot is still unmeasured", () => {
  const cal = makeCalibration(CORNERS);
  const eng = new RallyEngine({ calibration: cal });
  const frames = simulate(cal, [
    { from: 0.1, to: 2.7, bounceAt: 2.0, duration: 0.45, apex: 0.25 },
    { from: 2.7, to: 0.1, bounceAt: 0.8, duration: 0.45, apex: 0.25 },
  ]);
  let sawGap = false;
  for (const f of frames) {
    eng.update(f.t, { ...f.ball, id: 1 }, null);
    const snap = eng.snapshot(f.t);
    const newest = eng.rally.shots[eng.rally.shots.length - 1];
    if (snap && eng.rally.shots.length === 2 && newest.speedKmh == null) {
      sawGap = true;
      expect(snap.speedKmh).toBe(eng.rally.shots[0].speedKmh);
      expect(snap.speedKmh).not.toBeNull();
    }
  }
  expect(sawGap).toBe(true);
});

describe("shot labels", () => {
  test("forehand vs backhand follows the racket wrist side relative to the shoulders", () => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 1 }));
    lm[11] = { x: 100, y: 100, v: 1 };
    lm[12] = { x: 140, y: 100, v: 1 };
    lm[16] = { x: 180, y: 130, v: 1 };
    expect(strokeSide(lm, "R")).toBe("포핸드");
    lm[16] = { x: 70, y: 130, v: 1 };
    expect(strokeSide(lm, "R")).toBe("백핸드");
    lm[15] = { x: 70, y: 130, v: 1 };
    expect(strokeSide(lm, "L")).toBe("포핸드");
  });

  test("kind by speed and arc", () => {
    expect(classifyKind(50, 0)).toBe("스매시");
    expect(classifyKind(20, 0.4)).toBe("로빙");
    expect(classifyKind(30, 0.1)).toBe("드라이브");
    expect(classifyKind(12, 0.1)).toBe("푸시");
  });
});
