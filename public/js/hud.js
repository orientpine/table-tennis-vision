// hud.js - overlay drawing for pingpong-vision (contract: docs/contract.md)
// drawHud(ctx, state, toScreen): skeletons (near = cyan, far = green), foot ellipse, name
// plate above the head, table polygon when calibrated, locked-ball trail, the LOCK target box
// (only while state.ball.lock is set), shot label above the hitter.
// All geometry arrives in video px and goes through toScreen() -> CSS px. The canvas backing
// store is CSS px * devicePixelRatio (ui.js); text is drawn at integer CSS px positions and at
// the pixel font's integer sizes (--fs-hud-label / --fs-hud-value), so every bitmap pixel lands
// on whole device pixels. Colours and sizes come from the CSS tokens (style.css) so the canvas
// and the DOM share one design system.

export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

const FACE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FEET = [27, 28, 29, 30, 31, 32];
const MIN_VIS = 0.5;

// Mirrors the :root tokens in style.css; used only if a token cannot be read.
const FALLBACK = {
  navy: "10 22 52", ink: "#f2f6ff", ink2: "#a3afcb", me: "#4fd1ff", opp: "#5ee36a",
  accent: "#ff8a1f", speed: "#ffd34d", frame: "#e6ecff", shadow: "#000",
  fsLabel: 12, fsValue: 24, fontPixel: '"Galmuri11", monospace', px: 2, pxShadow: 3,
};

let theme = null;
let themeKey = "";

function intPx(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readTheme(canvas) {
  const cs = getComputedStyle(canvas);
  const get = (name, fb) => (cs.getPropertyValue(name) || "").trim() || fb;
  const navy = get("--c-navy-rgb", FALLBACK.navy).split(/\s+/).join(",");
  return {
    panel: `rgba(${navy},0.88)`,
    ink: get("--c-ink", FALLBACK.ink),
    ink2: get("--c-ink-2", FALLBACK.ink2),
    me: get("--c-me", FALLBACK.me),
    opp: get("--c-opp", FALLBACK.opp),
    accent: get("--c-accent", FALLBACK.accent),
    speed: get("--c-speed", FALLBACK.speed),
    frame: get("--c-frame", FALLBACK.frame),
    shadow: get("--c-shadow", FALLBACK.shadow),
    fsLabel: intPx(get("--fs-hud-label", ""), FALLBACK.fsLabel),
    fsValue: intPx(get("--fs-hud-value", ""), FALLBACK.fsValue),
    fontPixel: get("--font-11", FALLBACK.fontPixel),
    px: intPx(get("--px", ""), FALLBACK.px),
    pxShadow: intPx(get("--px-shadow", ""), FALLBACK.pxShadow),
  };
}

function ensureTheme(canvas, layout) {
  const key = `${layout}|${canvas.clientWidth}|${canvas.clientHeight}`;
  if (theme && themeKey === key) return theme;
  const t = readTheme(canvas);
  // a very short stage keeps the value size at one label step so the LOCK box still fits
  if (canvas.clientHeight < 160) t.fsValue = t.fsLabel;
  t.fontFamily = t.fontPixel.split(",")[0].replace(/["']/g, "").trim();
  theme = t;
  themeKey = key;
  return t;
}

/** Reset the cached theme (call after a layout/theme change). */
export function invalidateHudTheme() {
  theme = null;
  themeKey = "";
}

function visible(lm) {
  return lm && (lm.v == null || lm.v >= MIN_VIS);
}

function font(t, size, bold) {
  return `${bold ? 700 : 400} ${size}px ${t.fontPixel}`;
}

/** Hard-shadowed pixel box: shadow, fill, optional 1 px frame. Integer CSS px everywhere. */
function pixelBox(ctx, t, x, y, w, h, frame) {
  const bx = Math.round(x), by = Math.round(y), bw = Math.round(w), bh = Math.round(h);
  ctx.fillStyle = t.shadow;
  ctx.fillRect(bx + t.px, by + t.px, bw, bh);
  ctx.fillStyle = t.panel;
  ctx.fillRect(bx, by, bw, bh);
  if (frame) {
    ctx.fillStyle = frame;
    ctx.fillRect(bx, by, bw, 1);
    ctx.fillRect(bx, by + bh - 1, bw, 1);
    ctx.fillRect(bx, by, 1, bh);
    ctx.fillRect(bx + bw - 1, by, 1, bh);
  }
  return { x: bx, y: by, w: bw, h: bh };
}

/** One-line text in a pixel box; (x, y) is the box's top-left; returns the box rect. */
function boxText(ctx, t, text, x, y, opts) {
  ctx.font = font(t, opts.size, opts.bold);
  const padX = Math.round(opts.size / 2);
  const padY = Math.round(opts.size / 4);
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const h = opts.size + padY * 2;
  const r = pixelBox(ctx, t, x, y, w, h, opts.frame);
  ctx.fillStyle = opts.color;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(text, r.x + padX, r.y + padY);
  return r;
}

function drawSkeleton(ctx, t, pts, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "butt";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  for (const [a, b] of POSE_CONNECTIONS) {
    const p = pts[a], q = pts[b];
    if (!p || !q) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  for (let i = 11; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 2, 5, 5);
  }
}

function drawFootEllipse(ctx, t, pts, color) {
  const feet = FEET.map((i) => pts[i]).filter(Boolean);
  if (feet.length < 2) return;
  let cx = 0, cy = 0, minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of feet) { cx += p.x; cy += p.y; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  cx /= feet.length; cy = maxY;
  const rx = Math.max(28, (maxX - minX) * 0.7);
  const ry = Math.max(9, rx * 0.32);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function headAnchor(pts) {
  let top = Infinity, sx = 0, n = 0;
  for (const i of FACE) {
    const p = pts[i];
    if (!p) continue;
    top = Math.min(top, p.y);
    sx += p.x; n++;
  }
  if (!n) {
    for (const i of [11, 12]) { const p = pts[i]; if (p) { top = Math.min(top, p.y); sx += p.x; n++; } }
  }
  if (!n) return null;
  return { x: sx / n, y: top };
}

function clampX(x, w, xMax) {
  return Math.round(Math.max(4, Math.min(xMax - w - 4, x)));
}

function drawTrail(ctx, t, state, toScreen) {
  const trail = state.ball?.trail || [];
  const n = trail.length;
  if (n > 1) {
    ctx.lineWidth = 1;
    for (let i = 1; i < n; i++) {
      const a = toScreen(trail[i - 1]), b = toScreen(trail[i]);
      ctx.globalAlpha = 0.25 + 0.75 * (i / n);
      ctx.strokeStyle = t.speed;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  for (let i = 0; i < n; i++) {
    const p = toScreen(trail[i]);
    const k = (i + 1) / n;
    ctx.globalAlpha = 0.3 + 0.7 * k;
    ctx.fillStyle = i === n - 1 ? t.ink : t.speed;
    const s = i === n - 1 ? 5 : 3 + Math.round(2 * k);
    ctx.fillRect(Math.round(p.x) - (s >> 1), Math.round(p.y) - (s >> 1), s, s);
  }
  ctx.globalAlpha = 1;
  const cur = state.ball?.current;
  if (cur && !state.ball?.lock) {
    // an unlocked candidate is a quiet white square, never a target box
    const p = toScreen(cur);
    ctx.fillStyle = t.ink;
    ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 2, 4, 4);
  }
}

/**
 * Game-style LOCK target: gold bracket corners on the ball plus a label box beside it
 * ("LOCK" + side, then "~27 km/h" when the speed is known). Drawn ONLY from state.ball.lock.
 */
function drawLock(ctx, t, state, toScreen, top, xMax, ch) {
  const lock = state.ball?.lock;
  if (!lock) return null;
  const p = toScreen(lock);
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const half = Math.round(t.fsLabel), arm = Math.round(t.fsLabel / 2), lw = t.px;
  // bracket corners: a 1 px shadow pass, then the gold pass; each corner = one vertical + one horizontal bar
  for (const pass of [t.shadow, t.speed]) {
    ctx.fillStyle = pass;
    const o = pass === t.shadow ? 1 : 0;
    // top-left
    ctx.fillRect(cx - half + o, cy - half + o, lw, arm); ctx.fillRect(cx - half + o, cy - half + o, arm, lw);
    // top-right
    ctx.fillRect(cx + half - lw + o, cy - half + o, lw, arm); ctx.fillRect(cx + half - arm + o, cy - half + o, arm, lw);
    // bottom-left
    ctx.fillRect(cx - half + o, cy + half - arm + o, lw, arm); ctx.fillRect(cx - half + o, cy + half - lw + o, arm, lw);
    // bottom-right
    ctx.fillRect(cx + half - lw + o, cy + half - arm + o, lw, arm); ctx.fillRect(cx + half - arm + o, cy + half - lw + o, arm, lw);
  }

  const side = lock.side === "near" || lock.side === "far" ? lock.side : null;
  const sideColor = side === "near" ? t.me : t.opp;
  const sideLabel = side ? state.players?.[side]?.label || (side === "near" ? "앞쪽(나)" : "건너편(상대)") : "";
  const line2 = lock.speedKmh == null ? null : `~${Math.round(lock.speedKmh)} km/h`;
  ctx.font = font(t, t.fsLabel, true);
  const wLock = Math.ceil(ctx.measureText("LOCK").width);
  const wSide = sideLabel ? Math.ceil(ctx.measureText(` ${sideLabel}`).width) : 0;
  ctx.font = font(t, t.fsValue, true);
  const w2 = line2 ? Math.ceil(ctx.measureText(line2).width) : 0;
  const padX = Math.round(t.fsLabel / 2), padY = Math.round(t.fsLabel / 4), gap = Math.round(t.fsLabel / 4);
  const bw = Math.max(wLock + wSide, w2) + padX * 2;
  const bh = t.fsLabel + (line2 ? gap + t.fsValue : 0) + padY * 2;
  let bx = cx + half + gap * 2;
  if (bx + bw > xMax - 4) bx = cx - half - gap * 2 - bw;
  bx = clampX(bx, bw, xMax);
  let by = cy - half - bh - gap;
  if (by < top) by = cy + half + gap;
  if (by + bh > ch - 4) by = Math.max(top, ch - 4 - bh);
  const r = pixelBox(ctx, t, bx, by, bw, bh, t.speed);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = font(t, t.fsLabel, true);
  ctx.fillStyle = t.speed;
  ctx.fillText("LOCK", r.x + padX, r.y + padY);
  if (sideLabel) {
    ctx.fillStyle = sideColor;
    ctx.fillText(` ${sideLabel}`, r.x + padX + wLock, r.y + padY);
  }
  if (line2) {
    ctx.font = font(t, t.fsValue, true);
    ctx.fillStyle = t.ink;
    ctx.fillText(line2, r.x + padX, r.y + padY + t.fsLabel + gap);
  }
  return { ...r, side, speedKmh: lock.speedKmh ?? null };
}

function drawTable(ctx, t, corners, toScreen) {
  if (!corners || corners.length !== 4) return;
  ctx.strokeStyle = t.ink;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  corners.forEach((c, i) => {
    const p = toScreen(c);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function fmtKmh(v) {
  return v == null ? "--" : `~${Math.round(v)}`;
}

/**
 * Draw one frame of the HUD overlay.
 * @param {CanvasRenderingContext2D} ctx overlay canvas context (backing store = CSS px * devicePixelRatio)
 * @param {object} state State per docs/contract.md
 * @param {(pt:{x:number,y:number}) => {x:number,y:number}} toScreen video px -> CSS px
 * @returns {{lock: object|null, tags: object, fonts: string, font: string}} what was drawn (QA reads this)
 */
export function drawHud(ctx, state, toScreen, { top = 4, right = Infinity } = {}) {
  const canvas = ctx.canvas;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || canvas.width / dpr;
  const ch = canvas.clientHeight || canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const xMax = Math.min(cw, right);
  const t = ensureTheme(canvas, state?.layout);
  const out = { lock: null, tags: {}, fonts: `${t.fsLabel},${t.fsValue}`, font: t.fontFamily };
  if (!state) return out;

  if (state.calibration?.corners) drawTable(ctx, t, state.calibration.corners, toScreen);

  const sides = ["far", "near"]; // far first so the near player draws on top
  for (const side of sides) {
    const player = state.players?.[side];
    if (!player?.landmarks) continue;
    const color = side === "near" ? t.me : t.opp;
    const pts = player.landmarks.map((lm) => (visible(lm) ? toScreen(lm) : null));
    drawFootEllipse(ctx, t, pts, color);
    drawSkeleton(ctx, t, pts, color);
    const head = headAnchor(pts);
    if (head) {
      const label = player.label || (side === "near" ? "앞쪽(나)" : "건너편(상대)");
      ctx.font = font(t, t.fsLabel, true);
      const w = Math.ceil(ctx.measureText(label).width) + Math.round(t.fsLabel / 2) * 2;
      const h = t.fsLabel + Math.round(t.fsLabel / 4) * 2;
      const x = clampX(head.x - w / 2, w, xMax);
      const y = Math.max(top + h + 6, Math.round(head.y) - h - Math.round(t.fsLabel / 2));
      out.tags[side] = boxText(ctx, t, label, x, y, { size: t.fsLabel, bold: true, color, frame: t.frame });
    }
  }

  drawTrail(ctx, t, state, toScreen);
  out.lock = drawLock(ctx, t, state, toScreen, top, xMax, ch);

  const shot = state.lastShot;
  if (shot) {
    const side = shot.side;
    let anchor = out.tags[side];
    if (!anchor && shot.at) {
      const p = toScreen(shot.at);
      anchor = { x: Math.round(p.x), y: Math.round(p.y) - 8, w: 0, h: 0 };
    }
    if (anchor) {
      // shot label above the hitter's name plate
      const label = shot.label || `${shot.stroke || ""} ${shot.kind || ""} ${fmtKmh(shot.speedKmh)}km`.trim();
      ctx.font = font(t, t.fsLabel, true);
      const lw = Math.ceil(ctx.measureText(label).width) + Math.round(t.fsLabel / 2) * 2;
      const lh = t.fsLabel + Math.round(t.fsLabel / 4) * 2;
      const lx = clampX(anchor.x + anchor.w / 2 - lw / 2, lw, xMax);
      const ly = Math.max(top, anchor.y - lh - 6);
      boxText(ctx, t, label, lx, ly, { size: t.fsLabel, bold: true, color: t.speed, frame: t.frame });
    }
  }
  return out;
}
