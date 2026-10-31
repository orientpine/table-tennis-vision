// Guards that keep automatic scoring from failing quietly (asked for after the owner's phone check,
// 2026-10-31 06:07 KST: "자동 점수가 안 될 만한 요소는 미리 보완해"). Pure functions and one small
// state machine, so tests can drive them without a browser. They never change the analysis itself.

// Analysis starvation. Measured on this host's software WebKit (2026-10-31): the full-screen portrait
// stage at times fed the analysis 31-91% repeated frames, and a forced production-size middle row
// scored like main (17 points in 120 s) while reading a hidden clone video made it worse (0 points,
// 79% repeats). So the only step is the smaller picture. Bad = over 30% repeats or under 12 reads/s, and
// it switches only after two bad windows in a row (10 s). Owner decision (2026-10-31 09:38 KST): "빼고 '초당
// 12장 미만'이나 '반복 30% 넘음'일 때만 켜기" - his iPhone switched three times on "15% below the first
// 10 s" (77-87% of it, 0% repeats). dropFromBase is that rule's one value: 0 is off, 0.15 brings it back.
// The first-10 s rate is still measured, for the log.
export const STARVE = { windowMs: 5000, maxRepeat: 0.3, minFps: 12, dropFromBase: 0, badWindows: 2, baseWindows: 2, recoverMs: 30000 };

// A cheap fingerprint of an RGBA frame: 1024 fixed sample points. Two reads of the same camera frame
// give the same value. 64 points were too few: on a still hall they all fell on unchanging background
// and new frames read as repeats (70% on the test clip while main's 256-point check saw 0.2%).
export function frameSig(rgba) {
  const px = rgba.length >> 2;
  if (!px) return 0;
  let h = 2166136261;
  for (let i = 0; i < 1024; i++) {
    const p = ((i * 7919 + 13) % px) << 2;
    h = Math.imul(h ^ (rgba[p] | (rgba[p + 1] << 8) | (rgba[p + 2] << 16)), 16777619);
  }
  return h >>> 0;
}

// Counts analysis reads in fixed windows and says when to step up:
//   level 0: the user's setting
//   level 1: analysis reads its own clone of the camera stream ("따로 크게")
//   level 2: the portrait picture is the production-size middle row again (not full screen)
// It only steps up, at most once per window, and never past level 2.
// Counts analysis reads in fixed windows and decides the picture size:
//   "compact"  - a bad window while full screen: the portrait picture goes to the middle row
//   "full"     - 30 s of good windows while compact: back to the full-screen overlay
//   "stay"     - a bad window after having come back once: compact for the rest of this camera run
export class StarveWatch {
  constructor(opts = {}) {
    this.o = { ...STARVE, ...opts };
    this.reset();
  }
  reset() {
    this.compact = false;
    this.locked = false;
    this.cameBack = false;
    this.winStart = null;
    this.frames = 0;
    this.repeats = 0;
    this.lastSig = null;
    this.baseFps = [];
    this.goodMs = 0;
    this.badRun = 0;
    this.off = false;
    this.last = null;
  }
  // the chip was tapped: full screen now, and no switch again for the rest of this camera run
  dismiss() {
    this.compact = false;
    this.locked = false;
    this.off = true;
  }
  get base() {
    return this.baseFps.length >= this.o.baseWindows ? this.baseFps.reduce((a, b) => a + b, 0) / this.baseFps.length : null;
  }
  // Returns { action, fps, repeat, base } when the picture size should change, else null.
  tick(now, processed, sig) {
    if (this.winStart == null) { this.winStart = now; this.lastSig = processed ? sig : null; return null; }
    if (processed) {
      this.frames++;
      if (sig === this.lastSig) this.repeats++;
      this.lastSig = sig;
    }
    const span = now - this.winStart;
    if (span < this.o.windowMs) return null;
    const fps = (this.frames * 1000) / span;
    const repeat = this.frames ? this.repeats / this.frames : 1;
    this.last = { fps, repeat };
    this.winStart = now;
    this.frames = 0;
    this.repeats = 0;
    if (this.base == null) { this.baseFps.push(fps); return null; }
    const base = this.base;
    const bad = repeat > this.o.maxRepeat || fps < this.o.minFps || (this.o.dropFromBase > 0 && fps < base * (1 - this.o.dropFromBase));
    this.badRun = bad ? this.badRun + 1 : 0;
    if (!this.compact) {
      if (this.off || this.badRun < this.o.badWindows) return null;
      this.compact = true;
      this.goodMs = 0;
      if (this.cameBack) this.locked = true;
      return { action: this.locked ? "stay" : "compact", fps, repeat, base, badWindows: this.badRun };
    }
    if (this.locked) return null;
    this.goodMs = bad ? 0 : this.goodMs + span;
    if (this.goodMs < this.o.recoverMs) return null;
    this.compact = false;
    this.cameBack = true;
    return { action: "full", fps, repeat, base };
  }
}

// Low light: mean brightness (0-255) of the analysis frame, ignoring near-black pixels so the black
// bands of a letterboxed picture do not count as darkness. The darkest public clip measured is test_7
// at a frame mean of about 45 (test_4/5 about 56); below 30 is darker than any of them.
export const LOW_LIGHT = { luma: 30, holdMs: 3000 };
export function frameLuma(rgba) {
  const px = rgba.length >> 2;
  if (!px) return 0;
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(px / 1024));
  for (let i = 0; i < px; i += step) {
    const p = i << 2;
    const y = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (y < 8) continue;
    sum += y;
    n++;
  }
  return n ? sum / n : 0;
}

// Small table: share of the frame the calibrated table covers. The only test clip where automatic points come in
// (clip12, 16:9) has the table at 5.5% of the frame; the same scene padded into 9:16 (1.8%) gets no
// point even on main. Below 5% the camera is told how to frame it better; calibration still goes on.
export const SMALL_TABLE = { frac: 0.05 };
export function quadFraction(corners, w, h) {
  if (!w || !h || !corners || corners.length < 4) return 0;
  let a = 0;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i], q = corners[(i + 1) % corners.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2 / (w * h);
}
