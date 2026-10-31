import { describe, expect, test } from "bun:test";
import { LOW_LIGHT, SMALL_TABLE, STARVE, StarveWatch, frameLuma, frameSig, quadFraction } from "../public/js/guards.js";

const frame = (w, h, fill) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const [r, g, b] = fill(i); d.set([r, g, b, 255], i * 4); }
  return d;
};

describe("frameSig", () => {
  test("the same frame read twice gives the same value, a changed frame does not", () => {
    const a = frame(64, 36, (i) => [i % 251, (i * 7) % 253, 40]);
    const b = frame(64, 36, (i) => [(i + 1) % 251, (i * 7) % 253, 40]);
    expect(frameSig(a)).toBe(frameSig(a.slice()));
    expect(frameSig(a)).not.toBe(frameSig(b));
  });
});

describe("StarveWatch", () => {
  // one window of ticks at `fps`; with repeatEvery = k, every read except each k-th repeats the frame before
  const win = (w, start, fps, repeatEvery = 0) => {
    let t = start, out = null, n = 0;
    const step = 1000 / fps;
    while (t <= start + STARVE.windowMs + step) {
      n++;
      out = w.tick(t, true, repeatEvery && n % repeatEvery ? 7 : n) || out;
      t += step;
    }
    return { out, end: t };
  };
  // drive windows one after another; returns the actions in order
  // the clock carries on across calls on the same watcher
  const drive = (w, plan) => {
    let t = w._qaT || 0;
    const actions = [];
    for (const [fps, rep] of plan) { const r = win(w, t, fps, rep); if (r.out) actions.push(r.out.action); t = r.end; }
    w._qaT = t;
    return actions;
  };
  const good = (n) => Array(n).fill([20, 0]);
  test("healthy analysis (20 reads/s, new frames) stays full screen", () => {
    expect(drive(new StarveWatch(), good(8))).toEqual([]);
  });
  test("the first 10 s only set the phone's own baseline, even when bad", () => {
    expect(drive(new StarveWatch(), [[8, 0], [8, 0]])).toEqual([]);
  });
  test("mostly repeated frames make the picture small only after two windows in a row (10 s)", () => {
    expect(drive(new StarveWatch(), [...good(2), [20, 4]])).toEqual([]);
    expect(drive(new StarveWatch(), [...good(2), [20, 4], [20, 4]])).toEqual(["compact"]);
  });
  test("under 12 reads/s makes the picture small only after two windows in a row", () => {
    expect(drive(new StarveWatch(), [...good(2), [8, 0]])).toEqual([]);
    expect(drive(new StarveWatch(), [...good(2), [8, 0], [8, 0]])).toEqual(["compact"]);
  });
  test("bad windows with a good one between them do not switch", () => {
    expect(drive(new StarveWatch(), [...good(2), [8, 0], [20, 0], [8, 0], [20, 0]])).toEqual([]);
  });
  test("a drop below the first 10 s does not switch (owner decision): 19 of 30 reads/s, 0% repeats, many windows", () => {
    expect(drive(new StarveWatch(), [[30, 0], [30, 0], [19, 0], [19, 0], [19, 0], [19, 0]])).toEqual([]);
  });
  test("the 15% rule is one value: dropFromBase 0.15 brings it back, still two windows in a row", () => {
    expect(drive(new StarveWatch({ dropFromBase: 0.15 }), [...good(2), [16, 0]])).toEqual([]);
    expect(drive(new StarveWatch({ dropFromBase: 0.15 }), [...good(2), [16, 0], [16, 0]])).toEqual(["compact"]);
    expect(drive(new StarveWatch({ dropFromBase: 0.15 }), [...good(2), [18, 0], [18, 0], [18, 0]])).toEqual([]);
  });
  test("30 s of good windows bring the full screen back; bad again stays small for the run", () => {
    const w = new StarveWatch();
    expect(drive(w, [...good(2), [8, 0], [8, 0], ...good(6), [8, 0], [8, 0], ...good(10)])).toEqual(["compact", "full", "stay"]);
    expect(w.compact && w.locked).toBe(true);
  });
  test("a bad window while small restarts the 30 s count", () => {
    const w = new StarveWatch();
    expect(drive(w, [...good(2), [8, 0], [8, 0], ...good(5), [8, 0], ...good(5)])).toEqual(["compact"]);
    expect(w.compact).toBe(true);
  });
  test("the chip tap (dismiss) goes full screen and nothing switches again this run", () => {
    const w = new StarveWatch();
    expect(drive(w, [...good(2), [8, 0], [8, 0]])).toEqual(["compact"]);
    w.dismiss();
    expect(w.compact).toBe(false);
    expect(drive(w, [[8, 0], [8, 0], [8, 0], [8, 0]])).toEqual([]);
    w.reset();
    expect(drive(w, [...good(2), [8, 0], [8, 0]])).toEqual(["compact"]);
  });
});

describe("frameLuma", () => {
  test("black letterbox bands do not count as darkness", () => {
    const lit = frame(40, 40, (i) => (i % 40 < 10 ? [0, 0, 0] : [90, 90, 90]));
    expect(frameLuma(lit)).toBeGreaterThan(LOW_LIGHT.luma);
  });
  test("a dim room reads below the low-light line", () => {
    const dim = frame(40, 40, () => [18, 20, 22]);
    expect(frameLuma(dim)).toBeLessThan(LOW_LIGHT.luma);
  });
});

describe("quadFraction", () => {
  const clip12 = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];
  test("the scoring 16:9 clip's table is above the small-table line", () => {
    expect(quadFraction(clip12, 1920, 1080)).toBeGreaterThan(SMALL_TABLE.frac);
  });
  test("the same scene padded into 9:16 (no point even on main) is below it", () => {
    const k = 540 / 1920, oy = (960 - 1080 * k) / 2;
    const pad = clip12.map((c) => ({ x: c.x * k, y: c.y * k + oy }));
    expect(quadFraction(pad, 540, 960)).toBeLessThan(SMALL_TABLE.frac);
  });
});
