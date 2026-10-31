// Orange ball pixel by hue, not by fixed levels: red is the top channel, blue the bottom, and the
// colour is strongly saturated with clearly more green than blue. A fast orange ball at the
// 640 px processing width is a blur mixed with the table, so its red often stays under 150 (the
// old r > 150 test found the ball on 34% of marked frames of the synthetic orange test_2). The
// green-over-blue margin rejects red shirts and boards, the saturation rejects skin, the green cap
// rejects yellow.
export function isOrange(r, g, b) {
  return r > 130 && r >= g && g > b && r - b > 0.45 * r && g >= 0.48 * r && g <= 0.92 * r;
}

// Classical ball detector: a candidate pixel must be BRIGHTER than the same pixel in both of the
// two previous frames (3-frame differencing drops the "ghost" a moving object leaves behind) and
// not strongly coloured, because a fast white ball smears into a dim, background-tinted streak.
// Orange balls use a hue test instead.
export class BallDetector {
  constructor({ width, height, color = "white", diff = 18, maxArea = 200, minArea = 2, minLum = 90, maxChroma = 110, maxDim = 32, bgDist = 60 }) {
    this.minLum = minLum;
    this.maxChroma = maxChroma;
    this.maxDim = maxDim;
    this.bgDist = bgDist;
    this.bg = null;
    this.w = width;
    this.h = height;
    this.color = color;
    this.diff = diff;
    this.maxArea = maxArea;
    this.minArea = minArea;
    this.prev1 = new Uint8Array(width * height);
    this.prev2 = new Uint8Array(width * height);
    this.mask = new Uint8Array(width * height);
    this.label = new Int32Array(width * height);
    this.stack = new Int32Array(width * height);
    this.frames = 0;
  }

  detect(rgba, roi = null, exclude = []) {
    const { w, h } = this;
    const [prev2, prev1] = [this.prev2, this.prev1];
    const cur = this.prev2;
    const mask = this.mask;
    const white = this.color === "white";
    const x0 = roi ? Math.max(0, Math.floor(roi.x0)) : 0;
    const x1 = roi ? Math.min(w, Math.ceil(roi.x1)) : w;
    const y0 = roi ? Math.max(0, Math.floor(roi.y0)) : 0;
    const y1 = roi ? Math.min(h, Math.ceil(roi.y1)) : h;
    mask.fill(0);
    const ready = this.frames >= 2;
    // Orange only: a slow per-pixel background colour (about 16 frames). Floor wood and skin share
    // the ball's orange hue, and a foot moving off the floor makes that floor "brighter than the
    // last two frames" exactly like a ball; a pixel close to its own background colour is the
    // scene coming back into view, not a new object.
    const bgOn = !white;
    if (bgOn && (!this.bg || this.frames === 0)) {
      this.bg = new Uint8Array(w * h * 3);
      for (let i = 0, n = w * h; i < n; i++) { this.bg[i * 3] = rgba[i * 4]; this.bg[i * 3 + 1] = rgba[i * 4 + 1]; this.bg[i * 3 + 2] = rgba[i * 4 + 2]; }
    }
    const bg = this.bg;
    let maskPx = 0;
    let whitePx = 0;
    for (let y = 0; y < h; y++) {
      const inY = y >= y0 && y < y1;
      for (let x = 0, i = y * w; x < w; x++, i++) {
        const o = i * 4;
        const r = rgba[o];
        const g = rgba[o + 1];
        const b = rgba[o + 2];
        const lum = (r * 77 + g * 151 + b * 28) >> 8;
        const p1 = prev1[i];
        const p2 = prev2[i];
        cur[i] = lum;
        let bgDist = 255;
        if (bgOn) {
          const k = i * 3;
          bgDist = Math.abs(r - bg[k]) + Math.abs(g - bg[k + 1]) + Math.abs(b - bg[k + 2]);
          bg[k] += (r - bg[k]) >> 4;
          bg[k + 1] += (g - bg[k + 1]) >> 4;
          bg[k + 2] += (b - bg[k + 2]) >> 4;
        }
        if (!ready || !inY || x < x0 || x >= x1) continue;
        if (lum - p1 < this.diff || lum - p2 < this.diff) continue;
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
        const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        const whiteLike = lum > this.minLum && mx - mn < this.maxChroma;
        if (!white && whiteLike) whitePx++;
        const ok = white ? whiteLike : bgDist > this.bgDist && isOrange(r, g, b);
        if (ok) {
          mask[i] = 1;
          maskPx++;
        }
      }
    }
    this.prev2 = prev1;
    this.prev1 = cur;
    this.frames++;
    // Share of the searched area that changed like a ball would. A rally lights up a few hundred
    // pixels (ball, paddles, limbs); a moving camera lights up every edge in the room.
    this.changed = maskPx / Math.max(1, (x1 - x0) * (y1 - y0));
    // orange mode: moving pixels that would pass the white test ("공 색이 흰색 같아요" hint)
    this.colorPx = maskPx;
    this.whitePx = whitePx;
    if (!ready) return [];
    for (const e of exclude) {
      const ex0 = Math.max(0, Math.floor(e.x0));
      const ex1 = Math.min(w, Math.ceil(e.x1));
      const ey0 = Math.max(0, Math.floor(e.y0));
      const ey1 = Math.min(h, Math.ceil(e.y1));
      for (let y = ey0; y < ey1; y++) mask.fill(0, y * w + ex0, y * w + ex1);
    }
    return this.components(rgba);
  }

  // Forget the previous frames, e.g. after the tracked area changes or tracking was paused.
  resetHistory() {
    this.frames = 0;
  }

  components(rgba) {
    const { w, h, mask, label, stack } = this;
    label.fill(0);
    const out = [];
    let next = 1;
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || label[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      label[start] = next;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let sl = 0;
      let swarm = 0;
      let bx0 = w;
      let bx1 = 0;
      let by0 = h;
      let by1 = 0;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % w;
        const y = (i - x) / w;
        area++;
        sx += x;
        sy += y;
        const o = i * 4;
        sl += rgba[o] + rgba[o + 1] + rgba[o + 2];
        swarm += rgba[o] - rgba[o + 2];
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !label[j]) {
              label[j] = next;
              stack[sp++] = j;
            }
          }
        }
      }
      next++;
      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      if (area < this.minArea || area > this.maxArea) continue;
      if (Math.max(bw, bh) > this.maxDim || area / (bw * bh) < 0.15) continue;
      // warm = mean red minus blue: ~0 for a white ball, clearly positive for an orange one
      out.push({ x: sx / area + 0.5, y: sy / area + 0.5, area, bright: sl / (3 * area), warm: swarm / area });
    }
    return out;
  }
}

// RMS distance of the points from a least-squares quadratic in time, fitted to x and y
// separately. A ball in flight follows a parabola, so its residual is detection noise (about a
// pixel); a tracklet that hops between unrelated blobs leaves a residual of many pixels.
export function pathResidual(pts) {
  const n = pts.length;
  const t0 = pts[0].t;
  const ts = pts.map((p) => p.t - t0);
  const fit = (key) => {
    let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[i];
      const v = pts[i][key];
      s1 += t; s2 += t * t; s3 += t * t * t; s4 += t * t * t * t;
      b0 += v; b1 += v * t; b2 += v * t * t;
    }
    // Solve [[s0 s1 s2][s1 s2 s3][s2 s3 s4]] c = b by Cramer's rule.
    const det = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const D = det(s0, s1, s2, s1, s2, s3, s2, s3, s4);
    if (Math.abs(D) < 1e-18) return null;
    const c0 = det(b0, s1, s2, b1, s2, s3, b2, s3, s4) / D;
    const c1 = det(s0, b0, s2, s1, b1, s3, s2, b2, s4) / D;
    const c2 = det(s0, s1, b0, s1, s2, b1, s2, s3, b2) / D;
    return ts.map((t) => c0 + c1 * t + c2 * t * t);
  };
  const fx = fit("x");
  const fy = fit("y");
  if (!fx || !fy) return Infinity;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (pts[i].x - fx[i]) ** 2 + (pts[i].y - fy[i]) ** 2;
  return Math.sqrt(ss / n);
}

// RMS distance from a least-squares cubic in time (x and y separately). Seen from a low camera
// behind one end, the ball flies towards or away from the lens: perspective bends its image path
// off a parabola and the near ball is a big blurred blob whose centre jitters (club clip: 3.6-7.5
// px from a quadratic, 1.7-3.1 px from a cubic). The tolerance is kept tight (1.3x) because a
// looser one called 17 non-ball spots a ball against 14 real ones on that clip.
export function cubicResidual(pts) {
  const n = pts.length;
  if (n < 6) return Infinity;
  const t0 = pts[0].t;
  const T = pts.map((p) => p.t - t0);
  let ss = 0;
  for (const key of ["x", "y"]) {
    const A = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const pw = [1, T[i], T[i] ** 2, T[i] ** 3];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) A[r][c] += pw[r] * pw[c];
        A[r][4] += pw[r] * pts[i][key];
      }
    }
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      if (Math.abs(A[c][c]) < 1e-18) return Infinity;
      for (let r = 0; r < 4; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= 4; k++) A[r][k] -= f * A[c][k];
      }
    }
    const co = A.map((row, i) => row[4] / row[i]);
    for (let i = 0; i < n; i++) ss += (pts[i][key] - (co[0] + co[1] * T[i] + co[2] * T[i] ** 2 + co[3] * T[i] ** 3)) ** 2;
  }
  return Math.sqrt(ss / n);
}

// Gated nearest-neighbour tracklets with a constant-velocity prediction. The ball is the
// confirmed tracklet that keeps moving; static flicker or a waving shirt rarely forms a
// long, fast, smooth track. The output is LOCKED only once that tracklet has flown a smooth
// (parabolic) path for at least lockLen points spanning lockSpan seconds (6 points at 60 fps,
// 5 at 30 fps). Tuned on test_2 against random flicker: 25 random blobs a frame lock in 0.3% of
// frames at these settings vs 12% with 4 points and a looser residual; only locked output may be drawn or fed to the rally.
// Lock is kept through bounces and hits while the same tracklet stays matched, and drops the
// moment that tracklet is lost or replaced.
export class BallTracker {
  constructor({ gate = 20, initGate = 70, maxMiss = 4, minLen = 3, minSpeed = 60, coast = 2, lockLen = 5, lockSpan = 0.08, lockResidual = 1.5, lockResidualPerStep = 0.03, ballLikeSpeed = 4, lockWindow = null, lockCubic = 0, lockCubicPts = 8, lockCubicHits = 12 } = {}) {
    this.lockCubic = lockCubic;
    this.lockCubicHits = lockCubicHits;
    this.lockCubicPts = lockCubicPts;
    this.lockWindow = lockWindow;
    this.lockLen = lockLen;
    this.lockSpan = lockSpan;
    this.lockResidual = lockResidual;
    this.lockResidualPerStep = lockResidualPerStep;
    this.locked = null;
    this.gate = gate;
    this.initGate = initGate;
    this.coast = coast;
    this.maxMiss = maxMiss;
    this.minLen = minLen;
    this.minSpeed = minSpeed;
    this.ballLikeSpeed = ballLikeSpeed;
    // Table x-range in tracker px, set by the pipeline from the calibration (null = anywhere).
    this.overTable = null;
    this.tracks = [];
    this.nextId = 1;
    this.active = null;
  }

  update(cands, t) {
    const used = new Set();
    const order = [...this.tracks].sort((a, b) => b.hits - a.hits);
    for (const tr of order) {
      const dt = t - tr.t;
      const px = tr.x + tr.vx * dt;
      const py = tr.y + tr.vy * dt;
      const gate = tr.hits < 2 ? this.initGate : Math.min(this.initGate * 1.5, this.gate + Math.hypot(tr.vx, tr.vy) * dt * 0.6);
      let best = -1;
      let bestD = gate;
      for (let i = 0; i < cands.length; i++) {
        if (used.has(i)) continue;
        const d = Math.hypot(cands[i].x - px, cands[i].y - py);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        used.add(best);
        const c = cands[best];
        const nvx = (c.x - tr.x) / dt;
        const nvy = (c.y - tr.y) / dt;
        const a = tr.hits >= 2 ? 0.6 : 1;
        tr.vx = a * nvx + (1 - a) * tr.vx;
        tr.vy = a * nvy + (1 - a) * tr.vy;
        tr.x = c.x;
        tr.y = c.y;
        tr.t = t;
        tr.hits++;
        tr.miss = 0;
        tr.matched = true;
        tr.hist.push({ x: c.x, y: c.y, t });
        if (tr.hist.length > 8) tr.hist.shift();
        tr.area = 0.8 * tr.area + 0.2 * c.area;
        tr.bright = 0.8 * tr.bright + 0.2 * c.bright;
      } else {
        tr.miss++;
        tr.matched = false;
      }
    }
    this.tracks = this.tracks.filter((tr) => tr.miss <= this.maxMiss);
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue;
      const c = cands[i];
      this.tracks.push({ id: this.nextId++, x: c.x, y: c.y, vx: 0, vy: 0, t, born: t, hits: 1, miss: 0, matched: true, hist: [{ x: c.x, y: c.y, t }], area: c.area, bright: c.bright });
    }
    // Net displacement over the recent points, not path length: a blob jittering in place
    // (a shirt, a hand) accumulates path but goes nowhere, while the ball travels.
    const speed = (tr) => {
      const h = tr.hist;
      const span = h[h.length - 1].t - h[0].t;
      return span > 0 ? Math.hypot(h[h.length - 1].x - h[0].x, h[h.length - 1].y - h[0].y) / span : 0;
    };
    const score = (tr) => Math.min(tr.hits, 12) * speed(tr);
    // Ball-like = flying a smooth parabola, fast, above the table's length. Ranking on hits x
    // speed alone let a swinging arm beside the table stay active while the ball flew past
    // (OpenTTGames test_3/4/5: ~90% of missed ball frames). Smoothness alone is not enough:
    // players drift smoothly too, but slowly and beside the table, not over it. The parabola must
    // hold over the full 8-point history: among 25 random blobs a frame, 5-point chains line up by
    // chance often enough to lock 2.6% of frames (vs 0.3% before) if those may take over.
    const ballLike = new Map();
    const isBallLike = (tr) => {
      if (!ballLike.has(tr)) {
        // Deciding WHICH track is the ball stays on the parabola even where a cubic may lock:
        // letting the cubic choose as well made a club view call 17 non-ball spots a ball against
        // 14 real ones (8 of them more than 100 px away).
        ballLike.set(tr, tr.hist.length >= 8 && this.overTableX(tr) && speed(tr) >= this.minSpeed * this.ballLikeSpeed && this.smooth(tr, { allowCubic: false }));
      }
      return ballLike.get(tr);
    };
    const live = this.tracks.filter((tr) => tr.matched && tr.hits >= this.minLen && speed(tr) >= this.minSpeed);
    const best = live.sort((a, b) => isBallLike(b) - isBallLike(a) || score(b) - score(a))[0] || null;
    if (this.active && !this.tracks.includes(this.active)) this.active = null;
    const takeOver = best && this.active && best !== this.active && isBallLike(best) && !isBallLike(this.active);
    if (!this.active || !this.active.matched || takeOver || (best && best !== this.active && score(best) > 2 * score(this.active))) {
      this.active = best || this.active;
    }
    const a = this.active;
    if (this.locked && this.locked !== a) this.locked = null;
    if (!a) return null;
    // The points that earned the lock are real ball positions too; hand them back once so the
    // trail and the rally do not start a few frames late (that delay cost hits at 30 fps).
    let backfill = null;
    if (a !== this.locked && a.matched && this.smooth(a)) {
      this.locked = a;
      backfill = a.hist.slice(0, -1).map((p) => ({ ...p }));
    }
    const locked = this.locked === a;
    if (a.matched) return { x: a.x, y: a.y, vx: a.vx, vy: a.vy, id: a.id, t, predicted: false, locked, backfill };
    if (a.hits < this.minLen + 2 || a.miss > this.coast) {
      this.locked = null;
      return null;
    }
    const dt = t - a.t;
    return { x: a.x + a.vx * dt, y: a.y + a.vy * dt, vx: a.vx, vy: a.vy, id: a.id, t, predicted: true, locked };
  }

  overTableX(tr) {
    return !this.overTable || (tr.x >= this.overTable.x0 && tr.x <= this.overTable.x1);
  }

  smooth(tr, { allowCubic = true } = {}) {
    const pts = tr.hist;
    if (pts.length < this.lockLen || pts[pts.length - 1].t - pts[0].t < this.lockSpan) return false;
    const step = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) / (pts.length - 1);
    const limit = this.lockResidual + this.lockResidualPerStep * step;
    if (pathResidual(pts) <= limit) return true;
    // The cubic describes a ball flying at the lens, so it only applies to a track that is over
    // the table and has been followed for a while - not to any blob that happens to bend.
    if (!allowCubic || !this.lockCubic || pts.length < this.lockCubicPts) return false;
    return this.overTableX(tr) && tr.hits >= this.lockCubicHits && cubicResidual(pts) <= limit * this.lockCubic;
  }

  reset() {
    this.tracks = [];
    this.active = null;
    this.locked = null;
  }
}
