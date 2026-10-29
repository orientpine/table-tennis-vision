import { expect, test } from "bun:test";
import { apply, makeCalibration, TABLE_LENGTH } from "../public/js/geom.js";
import { Players, plausiblePerson, wristAngle } from "../public/js/players.js";

const CORNERS = [
  { x: 356, y: 634 },
  { x: 482, y: 520 },
  { x: 1370, y: 532 },
  { x: 1484, y: 660 },
];

// A standing person whose feet are at floor point (tx, ty) in table metres.
function standingAt(cal, tx, ty, jitter = 0, rand = Math.random) {
  const f = apply(cal.floorToImage, { x: tx, y: ty });
  const j = () => (rand() - 0.5) * 2 * jitter;
  const x = f.x + j();
  const y = f.y + j();
  const lm = Array.from({ length: 33 }, () => ({ x, y: y - 300, v: 0.9 }));
  lm[11] = { x: x - 20 + j(), y: y - 260 + j(), v: 0.95 };
  lm[12] = { x: x + 20 + j(), y: y - 260 + j(), v: 0.95 };
  lm[23] = { x: x - 15 + j(), y: y - 160 + j(), v: 0.95 };
  lm[24] = { x: x + 15 + j(), y: y - 160 + j(), v: 0.95 };
  lm[25] = { x: x - 15 + j(), y: y - 80 + j(), v: 0.9 };
  lm[26] = { x: x + 15 + j(), y: y - 80 + j(), v: 0.9 };
  lm[27] = { x: x - 12 + j(), y: y + j(), v: 0.9 };
  lm[28] = { x: x + 12 + j(), y: y + j(), v: 0.9 };
  return lm;
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function person(x) {
  const lm = Array.from({ length: 33 }, () => ({ x, y: 300, v: 1 }));
  lm[11] = { x: x - 20, y: 300, v: 1 };
  lm[12] = { x: x + 20, y: 300, v: 1 };
  lm[23] = { x: x - 15, y: 400, v: 1 };
  lm[24] = { x: x + 15, y: 400, v: 1 };
  lm[27] = { x: x - 15, y: 550, v: 1 };
  lm[28] = { x: x + 15, y: 550, v: 1 };
  return lm;
}

test("a lone first-seen person goes to the slot of the table end they stand at", () => {
  const cal = makeCalibration([
    { x: 356, y: 634 },
    { x: 482, y: 520 },
    { x: 1370, y: 532 },
    { x: 1484, y: 660 },
  ]);
  const players = new Players();
  const rightOnly = person(1600);
  players.update(0, [rightOnly], cal);
  expect(players.far.landmarks).toBe(rightOnly);
  expect(players.near.landmarks).toBeNull();
});

test("a toy-like detection (torso and legs not confidently seen) is not a player", () => {
  const cal = makeCalibration(CORNERS);
  const real = standingAt(cal, -1, 0.7);
  expect(plausiblePerson(real, cal)).toBe(true);
  const toy = real.map((p, i) => (i >= 23 ? { ...p, v: 0.3 } : p));
  expect(plausiblePerson(toy, cal)).toBe(false);
  const players = new Players();
  players.update(0, [toy], cal);
  expect(players.near.landmarks).toBeNull();
  expect(players.far.landmarks).toBeNull();
  // feet far away from any place a player could stand at this table
  expect(plausiblePerson(standingAt(cal, TABLE_LENGTH + 9, 0.7), cal)).toBe(false);
});

test("MOVE: standing still with landmark jitter adds ~0; walking 1 m along the table reads ~1 m", () => {
  const cal = makeCalibration(CORNERS);
  const rand = seeded(11);
  const still = new Players();
  for (let i = 0; i < 90; i++) still.update(i / 30, [standingAt(cal, -1, 0.7, 4, rand)], cal);
  expect(still.state().near.moveM).toBeLessThanOrEqual(0.1);

  const walk = new Players();
  for (let i = 0; i <= 60; i++) walk.update(i / 30, [standingAt(cal, -1, 0.2 + Math.min(1, i / 40), 4, rand)], cal);
  const m = walk.state().near.moveM;
  expect(m).toBeGreaterThanOrEqual(0.8);
  expect(m).toBeLessThanOrEqual(1.2);
});

test("MOVE is not shown without a calibrated table", () => {
  const players = new Players();
  players.update(0, [person(200)], null);
  expect(players.state().near.moveM).toBeNull();
});

test("wrist angle: straight forearm-to-hand is ~0, a right-angle bend is ~90, unseen is null", () => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0.9 }));
  lm[14] = { x: 100, y: 100, v: 0.9 };
  lm[16] = { x: 150, y: 100, v: 0.9 };
  lm[18] = { x: 165, y: 104, v: 0.9 };
  lm[20] = { x: 165, y: 96, v: 0.9 };
  expect(wristAngle(lm, "R")).toBeLessThan(3);
  lm[18] = { x: 146, y: 115, v: 0.9 };
  lm[20] = { x: 154, y: 115, v: 0.9 };
  expect(Math.abs(wristAngle(lm, "R") - 90)).toBeLessThan(3);
  lm[16] = { ...lm[16], v: 0.2 };
  expect(wristAngle(lm, "R")).toBeNull();
});

test("swap keeps each person's identity and stats, also when only one person is visible", () => {
  const players = new Players();
  const left = person(200);
  const right = person(1500);
  players.update(0, [left, right], null);
  players.near.moveM = 3;
  expect(players.near.landmarks).toBe(left);
  expect(players.far.landmarks).toBe(right);

  players.swap();
  expect(players.near.landmarks).toBe(right);
  expect(players.far.landmarks).toBe(left);
  expect(players.far.moveM).toBe(3);

  players.update(0.1, [left, right], null);
  expect(players.near.landmarks).toBe(right);
  expect(players.far.landmarks).toBe(left);

  const leftAgain = person(205);
  players.update(0.2, [leftAgain], null);
  expect(players.far.landmarks).toBe(leftAgain);
  expect(players.near.landmarks).toBe(right);
  expect(players.near.seenT).toBe(0.1);
});
