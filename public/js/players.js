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
const OFFSCREEN_S = 2;
// Standing position: the same floor point MOVE counts from (median of the last MOVE_MEDIAN
// two-ankle samples). Older than STAND_STALE_S (the feet went out of sight) it is drawn dimmed;
// older than STAND_HIDE_S it is not shown.
const STAND_STALE_S = 0.5;
const STAND_HIDE_S = 3;

// Where a floor point (table metres, x along the table from my end, y across) is relative to
// the nearer end line: metres behind it (negative = beside the table), which end, and metres
// left/right of the centre line.
export function standPlace(f) {
  const atMyEnd = f.x < TABLE_LENGTH / 2;
  return { end: atMyEnd ? "near" : "far", behindM: atMyEnd ? -f.x : f.x - TABLE_LENGTH, sideM: f.y - TABLE_WIDTH / 2 };
}

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
    stand: null,
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
    // near / far are the table's two ends; app.js names them ("레드 · <name>" or "레드 사이드")
    this.near = newPlayer("near", "블루 사이드");
    this.far = newPlayer("far", "레드 사이드");
    this.cal = null;
  }

  reset() {
    for (const p of [this.near, this.far]) {
      p.moveM = 0;
      p.lastAnchor = null;
      p.footHist = [];
      p.moveAnchor = null;
      p.stand = null;
      p.wristDeg = null;
      p.wristDegHist = [];
      p.wristKmh = null;
      p.shotWristKmh = null;
      p.shotKmh = null;
      p.wristHist = [];
      p.lmHist = [];
    }
  }

  // The players trade ends (자리 교체 or the rules): their own settings go with them; who is tracked
  // at each end stays with that end.
  swap() {
    for (const key of ["hand", "moveM"]) {
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
      const lm = sorted[0];
      // On a calibrated table a lone person standing clearly behind one end belongs to that
      // end. Slot history alone put the far player in the near slot whenever only the near
      // slot was still remembered (the far one cleared after 0.5 s unseen at a low pose rate).
      if (cal && Math.abs(score(lm)) > cal.lengthPx * 0.3) {
        return score(lm) < 0 ? [lm, null] : [null, lm];
      }
      // Near the middle (or no calibration): keep them in whichever slot they were tracked in
      // last.

      const prevNear = this.near.landmarks && dist(anchor(this.near.landmarks), anchor(lm));
      const prevFar = this.far.landmarks && dist(anchor(this.far.landmarks), anchor(lm));
      if (prevNear != null || prevFar != null) {
        return prevFar != null && (prevNear == null || prevFar < prevNear) ? [null, lm] : [lm, null];
      }
      if (cal && score(lm) > 0) [near, far] = [null, lm];
    }
    return [near, far];
  }

  update(t, poses, cal) {
    this.cal = cal;
    this.t = t;
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
    const here = { x: median(p.footHist.map((h) => h.x)), y: median(p.footHist.map((h) => h.y)), t };
    // The standing point shows from the first two-ankle sample: on a side view the pose model
    // keeps both ankles of a player only a few frames in a row, so waiting for the full MOVE
    // median would hide it most of the time (test_2 clip in WebKit: 2-3 samples per run).
    p.stand = { x: here.x, y: here.y, t, cal: this.cal };
    if (p.footHist.length < MOVE_MEDIAN) return;
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

  standState(p) {
    const s = p.stand;
    if (!s || !this.cal || s.cal !== this.cal || !(this.t - s.t <= STAND_HIDE_S)) return null;
    const img = apply(this.cal.floorToImage, s);
    return { x: s.x, y: s.y, ...standPlace(s), img, stale: this.t - s.t > STAND_STALE_S };
  }

  state() {
    const one = (p) => ({
      label: p.label,
      hand: p.hand,
      landmarks: p.landmarks,
      // The pose model drops a player for a frame now and then (often the one at the frame edge
      // in a side view); "화면 밖" only after OFFSCREEN_S without a detection.
      offscreen: !p.landmarks && !(this.t - p.seenT <= OFFSCREEN_S),
      moveM: this.cal ? Math.round(p.moveM * 10) / 10 : null,
      stand: this.standState(p),
      wristDeg: p.landmarks ? p.wristDeg : null,
      wristKmh: p.wristKmh,
      shotKmh: p.shotKmh,
    });
    return { near: one(this.near), far: one(this.far) };
  }
}
