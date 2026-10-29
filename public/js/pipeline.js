import { BallDetector, BallTracker } from "./ball.js";
import { apply, makeCalibration, TABLE_LENGTH, TABLE_WIDTH } from "./geom.js";
import { Players } from "./players.js";
import { RallyEngine } from "./rally.js";

export function bodyBox(lm) {
  const pts = lm.filter((p, i) => i >= 11 && p && p.v > 0.3);
  if (pts.length < 6) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// Share of table-top samples whose colour is close to the median table colour. A table top is
// one flat colour (OpenTTGames test_2: 0.71-0.75 with players and the ball in view); four taps
// on a living room give a mix of furniture and toys (a home capture: 0.25). The net strip and
// the outer edge lines are skipped. rgba is the procWidth frame; k maps video px -> proc px.
export function tableUniformity(rgba, pw, ph, cal, k) {
  const samples = [];
  for (let tx = 0.15; tx <= TABLE_LENGTH - 0.14; tx += 0.1) {
    if (Math.abs(tx - TABLE_LENGTH / 2) < 0.2) continue;
    for (let ty = 0.12; ty <= TABLE_WIDTH - 0.11; ty += 0.1) {
      const p = apply(cal.toImage, { x: tx, y: ty });
      const x = Math.round(p.x / k);
      const y = Math.round(p.y / k);
      if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
      const o = (y * pw + x) * 4;
      samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
    }
  }
  if (samples.length < 40) return 0;
  const med = [0, 1, 2].map((c) => samples.map((s) => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
  const near = samples.filter((s) => Math.hypot(s[0] - med[0], s[1] - med[1], s[2] - med[2]) < 40).length;
  return near / samples.length;
}

const TABLE_MIN_UNIFORM = 0.4;
const TABLE_CHECK_EVERY = 15;
const SHAKE_MAX_CANDS = 120;
const SHAKE_MAX_CHANGED = 0.04;
const SHAKE_CALM_FRAMES = 10;
export const ISSUE_NO_TABLE = "탁구대가 안 보여요. 코트 보정으로 탁구대 네 모서리를 맞춰 주세요";
export const ISSUE_SHAKY = "폰이 흔들려요. 폰을 고정해 주세요";

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class Pipeline {
  constructor({ pose = null, procWidth = 640, ballColor = "white", poseEvery = 1, onEvent = () => {} } = {}) {
    this.pose = pose;
    this.procWidth = procWidth;
    this.ballColor = ballColor;
    this.poseEvery = poseEvery;
    this.onEvent = onEvent;
    this.players = new Players();
    this.cal = null;
    this.vw = 0;
    this.vh = 0;
    this.frame = 0;
    this.trail = [];
    this.ball = null;
    this.locked = false;
    this.lastFedT = -Infinity;
    this.tableChecks = [];
    this.calmFrames = SHAKE_CALM_FRAMES;
    this.shake = { maxCands: SHAKE_MAX_CANDS, maxChanged: SHAKE_MAX_CHANGED, calmFrames: SHAKE_CALM_FRAMES };
    this.tracking = "no-calibration";
    this.perf = { ballMs: 0, poseMs: 0, ms: 0 };
  }

  setVideoSize(vw, vh) {
    if (vw === this.vw && vh === this.vh) return;
    this.vw = vw;
    this.vh = vh;
    this.pw = this.procWidth;
    this.ph = Math.round((vh / vw) * this.procWidth);
    this.k = vw / this.pw;
    this.canvas = null;
    this.ctx = null;
    this.detector = new BallDetector({ width: this.pw, height: this.ph, color: this.ballColor });
    const initGate = this.pw * 0.12;
    this.tracker = new BallTracker({ gate: initGate * 0.35, initGate, minSpeed: this.pw * 0.1 });
    this.rally = new RallyEngine({ calibration: this.cal, videoWidth: vw, videoHeight: vh, onEvent: (e) => this.handle(e) });
  }

  setCalibration(corners) {
    this.cal = corners ? makeCalibration(corners) : null;
    if (this.rally) this.rally.setCalibration(this.cal);
    this.tableChecks = [];
    this.dropBall();
    return this.cal;
  }

  handle(e) {
    if (e.type === "shot" || e.type === "shotUpdate") this.players.onShot(e.shot);
    this.onEvent(e);
  }

  roi() {
    if (!this.cal) return null;
    const { x0, x1, y0, y1 } = this.cal.bbox;
    const w = x1 - x0;
    return {
      x0: (x0 - w * 0.45) / this.k,
      x1: (x1 + w * 0.45) / this.k,
      y0: (y0 - w * 0.6) / this.k,
      y1: (y1 + w * 0.08) / this.k,
    };
  }

  bodyBoxes() {
    const out = [];
    for (const side of ["near", "far"]) {
      const lm = this.players[side].landmarks;
      const b = lm && bodyBox(lm);
      if (!b) continue;
      const pad = 2;
      out.push({ x0: b.x0 / this.k - pad, x1: b.x1 / this.k + pad, y0: b.y0 / this.k - pad, y1: b.y1 / this.k + pad });
    }
    return out;
  }

  process(source, t) {
    const t0 = performance.now();
    if (!this.ctx) {
      this.canvas = makeCanvas(this.pw, this.ph);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    this.ctx.drawImage(source, 0, 0, this.pw, this.ph);
    const img = this.ctx.getImageData(0, 0, this.pw, this.ph);
    return this.processPixels(img.data, t, { source, t0 });
  }

  // The pixel path shared by the browser and the offline QA harnesses (qa/empty-scene.mjs,
  // qa/ball-offline.mjs): rgba is a procWidth-wide frame. Pose runs only with a source element;
  // offline runs can pass the body boxes to exclude instead.
  processPixels(rgba, t, { source = null, t0 = performance.now(), exclude = null } = {}) {
    // Nothing is tracked until the four corners sit on something that looks like a table top:
    // without that, every moving speck in a room could be called a ball and every toy a player.
    if (this.cal && this.frame % TABLE_CHECK_EVERY === 0) {
      this.tableChecks.push(tableUniformity(rgba, this.pw, this.ph, this.cal, this.k));
      if (this.tableChecks.length > 6) this.tableChecks.shift();
    }
    const tableOk = this.cal && this.tableVisible();
    let cands = [];
    let hit = null;
    if (tableOk) {
      cands = this.detector.detect(rgba, this.roi(), exclude || this.bodyBoxes());
      // A moving camera turns every edge into a candidate; drop those frames and wait until
      // the picture has been still for a moment before trusting the tracker again.
      const shaky = cands.length > this.shake.maxCands || this.detector.changed > this.shake.maxChanged;
      this.calmFrames = shaky ? 0 : this.calmFrames + 1;
      if (this.calmFrames < this.shake.calmFrames) {
        if (this.tracker.active) this.tracker.reset();
        cands = [];
      }
      hit = this.tracker.update(cands, t);
      this.tracking = this.calmFrames < this.shake.calmFrames ? "unstable" : hit && hit.locked ? "locked" : "searching";
    } else {
      if (this.detector.frames) this.detector.resetHistory();
      this.dropBall();
      this.tracking = this.cal ? "no-table" : "no-calibration";
    }
    this.locked = !!(hit && hit.locked);
    this.ball = this.locked ? { x: hit.x * this.k, y: hit.y * this.k, id: hit.id } : null;
    const t1 = performance.now();
    if (this.pose && source && this.frame % this.poseEvery === 0) {
      const poses = tableOk ? this.pose.detect(source, t * 1000, this.vw, this.vh) : [];
      this.players.update(t, poses, this.cal);
    }
    const t2 = performance.now();
    if (this.ball && hit.backfill) {
      for (const q of hit.backfill) {
        if (q.t <= this.lastFedT) continue;
        const b = { x: q.x * this.k, y: q.y * this.k, id: hit.id };
        this.rally.update(q.t, b, this.players.forRally());
        this.trail.push({ x: b.x, y: b.y, t: q.t });
      }
    }
    this.rally.update(t, this.ball && !hit.predicted ? this.ball : null, this.players.forRally());
    if (this.ball) this.trail.push({ x: this.ball.x, y: this.ball.y, t });
    if (this.ball && !hit.predicted) this.lastFedT = t;
    while (this.trail.length && t - this.trail[0].t > 0.6) this.trail.shift();
    this.frame++;
    const ema = (a, b) => (a ? a * 0.9 + b * 0.1 : b);
    this.perf.ballMs = ema(this.perf.ballMs, t1 - t0);
    if (t2 > t1) this.perf.poseMs = ema(this.perf.poseMs, t2 - t1);
    this.perf.ms = ema(this.perf.ms, performance.now() - t0);
    return { cands, ball: this.ball };
  }

  tableVisible() {
    if (!this.tableChecks.length) return false;
    const v = [...this.tableChecks].sort((a, b) => a - b);
    return v[v.length >> 1] >= TABLE_MIN_UNIFORM;
  }

  dropBall() {
    this.lastFedT = -Infinity;
    this.trail = [];
    this.ball = null;
    this.locked = false;
    if (this.tracker) this.tracker.reset();
  }

  reset() {
    this.players.reset();
    this.dropBall();
    if (this.rally) this.rally.endRally();
  }

  snapshot(t) {
    const rally = this.rally ? this.rally.snapshot(t) : null;
    const shot = rally && rally.lastShot;
    const lock = this.ball && { x: this.ball.x, y: this.ball.y, id: this.ball.id, speedKmh: shot ? shot.speedKmh : null, side: shot ? shot.side : null };
    return {
      rally,
      ball: { trail: this.trail, current: this.ball, lock: lock || null },
      players: this.players.state(),
      tracking: this.tracking,
      calibrationIssue: this.tracking === "no-table" ? ISSUE_NO_TABLE : this.tracking === "unstable" ? ISSUE_SHAKY : null,
      perf: this.perf,
    };
  }
}
