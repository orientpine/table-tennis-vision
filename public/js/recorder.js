// Records one rally as a highlight clip on the phone: each processed frame is drawn onto a
// canvas (camera frame + the same HUD overlay as on screen + a score strip) and that canvas is
// encoded with MediaRecorder. Recording runs only between rallyStart and rallyEnd, so nothing
// outside a rally is ever encoded or uploaded.
import { drawHud } from "./hud.js";

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
  constructor({ maxWidth = 960, fps = 30, bitsPerSecond = 2_000_000, maxSeconds = 14 } = {}) {
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
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    // drawHud sizes itself from the element's CSS box and devicePixelRatio and reads the theme
    // tokens through getComputedStyle, so its canvas lives in the DOM (invisible) at w x h CSS px.
    if (this.hud) this.hud.remove();
    const dpr = window.devicePixelRatio || 1;
    this.hud = document.createElement("canvas");
    this.hud.width = Math.round(w * dpr);
    this.hud.height = Math.round(h * dpr);
    this.hud.setAttribute("aria-hidden", "true");
    this.hud.style.cssText = `position:fixed;left:-100000px;top:0;width:${w}px;height:${h}px;visibility:hidden;pointer-events:none`;
    document.body.append(this.hud);
  }

  start() {
    if (!this.supported || !this.canvas || this.rec) return false;
    this.chunks = [];
    const stream = this.canvas.captureStream(this.fps);
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
    const { ctx, canvas } = this;
    const s = this.scale;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawHud(this.hud.getContext("2d"), state, (p) => ({ x: p.x * s, y: p.y * s }), { top: 34 });
    ctx.drawImage(this.hud, 0, 0, canvas.width, canvas.height);
    const r = state.rally || {};
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font-pixel").trim() || "Galmuri11, monospace";
    ctx.fillStyle = "rgba(10,22,52,0.86)";
    ctx.fillRect(0, 0, canvas.width, 30);
    ctx.fillStyle = "#f2f6ff";
    ctx.font = `700 22px ${font}`;
    ctx.textBaseline = "middle";
    const speed = r.speedKmh == null ? "--" : `~${r.speedKmh} km/h`;
    ctx.fillText(`RALLY ${fmtClock(r.timeMs || 0)}   ${r.shots || 0} SHOT   ${speed}`, 10, 16);
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
