import { expect, test } from "bun:test";
import { judgePoint, suspects } from "../public/js/point.js";
import { netKink } from "../public/js/rally.js";

const shot = (side, t) => ({ side, t });
const bounce = (side, t) => ({ side, t });
// near serves at 0: own side 0.2, far side 0.6; far returns at 1: near side 1.4.
const serveAndReturn = [bounce("near", 0.2), bounce("far", 0.6), bounce("near", 1.4)];

test("the side of the last bounce failed to return it: the other side wins", () => {
  const r = judgePoint({ shots: [shot("near", 0), shot("far", 1)], bounces: serveAndReturn });
  expect(r).toMatchObject({ winner: "far", loser: "near", reason: "no_return" });
});

test("a ball hit into the net or out leaves the hitter's side as the last bounce: the hitter loses", () => {
  const r = judgePoint({ shots: [shot("near", 0), shot("far", 1), shot("near", 1.6)], bounces: serveAndReturn });
  expect(r).toMatchObject({ winner: "far", loser: "near" });
});

test("a serve into the net bounces only on the server's side: the server loses", () => {
  expect(judgePoint({ shots: [shot("near", 0)], bounces: [bounce("near", 0.2)] })).toMatchObject({ winner: "far" });
});

test("two bounces on one side end the point there; later reversals of a rolling ball are ignored", () => {
  const r = judgePoint({
    shots: [shot("near", 0), shot("far", 1), shot("far", 2.2)],
    bounces: [...serveAndReturn, bounce("near", 1.8), bounce("far", 2.5)],
  });
  expect(r).toMatchObject({ winner: "far", loser: "near", reason: "double_bounce" });
});

test("a return into the net that drops back on the returner's side is a double on that side", () => {
  const r = judgePoint({ shots: [shot("near", 0), shot("far", 1), shot("near", 1.5)], bounces: [...serveAndReturn, bounce("near", 1.7)] });
  expect(r).toMatchObject({ winner: "far", reason: "double_bounce" });
});

test("a missed bounce: a shot from the other side between two same-side bounces keeps the rally going", () => {
  // After the serve and far's return (near 1.4), near returns at 1.6, far's bounce is missed,
  // far returns at 2.0, the ball lands near at 2.4 and near misses it.
  const r = judgePoint({
    shots: [shot("near", 0), shot("far", 1), shot("near", 1.6), shot("far", 2.0)],
    bounces: [...serveAndReturn, bounce("near", 2.4)],
  });
  expect(r).toMatchObject({ winner: "far", loser: "near", reason: "no_return" });
  const withoutRepair = judgePoint({ shots: [shot("near", 0), shot("far", 1)], bounces: [...serveAndReturn, bounce("near", 2.4)] });
  expect(withoutRepair).toMatchObject({ reason: "double_bounce" });
});

test("only a double bounce or a rally with three or more bounces is sure", () => {
  expect(judgePoint({ shots: [shot("near", 0)], bounces: [bounce("near", 0.2), bounce("far", 0.6)] }).sure).toBe(false);
  expect(judgePoint({ shots: [shot("near", 0), shot("far", 1)], bounces: serveAndReturn }).sure).toBe(true);
  expect(judgePoint({ shots: [shot("near", 0)], bounces: [bounce("near", 0.2), bounce("near", 0.5)] })).toMatchObject({ reason: "double_bounce", sure: true });
});

test("nothing to judge without a bounce", () => {
  expect(judgePoint({ shots: [shot("near", 0)], bounces: [] })).toBeNull();
  expect(judgePoint()).toBeNull();
});

test("events are read in time order even if they arrive unsorted", () => {
  const r = judgePoint({ shots: [shot("far", 1), shot("near", 0)], bounces: [bounce("near", 1.4), bounce("near", 0.2), bounce("far", 0.6)] });
  expect(r).toMatchObject({ winner: "far", reason: "no_return" });
});

test("fault? only when the serve's first bounce is on the receiver's side and its own half was well tracked", () => {
  const wellSeen = { pts: 13, spanS: 0.3, maxGapS: 0.03 };
  expect(suspects({ shots: [shot("near", 0)], bounces: serveAndReturn, serveSeen: wellSeen })).toMatchObject({ fault: false, let: false, server: "near" });
  expect(suspects({ shots: [shot("near", 0)], bounces: [bounce("far", 0.6)], serveSeen: wellSeen })).toMatchObject({ fault: true, let: false });
  expect(suspects({ shots: [shot("near", 0)], bounces: [bounce("far", 0.6)] }).fault).toBe(false);
  expect(suspects({ shots: [shot("near", 0)], bounces: [bounce("far", 0.6)], serveSeen: { pts: 6, spanS: 0.1, maxGapS: 0.03 } }).fault).toBe(false);
  expect(suspects({ shots: [shot("near", 0)], bounces: [bounce("far", 0.6)], serveSeen: { pts: 13, spanS: 0.3, maxGapS: 0.2 } }).fault).toBe(false);
  expect(suspects({ shots: [shot("near", 0)], bounces: [bounce("far", 0.6)], serveNet: { ratio: 0.3 } })).toMatchObject({ fault: false, let: true });
  expect(suspects({ shots: [shot("near", 0)], bounces: serveAndReturn, serveNet: { ratio: 0.3 } }).let).toBe(false);
  expect(suspects({ shots: [], bounces: serveAndReturn })).toMatchObject({ fault: false, let: false, server: null });
});

test("netKink: steady speed across the net is ~1, a sharp slow-down at the net is well below 1", () => {
  const path = (vAfter) => Array.from({ length: 24 }, (_, i) => {
    const t = i / 60;
    const along = t < 0.2 ? 0.8 + 4 * t : 1.6 + vAfter * (t - 0.2);
    return { t, along };
  });
  expect(netKink(path(4)).ratio).toBeCloseTo(1, 1);
  expect(netKink(path(1.2)).ratio).toBeLessThan(0.55);
  expect(netKink(path(4).slice(0, 5))).toBeNull();
});
