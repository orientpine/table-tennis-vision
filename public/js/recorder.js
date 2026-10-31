// Records one rally as a highlight clip on the phone: each processed frame is drawn onto a
// canvas (camera frame + the same HUD overlay as on screen + a score strip) and that canvas is
// encoded with MediaRecorder. Recording runs only between rallyStart and rallyEnd, so nothing
// outside a rally is ever encoded or uploaded.
import { drawHud } from "./hud.js";
import { leftOut, paintPanels } from "./screen-rec.js";

const TYPES = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

function fmtClock(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

export class RallyRecorder {
  // maxSeconds: Safari 26 MediaRecorder writes frozen video after about 15 s in video/mp4
  // (https://bugs.webkit.org/show_bug.cgi?id=315091), so a longer rally keeps its first 14 s.
  // overlay: draw the HUD and score strip into the clip (설정 → 다시 보기 영상에 오버레이, on by default).
  // hudWidth: the HUD is laid out on a canvas this many CSS px wide, a bit under a phone's width, then
  // scaled up to the clip. Replays play the clip at a phone's width, so labels and lines read there
  // as on a camera screen (12 px labels stay 13 px at 393 px) instead of the 6 px they were when the
  // HUD was laid out at the clip's own 720 px.
  constructor({ maxWidth = 960, fps = 30, bitsPerSecond = 2_000_000, maxSeconds = 14, overlay = true, hudWidth = 360 } = {}) {
    this.overlay = overlay;
    this.hudWidth = hudWidth;
    this.maxSeconds = maxSeconds;
    this.maxWidth = maxWidth;
    this.fps = fps;
    this.bitsPerSecond = bitsPerSecond;
    this.mimeType = pickMimeType();
    this.rec = null;
    this.chunks = [];
  }

  get supported() {
    return !!this.mimeType && typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
  }

  get recording() {
    return !!this.rec;
  }

  setSize(vw, vh) {
    const w = Math.min(this.maxWidth, vw);
    const h = Math.round((vh / vw) * w) & ~1;
    if (this.canvas && this.canvas.width === w && this.canvas.height === h) return;
    this.scale = w / vw;
    // a portrait clip plays in a 9:16 box about 335 px wide on a phone (70% of its height), so its HUD
    // is laid out 8/9 as wide again to keep the name tags over 10 px there
    this.hudK = Math.max(1, w / (h > w ? (this.hudWidth * 8) / 9 : this.hudWidth));
    const cw = Math.round(w / this.hudK);
    const chh = Math.round(h / this.hudK);
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    // drawHud sizes itself from the element's CSS box and devicePixelRatio and reads the theme
    // tokens through getComputedStyle, so its canvas lives in the DOM (invisible) at w x h CSS px.
    if (this.hud) this.hud.remove();
    const dpr = window.devicePixelRatio || 1;
    this.hud = document.createElement("canvas");
    this.hud.width = Math.round(cw * dpr);
    this.hud.height = Math.round(chh * dpr);
    this.hud.setAttribute("aria-hidden", "true");
    this.hud.style.cssText = `position:fixed;left:-100000px;top:0;width:${cw}px;height:${chh}px;visibility:hidden;pointer-events:none`;
    document.body.append(this.hud);
  }

  // The camera screen as the clip, when it is on the page: the box around the picture and the
  // overlay panels (.hud, the notice toast), in the screen's own layout and proportions.
  screenParts() {
    if (!this.overlay || typeof document === "undefined") return null;
    const stage = document.querySelector(".stage");
    const overlay = document.querySelector(".stage__overlay");
    const hud = document.querySelector(".hud");
    if (!stage || !overlay || !hud) return null;
    return { stage, overlay, hud, video: document.querySelector(".stage__video"), toast: document.getElementById("toast") };
  }

  layoutScreen(parts) {
    // .hud can be display: contents (its own box is empty), so its visible children set the extent
    const boxes = (el) => {
      if (leftOut(el)) return [];
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display === "contents" || r.width <= 0 || r.height <= 0 ? [...el.children].flatMap(boxes) : [el];
    };
    const rects = [parts.stage, ...boxes(parts.hud)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const box = { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    return box;
  }

  // Picture rect of the stage video on screen (object-fit contain or cover) and its source crop.
  pictureRect(video) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || r.width, vh = video.videoHeight || r.height;
    const fit = getComputedStyle(video).objectFit;
    const k = (fit === "cover" ? Math.max : Math.min)(r.width / vw, r.height / vh);
    const w = vw * k, h = vh * k;
    const dst = { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    // the part of the picture inside the element (cover crops it)
    const cl = Math.max(dst.left, r.left), ct = Math.max(dst.top, r.top), cr = Math.min(dst.left + w, r.right), cb = Math.min(dst.top + h, r.bottom);
    return { src: { x: (cl - dst.left) / k, y: (ct - dst.top) / k, w: (cr - cl) / k, h: (cb - ct) / k }, dst: { left: cl, top: ct, width: cr - cl, height: cb - ct } };
  }

  refreshScreen() {
    const p = this.screen;
    const t0 = performance.now();
    p.stageRect = p.overlay.getBoundingClientRect();
    p.pic = p.video && p.video.videoWidth ? this.pictureRect(p.video) : null;
    const pc = p.panelCtx;
    pc.clearRect(0, 0, p.panelCanvas.width, p.panelCanvas.height);
    paintPanels(pc, [p.hud, p.toast && p.toast.classList.contains("show") ? p.toast : null], p.box, p.s);
    p.paintedAt = performance.now();
    this.stats.panelMs += p.paintedAt - t0;
    this.stats.panelPaints++;
  }

  start() {
    if (!this.supported || this.rec) return false;
    const parts = this.screenParts();
    const box = parts && this.layoutScreen(parts);
    if (box) {
      const s = Math.min(this.maxWidth / box.width, 1920 / box.height);
      if (!this.screenCanvas) { this.screenCanvas = document.createElement("canvas"); this.screenCtx = this.screenCanvas.getContext("2d"); }
      this.screenCanvas.width = Math.round(box.width * s) & ~1;
      this.screenCanvas.height = Math.round(box.height * s) & ~1;
      const panelCanvas = document.createElement("canvas");
      panelCanvas.width = this.screenCanvas.width;
      panelCanvas.height = this.screenCanvas.height;
      this.screen = { ...parts, box, s, panelCanvas, panelCtx: panelCanvas.getContext("2d"), paintedAt: 0, bg: getComputedStyle(document.body).backgroundColor || "#000" };
    } else {
      this.screen = null;
    }
    const target = this.screen ? this.screenCanvas : this.canvas;
    if (!target) return false;
    this.stats = { frames: 0, frameMs: 0, maxFrameMs: 0, panelMs: 0, panelPaints: 0, width: target.width, height: target.height, mode: this.screen ? "screen" : this.overlay ? "hud" : "video" };
    this.chunks = [];
    const stream = target.captureStream(this.fps);
    this.rec = new MediaRecorder(stream, { mimeType: this.mimeType, videoBitsPerSecond: this.bitsPerSecond });
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(500);
    this.startedAt = performance.now();
    this.capped = null;
    return true;
  }

  frame(video, state) {
    if (!this.rec || this.capped) return;
    if (performance.now() - this.startedAt > this.maxSeconds * 1000) {
      this.capped = this.finish(this.rec);
      return;
    }
    const t0 = performance.now();
    if (this.screen) this.frameScreen(video);
    else this.frameHud(video, state);
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.frameMs += ms;
    this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, ms);
  }

  // what the camera screen shows: picture, the canvas overlay (tags, joints, trail, LOCK, bounces) and
  // the panels; the panels and layout are re-read about ten times a second, the rest every frame
  frameScreen(video) {
    const p = this.screen;
    if (performance.now() - p.paintedAt > 100) this.refreshScreen();
    const ctx = this.screenCtx, c = this.screenCanvas, s = p.s, b = p.box;
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    if (p.pic && p.pic.dst.width > 0) {
      const { src, dst } = p.pic;
      ctx.drawImage(video, src.x, src.y, src.w, src.h, (dst.left - b.left) * s, (dst.top - b.top) * s, dst.width * s, dst.height * s);
    }
    const o = p.stageRect;
    ctx.drawImage(p.overlay, (o.left - b.left) * s, (o.top - b.top) * s, o.width * s, o.height * s);
    ctx.drawImage(p.panelCanvas, 0, 0);
  }

  frameHud(video, state) {
    const { ctx, canvas } = this;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (!this.overlay) return;
    const k = this.hudK;
    const s = this.scale / k;
    // score strip: 13 px text on an 18 px band in HUD px, like the HUD itself
    const band = Math.round(18 * k);
    // the trail is a 1 px dashed line on screen; in the clip it is 2 px so it survives the shrink
    drawHud(this.hud.getContext("2d"), state, (p) => ({ x: p.x * s, y: p.y * s }), { top: 22, trailWidth: 2 });
    ctx.drawImage(this.hud, 0, 0, canvas.width, canvas.height);
    const r = state.rally || {};
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font-pixel").trim() || "Galmuri11, monospace";
    ctx.fillStyle = "rgba(10,22,52,0.86)";
    ctx.fillRect(0, 0, canvas.width, band);
    ctx.fillStyle = "#f2f6ff";
    ctx.font = `700 ${Math.round(13 * k)}px ${font}`;
    ctx.textBaseline = "middle";
    const speed = r.speedKmh == null ? "--" : `~${r.speedKmh} km/h`;
    ctx.fillText(`RALLY ${fmtClock(r.timeMs || 0)}   ${r.shots || 0} SHOT   ${speed}`, Math.round(6 * k), Math.round(band / 2) + 1);
  }

  stop() {
    const rec = this.rec;
    const capped = this.capped;
    this.rec = null;
    this.capped = null;
    if (!rec) return Promise.resolve(null);
    return capped || this.finish(rec);
  }

  finish(rec) {
    return new Promise((resolve) => {
      rec.onstop = () => {
        for (const t of rec.stream.getTracks()) t.stop();
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType.split(";")[0] }) : null;
        this.chunks = [];
        resolve(blob);
      };
      rec.stop();
    });
  }
}
