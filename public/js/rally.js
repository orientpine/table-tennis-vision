import { apply, insidePolygon, TABLE_LENGTH } from "./geom.js";

const KMH = 3.6;

export function classifyKind(speedKmh, arcRatio) {
  if (speedKmh == null) return null;
  if (speedKmh >= 45) return "스매시";
  if (arcRatio > 0.25 && speedKmh < 35) return "로빙";
  if (speedKmh >= 22) return "드라이브";
  return "푸시";
}

export function strokeSide(landmarks, hand) {
  if (!landmarks) return null;
  const ls = landmarks[11];
  const rs = landmarks[12];
  const wrist = landmarks[hand === "L" ? 15 : 16];
  if (!ls || !rs || !wrist || wrist.v < 0.3) return null;
  const sx = rs.x - ls.x;
  const sy = rs.y - ls.y;
  const wx = wrist.x - (ls.x + rs.x) / 2;
  const wy = wrist.y - (ls.y + rs.y) / 2;
  const toRight = sx * wx + sy * wy > 0;
  return toRight === (hand !== "L") ? "포핸드" : "백핸드";
}

function slope(pts, key) {
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mv = pts.reduce((s, p) => s + p[key], 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p[key] - mv);
    den += (p.t - mt) ** 2;
  }
  return den > 0 ? num / den : 0;
}

// Turns a stream of ball positions into rally events. Shots are runs of motion in one
// direction along the table's long axis (a reversal = the other player hit it); a bounce is
// an image-space "V" (ball going down then up) inside the table quad with no reversal around it.
export class RallyEngine {
  constructor({ calibration = null, videoWidth = 1920, videoHeight = 1080, gapEnd = 1.0, shotGapEnd = 3.0, noBounceEnd = 1.5, onEvent = () => {} } = {}) {
    this.shotGapEnd = shotGapEnd;
    this.noBounceEnd = noBounceEnd;
    this.cal = calibration;
    this.vw = videoWidth;
    this.vh = videoHeight;
    this.gapEnd = gapEnd;
    this.onEvent = onEvent;
    this.rally = null;
    this.lastBallT = -Infinity;
  }

  setCalibration(cal) {
    this.cal = cal;
  }

  // An airborne ball is not on the table plane, so mapping it straight through the homography
  // mixes its height into the distance. Projecting it onto the image of the table's centre line
  // first removes the height component for side-on views (height moves the ball across that line).
  alongTable(p) {
    const { myEnd, axis, lengthPx } = this.cal;
    const s = ((p.x - myEnd.x) * axis.x + (p.y - myEnd.y) * axis.y) / lengthPx;
    const onLine = { x: myEnd.x + axis.x * s * lengthPx, y: myEnd.y + axis.y * s * lengthPx };
    return apply(this.cal.toTable, onLine).x;
  }

  axisPos(p) {
    if (this.cal) return this.alongTable(p) / TABLE_LENGTH;
    return p.x / this.vw;
  }

  update(t, ball, players) {
    if (this.rally) {
      const r = this.rally;
      const lastShot = r.shots[r.shots.length - 1];
      const lastBounce = r.bounces[r.bounces.length - 1];
      const unanswered = lastShot && t - lastShot.t > this.noBounceEnd && (!lastBounce || lastBounce.t < lastShot.t);
      const why = t - this.lastBallT > this.gapEnd ? "ball_lost" : t - r.lastShotT > this.shotGapEnd ? "no_shot" : unanswered ? "no_bounce" : null;
      if (why) this.endRally(why);
    }
    if (!ball) return;
    this.lastBallT = t;
    if (!this.rally) this.startRally(t);
    const r = this.rally;
    const tp = this.cal ? apply(this.cal.toTable, ball) : null;
    const u = this.axisPos(ball);
    const pt = { t, id: ball.id, x: ball.x, y: ball.y, u, along: this.cal ? u * TABLE_LENGTH : null, tx: tp ? tp.x : null, ty: tp ? tp.y : null };
    r.pts.push(pt);
    if (r.pts.length > 400) r.pts.shift();
    this.trackDirection(pt, players);
    this.detectBounce();
    this.updateShotSpeed();
    r.lastT = t;
  }

  startRally(t) {
    this.rally = { startT: t, lastT: t, lastShotT: t, pts: [], shots: [], bounces: [], dir: 0, pending: 0, pendingPt: null, maxSpeed: null };
    this.onEvent({ type: "rallyStart", t });
  }

  endRally(why = "stop") {
    const r = this.rally;
    this.rally = null;
    if (!r) return;
    this.onEvent({
      type: "rallyEnd",
      t: r.lastT,
      why,
      durationS: r.lastT - r.startT,
      shots: r.shots.length,
      shotList: r.shots.map((s) => ({ side: s.side, t: s.t, inferred: !!s.inferred })),
      serveNet: r.serveNet || null,
      serveSeen: r.serveSeen || null,
      maxSpeedKmh: r.maxSpeed,
      bounces: r.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: b.t })),
    });
  }

  trackDirection(pt, players) {
    const r = this.rally;
    const n = r.pts.length;
    if (n < 2) return;
    const prev = r.pts[n - 2];
    if (prev.id !== pt.id && (pt.t - prev.t > 0.2 || Math.abs(pt.u - prev.u) > 0.3)) {
      r.pending = 0;
      return;
    }
    const du = pt.u - prev.u;
    const eps = 0.004;
    if (Math.abs(du) < eps) return;
    const d = Math.sign(du);
    if (d === r.dir) {
      r.pending = 0;
      return;
    }
    if (r.pending !== d) {
      r.pending = d;
      r.pendingPt = prev;
      return;
    }
    const hitPt = r.pendingPt;
    const travel = Math.abs(pt.u - hitPt.u);
    if (travel < 0.05) return;
    if (this.cal && r.dir !== 0 && (d > 0 ? hitPt.u > 0.4 : hitPt.u < 0.6)) {
      r.pending = 0;
      return;
    }
    r.dir = d;
    r.pending = 0;
    r.lastShotT = pt.t;
    const side = d > 0 ? "near" : "far";
    const player = players && players[side];
    const shot = {
      index: r.shots.length + 1,
      side,
      t: hitPt.t,
      at: { x: hitPt.x, y: hitPt.y },
      stroke: player ? strokeSide(player.landmarksAtHit ? player.landmarksAtHit(hitPt.t) : player.landmarks, player.hand) : null,
      kind: r.shots.length === 0 ? "서브" : null,
      speedKmh: null,
      arc: 0,
    };
    shot.label = labelOf(shot);
    r.shots.push(shot);
    this.onEvent({ type: "shot", t: hitPt.t, shot });
  }

  updateShotSpeed() {
    const r = this.rally;
    const shot = r.shots[r.shots.length - 1];
    if (!shot || !this.cal || shot.final) return;
    // A shot's flight ends at the bounce on the receiver's side; points after that (the return,
    // a pickup, a missed reversal) must not keep feeding this shot's speed fit.
    const receiver = shot.side === "near" ? "far" : "near";
    const landed = r.bounces.find((b) => b.t > shot.t && b.side === receiver);
    const until = landed ? landed.t : shot.t + 1.2;
    // Fit only the flight over the table: near either end the ball is still leaving the paddle
    // or already reaching the next hitter, and those slow points halve the fitted speed.
    const seg = r.pts.filter((p) => p.t > shot.t && p.t <= until && p.along >= TABLE_LENGTH * 0.1 && p.along <= TABLE_LENGTH * 0.9);
    if (landed || r.pts[r.pts.length - 1].t > shot.t + 1.2) shot.final = true;
    if (seg.length < 4 || seg[seg.length - 1].t - seg[0].t < 0.06) return;
    const v = Math.abs(slope(seg, "along")) * KMH;
    if (!(v >= 5 && v <= 160)) return;
    const tableTopY = Math.min(this.cal.quad[0].y, this.cal.quad[1].y, this.cal.quad[2].y, this.cal.quad[3].y);
    const apexY = Math.min(...seg.map((p) => p.y));
    shot.arc = Math.max(0, (tableTopY - apexY) / this.cal.lengthPx);
    shot.speedKmh = Math.round(v);
    if (shot.index > 1) shot.kind = classifyKind(shot.speedKmh, shot.arc);
    shot.label = labelOf(shot);
    r.maxSpeed = Math.max(r.maxSpeed ?? 0, shot.speedKmh);
    this.onEvent({ type: "shotUpdate", t: r.pts[r.pts.length - 1].t, shot });
  }

  detectBounce() {
    const r = this.rally;
    const n = r.pts.length;
    if (n < 5) return;
    const k = n - 3;
    const p = r.pts;
    // The dip a bounce must show scales with the table's size in the image, not the frame's:
    // a portrait frame is tall but its table is small (0.0045 x table length = frame height x
    // 0.004 on the 1080p side views this was tuned on; a portrait phone's table gets half).
    const thr = Math.max(2, this.cal ? this.cal.lengthPx * 0.0045 : this.vh * 0.004);
    const ymax = p[k].y;
    if (!(ymax >= p[k - 1].y && ymax > p[k + 1].y)) return;
    if (ymax - Math.min(p[k - 2].y, p[k - 1].y) < thr && ymax - p[k - 2].y < thr) return;
    if (ymax - p[k + 2].y < thr) return;
    if (p[k + 2].t - p[k - 2].t > 0.25) return;
    const shot = r.shots[r.shots.length - 1];
    if (shot && shot.t >= p[k - 2].t) return;
    const last = r.bounces[r.bounces.length - 1];
    if (last && p[k].t - last.t < 0.12) return;
    if (this.cal && !insidePolygon(p[k], this.cal.quad, this.cal.lengthPx * 0.02)) return;
    const b = { t: p[k].t, x: p[k].x, y: p[k].y, tx: p[k].tx, ty: p[k].ty };
    b.side = b.tx == null ? (p[k].u < 0.5 ? "near" : "far") : b.tx < TABLE_LENGTH / 2 ? "near" : "far";
    r.bounces.push(b);
    this.onEvent({ type: "bounce", t: b.t, bounce: b });
    const serve = r.shots[0];
    if (serve && !r.serveDone && b.side !== serve.side && b.t > serve.t && this.cal) {
      r.serveDone = true;
      const flight = r.pts.filter((q) => q.t > serve.t && q.t < b.t && q.along != null);
      r.serveNet = netKink(flight);
      // How well the serve was seen over the server's own half, where its first bounce belongs:
      // measured points there and the longest gap between them (from the hit on).
      const own = flight.filter((q) => (serve.side === "near" ? q.along < TABLE_LENGTH / 2 : q.along > TABLE_LENGTH / 2));
      let gap = own.length ? own[0].t - serve.t : b.t - serve.t;
      for (let i = 1; i < own.length; i++) gap = Math.max(gap, own[i].t - own[i - 1].t);
      const spanS = own.length > 1 ? own[own.length - 1].t - own[0].t : 0;
      r.serveSeen = { pts: own.length, spanS: Math.round(spanS * 1000) / 1000, maxGapS: Math.round(gap * 1000) / 1000 };
    }
    if (last && last.side !== b.side && !r.shots.some((s) => s.t > last.t && s.t < b.t) && !this.isServeBounce(last)) this.inferShot(last, b);
  }

  // A serve bounces on the server's own side first, then crosses with no hit in between. A bounce
  // on the same side as the last hitter (or the rally's very first bounce) is that serve bounce.
  isServeBounce(bounce) {
    const r = this.rally;
    const hitter = [...r.shots].reverse().find((s) => s.t < bounce.t);
    return hitter ? hitter.side === bounce.side : r.bounces[0] === bounce;
  }

  // Two bounces on opposite sides need a hit in between; when the tracker lost the ball at the
  // paddle (common at 30 fps), record that hit from the bounce sequence instead of dropping it.
  inferShot(from, to) {
    const r = this.rally;
    const shot = {
      index: 0,
      side: from.side,
      t: (from.t + to.t) / 2,
      at: { x: from.x, y: from.y },
      stroke: null,
      kind: r.shots.length === 0 ? "서브" : null,
      speedKmh: null,
      arc: 0,
      inferred: true,
    };
    shot.label = labelOf(shot);
    r.shots.push(shot);
    r.shots.sort((a, b) => a.t - b.t);
    r.shots.forEach((s, i) => (s.index = i + 1));
    r.lastShotT = Math.max(r.lastShotT, to.t);
    this.onEvent({ type: "shot", t: shot.t, shot });
  }

  snapshot(t) {
    const r = this.rally;
    if (!r) return null;
    // A new shot has no speed or stroke kind until a few frames of flight are seen; show the
    // latest shot that has been measured so the HUD never drops back to "--" mid-rally.
    const shot = [...r.shots].reverse().find((s) => s.speedKmh != null) || r.shots[r.shots.length - 1] || null;
    return {
      active: true,
      timeMs: Math.max(0, (t - r.startT) * 1000),
      shots: r.shots.length,
      speedKmh: shot ? shot.speedKmh : null,
      maxSpeedKmh: r.maxSpeed,
      lastShot: shot,
      bounces: r.bounces,
    };
  }
}

// A serve that clips the net slows sharply or changes course there. Compare the along-table
// speed of the serve's flight just before and just after the net line (+-0.6 m around it).
// Returns { ratio } (after / before), or null when either side has too few measured points.
export function netKink(pts) {
  const net = TABLE_LENGTH / 2;
  const before = pts.filter((p) => Math.abs(p.along - net) <= 0.6 && (p.along - net) * Math.sign(pts[pts.length - 1].along - pts[0].along) < 0);
  const after = pts.filter((p) => Math.abs(p.along - net) <= 0.6 && (p.along - net) * Math.sign(pts[pts.length - 1].along - pts[0].along) >= 0);
  if (before.length < 3 || after.length < 3) return null;
  const v = (seg) => Math.abs((seg[seg.length - 1].along - seg[0].along) / (seg[seg.length - 1].t - seg[0].t || 1e-9));
  const vb = v(before);
  if (!(vb > 0)) return null;
  return { ratio: Math.round((v(after) / vb) * 100) / 100 };
}

function labelOf(shot) {
  const parts = [shot.stroke, shot.kind].filter(Boolean);
  const name = parts.length ? parts.join(" ") : "샷";
  return shot.speedKmh != null ? `${name} ~${shot.speedKmh}km` : name;
}
