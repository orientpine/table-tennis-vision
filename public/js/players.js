import { apply, dist, mid, TABLE_LENGTH, TABLE_WIDTH } from "./geom.js";

const TORSO_M = 0.5;
// Movement: the foot point on the floor, in table metres, median of the last few pose samples;
// distance is added only once that point has moved MOVE_STEP_M from where it was last counted,
// so standing still (landmark jitter of a few cm) adds nothing. A jump faster than a person can
// move (a mis-detection or a swap) moves the anchor without adding distance.
const MOVE_STEP_M = 0.15;
const MOVE_MEDIAN = 5;
const MOVE_MAX_MPS = 7;
// A detection counts as a person only with a confidently seen torso and legs; furniture and toys
// come back from the pose model with low visibility on those points. On a calibrated table the
// feet must also be somewhere a player can stand.
const BODY_VIS = 0.6;
const LEG_VIS = 0.5;
const ZONE_M = 4;
const WRIST_VIS = 0.5;

export function plausiblePerson(lm, cal) {
  if (!lm || lm.length < 29) return false;
  if (![11, 12, 23, 24].every((i) => lm[i] && lm[i].v >= BODY_VIS)) return false;
  if (![25, 26, 27, 28].some((i) => lm[i] && lm[i].v >= LEG_VIS)) return false;
  if (!cal || !cal.floorToTable) return true;
  const f = apply(cal.floorToTable, foot(lm));
  return f.x > -ZONE_M && f.x < TABLE_LENGTH + ZONE_M && f.y > -ZONE_M && f.y < TABLE_WIDTH + ZONE_M;
}

// Bend of the racket-hand wrist in degrees: the angle between the forearm (elbow -> wrist) and
// the hand (wrist -> middle of index and pinky knuckles), 0 = straight. null when any of those
// points is not confidently seen. The pose model's hand points are coarse, so this is an estimate.
export function wristAngle(lm, hand) {
  const [e, w, ix, pk] = hand === "L" ? [13, 15, 19, 17] : [14, 16, 20, 18];
  const E = lm[e], W = lm[w], I = lm[ix], P = lm[pk];
  if (!E || !W || !I || E.v < WRIST_VIS || W.v < WRIST_VIS || I.v < WRIST_VIS) return null;
  const H = P && P.v >= WRIST_VIS ? mid(I, P) : I;
  const ax = W.x - E.x, ay = W.y - E.y, bx = H.x - W.x, by = H.y - W.y;
  const na = Math.hypot(ax, ay), nb = Math.hypot(bx, by);
  if (na < 4 || nb < 2) return null;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (na * nb)));
  return (Math.acos(c) * 180) / Math.PI;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1];
}

function torsoPx(lm) {
  const sh = mid(lm[11], lm[12]);
  const hp = mid(lm[23], lm[24]);
  return dist(sh, hp);
}

function anchor(lm) {
  return mid(lm[23], lm[24]);
}

function foot(lm) {
  const a = lm[27];
  const b = lm[28];
  if (a.v > 0.3 && b.v > 0.3) return mid(a, b);
  if (a.v > 0.5) return a;
  if (b.v > 0.5) return b;
  return anchor(lm);
}

function newPlayer(side, label) {
  return {
    side,
    label,
    hand: "R",
    landmarks: null,
    seenT: -Infinity,
    scale: null,
    moveM: 0,
    lastAnchor: null,
    footHist: [],
    moveAnchor: null,
    wristDeg: null,
    wristDegHist: [],
    wristKmh: null,
    shotWristKmh: null,
    shotKmh: null,
    wristHist: [],
    lmHist: [],
  };
}

export class Players {
  constructor() {
    this.near = newPlayer("near", "앞쪽(나)");
    this.far = newPlayer("far", "건너편(상대)");
    this.swapped = false;
    this.cal = null;
  }

  reset() {
    for (const p of [this.near, this.far]) {
      p.moveM = 0;
      p.lastAnchor = null;
      p.footHist = [];
      p.moveAnchor = null;
      p.wristDeg = null;
      p.wristDegHist = [];
      p.wristKmh = null;
      p.shotWristKmh = null;
      p.shotKmh = null;
      p.wristHist = [];
      p.lmHist = [];
    }
  }

  swap() {
    this.swapped = !this.swapped;
    for (const key of ["landmarks", "seenT", "scale", "lastAnchor", "footHist", "moveAnchor", "wristDeg", "wristDegHist", "wristHist", "lmHist", "hand", "moveM", "wristKmh", "shotWristKmh", "shotKmh"]) {
      [this.near[key], this.far[key]] = [this.far[key], this.near[key]];
    }
  }

  // Each detected pose goes to the player whose end of the table its feet are closer to; with
  // no calibration the left-most person is "near".
  assign(poses, cal) {
    poses = poses.filter((lm) => plausiblePerson(lm, cal));
    if (!poses.length) return [null, null];
    const score = (lm) => {
      const f = foot(lm);
      if (cal) return dist(f, cal.myEnd) - dist(f, cal.oppEnd);
      return f.x;
    };
    const sorted = [...poses].sort((a, b) => score(a) - score(b));
    let near = sorted[0];
    let far = sorted.length > 1 ? sorted[sorted.length - 1] : null;
    if (sorted.length === 1) {
      // One person visible: keep them in whichever slot they were tracked in last. Those slots
      // already reflect any swap, so the swap flip below must not be applied again.
      const lm = sorted[0];
      const prevNear = this.near.landmarks && dist(anchor(this.near.landmarks), anchor(lm));
      const prevFar = this.far.landmarks && dist(anchor(this.far.landmarks), anchor(lm));
      if (prevNear != null || prevFar != null) {
        return prevFar != null && (prevNear == null || prevFar < prevNear) ? [null, lm] : [lm, null];
      }
      if (cal && score(lm) > 0) [near, far] = [null, lm];
    }
    return this.swapped ? [far, near] : [near, far];
  }

  update(t, poses, cal) {
    this.cal = cal;
    const [nearLm, farLm] = this.assign(poses, cal);
    this.updateOne(this.near, nearLm, t, cal);
    this.updateOne(this.far, farLm, t, cal);
  }

  updateOne(p, lm, t, cal = null) {
    if (!lm) {
      if (t - p.seenT > 0.5) {
        p.landmarks = null;
        p.wristDeg = null;
      }
      return;
    }
    const tp = torsoPx(lm);
    if (tp > 4) p.scale = p.scale == null ? TORSO_M / tp : 0.9 * p.scale + 0.1 * (TORSO_M / tp);
    p.lastAnchor = anchor(lm);
    // Only both ankles seen give a floor point: a single ankle or the hip fallback sits above the
    // floor and maps metres away, and alternating between them added fake steps (test_2 near
    // player at the frame edge: 5.7 m in 4 s).
    if (cal && cal.floorToTable && lm[27].v >= LEG_VIS && lm[28].v >= LEG_VIS) this.trackMove(p, apply(cal.floorToTable, mid(lm[27], lm[28])), t);
    const deg = wristAngle(lm, p.hand);
    if (deg != null) p.wristDegHist.push({ t, deg });
    while (p.wristDegHist.length && t - p.wristDegHist[0].t > 0.5) p.wristDegHist.shift();
    p.wristDeg = p.wristDegHist.length >= 2 ? Math.round(median(p.wristDegHist.map((h) => h.deg))) : null;
    const w = lm[p.hand === "L" ? 15 : 16];
    const prev = p.landmarks;
    if (prev && w.v > 0.4 && t > p.seenT) {
      const pw = prev[p.hand === "L" ? 15 : 16];
      const v = (dist(w, pw) * (p.scale || 0)) / (t - p.seenT);
      const kmh = v * 3.6;
      if (kmh < 120) {
        p.wristHist.push({ t, kmh });
        if (p.wristHist.length > 120) p.wristHist.shift();
      }
    }
    p.lmHist.push({ t, lm });
    if (p.lmHist.length > 30) p.lmHist.shift();
    p.landmarks = lm;
    p.seenT = t;
  }

  trackMove(p, f, t) {
    if (p.footHist.length && t - p.footHist[p.footHist.length - 1].t > 0.5) p.footHist = [];
    p.footHist.push({ x: f.x, y: f.y, t });
    if (p.footHist.length > MOVE_MEDIAN) p.footHist.shift();
    if (p.footHist.length < MOVE_MEDIAN) return;
    const here = { x: median(p.footHist.map((h) => h.x)), y: median(p.footHist.map((h) => h.y)), t };
    const a = p.moveAnchor;
    if (!a) {
      p.moveAnchor = here;
      return;
    }
    const d = dist(here, a);
    if (d < MOVE_STEP_M) return;
    if (d / Math.max(1e-3, t - a.t) <= MOVE_MAX_MPS) p.moveM += d;
    p.moveAnchor = here;
  }

  peakWrist(side, t0, t1) {
    const hist = this[side].wristHist.filter((h) => h.t >= t0 && h.t <= t1);
    return hist.length ? Math.round(Math.max(...hist.map((h) => h.kmh))) : null;
  }

  landmarksAt(side, t) {
    const hist = this[side].lmHist;
    let best = null;
    for (const h of hist) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    return best ? best.lm : this[side].landmarks;
  }

  forRally() {
    const view = (side) => ({
      hand: this[side].hand,
      landmarks: this[side].landmarks,
      landmarksAtHit: (t) => this.landmarksAt(side, t),
    });
    return { near: view("near"), far: view("far") };
  }

  onShot(shot) {
    const p = this[shot.side];
    p.shotWristKmh = this.peakWrist(shot.side, shot.t - 0.3, shot.t + 0.1);
    if (p.shotWristKmh != null) p.wristKmh = p.shotWristKmh;
    if (shot.speedKmh != null) p.shotKmh = shot.speedKmh;
  }

  state() {
    const one = (p) => ({
      label: p.label,
      hand: p.hand,
      landmarks: p.landmarks,
      moveM: this.cal ? Math.round(p.moveM * 10) / 10 : null,
      wristDeg: p.landmarks ? p.wristDeg : null,
      wristKmh: p.wristKmh,
      shotKmh: p.shotKmh,
    });
    return { near: one(this.near), far: one(this.far) };
  }
}
