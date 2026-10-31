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

test("a lone person at the far end goes to far even when only the near slot remembers someone", () => {
  // At a low pose rate the far player can go unseen for over 0.5 s (their slot is cleared)
  // while the near player is still remembered; the next lone detection of the far player must
  // not be put in the near slot.
  const cal = makeCalibration(CORNERS);
  const players = new Players();
  const left = person(250);
  const right = person(1600);
  players.update(0, [left, right], cal);
  players.update(0.8, [left], cal);
  expect(players.far.landmarks).toBeNull();
  players.update(1.0, [right], cal);
  expect(players.far.landmarks).toBe(right);
  expect(players.near.landmarks).toBe(left);
});

test("a player missed for a moment is not called off screen; after 2 s unseen they are", () => {
  const cal = makeCalibration(CORNERS);
  const players = new Players();
  players.update(0, [person(250), person(1600)], cal);
  players.update(1.0, [person(1600)], cal);
  expect(players.state().near).toMatchObject({ landmarks: null, offscreen: false });
  players.update(2.5, [person(1600)], cal);
  expect(players.state().near.offscreen).toBe(true);
  expect(new Players().state().near.offscreen).toBe(true);
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

test("stand: the MOVE floor point, metres behind the nearer end line; dimmed once the feet go unseen, then hidden", () => {
  const cal = makeCalibration(CORNERS);
  const rand = seeded(5);
  const players = new Players();
  for (let i = 0; i < 30; i++) players.update(i / 30, [standingAt(cal, -1.2, 0.4, 3, rand), standingAt(cal, TABLE_LENGTH + 2, 1.2, 3, rand)], cal);
  const near = players.state().near.stand;
  const far = players.state().far.stand;
  expect(near).toMatchObject({ end: "near", stale: false });
  expect(near.behindM).toBeCloseTo(1.2, 1);
  expect(near.sideM).toBeCloseTo(0.4 - 1.525 / 2, 1);
  expect(far).toMatchObject({ end: "far", stale: false });
  expect(far.behindM).toBeCloseTo(2, 1);
  // the marker sits where the feet are in the picture
  const feet = apply(cal.floorToImage, { x: -1.2, y: 0.4 });
  expect(Math.hypot(near.img.x - feet.x, near.img.y - feet.y)).toBeLessThan(10);
  // feet out of sight (no two-ankle sample): kept but dimmed, gone after 3 s
  players.update(1.6, [], cal);
  expect(players.state().near.stand.stale).toBe(true);
  players.update(4.5, [], cal);
  expect(players.state().near.stand).toBeNull();
  expect(new Players().state().near.stand).toBeNull();
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

// The near / far slots are the table's ends (their red / blue colour and place stay put): a swap
// moves the players' own settings (racket hand, distance moved) to the other end, never the tracking.
test("swap trades the players between the ends; whoever stands at an end stays in that end's slot", () => {
  const players = new Players();
  const left = person(200);
  const right = person(1500);
  players.update(0, [left, right], null);
  players.near.moveM = 3;
  players.near.hand = "L";
  expect(players.near.landmarks).toBe(left);
  expect(players.far.landmarks).toBe(right);

  players.swap();
  expect(players.near.landmarks).toBe(left);
  expect(players.far.landmarks).toBe(right);
  expect([players.near.hand, players.far.hand]).toEqual(["R", "L"]);
  expect(players.far.moveM).toBe(3);

  players.update(0.1, [left, right], null);
  expect(players.near.landmarks).toBe(left);
  expect(players.far.landmarks).toBe(right);
});
