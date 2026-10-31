// Rally clips for a replay preview, made by the real RallyRecorder (public/js/recorder.js) in Chromium:
// a public test video plays under it and the HUD shows test match info that moves over the clip
// (name tags, a ball trail crossing the table, rally clock, shots, speed). The HUD state is made up for
// the preview; the recorder, its HUD size and the encoder are the shipped ones.
//   bun qa/replay-preview-clips.mjs --root=<vision checkout> --out=<dir> [--port=9873]
// Writes <out>/<name>.<mp4|webm> and <out>/clips.json ([{ name, shape, file, bytes, width, height, seconds }]).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const root = join(args.root, "public");
const out = args.out;
const port = Number(args.port || 9873);
mkdirSync(out, { recursive: true });
const V = new URL("../data/videos", import.meta.url).pathname;
// Drawn scenes only: no camera or public test video leaves this PC (lane rule), so the picture under the
// HUD is a drawn hall, table, net and two player shapes. --real=1 uses the public test videos instead
// (this PC only).
const real = args.real === "1";
const JOBS = (real ? [
  { name: "portrait-1", shape: "portrait", src: `${V}/commons/portrait_game.webm`, from: 1 },
  { name: "portrait-2", shape: "portrait", src: `${V}/commons/portrait_game.webm`, from: 12 },
  { name: "landscape-1", shape: "landscape", src: `${V}/commons/landscape_game.webm`, from: 1 },
  { name: "landscape-2", shape: "landscape", src: `${V}/commons/landscape_game.webm`, from: 12 },
] : [
  { name: "portrait-1", shape: "portrait", w: 1080, h: 1920 },
  { name: "portrait-2", shape: "portrait", w: 1080, h: 1920 },
  { name: "portrait-3", shape: "portrait", w: 720, h: 1280 },
  { name: "landscape-1", shape: "landscape", w: 1920, h: 1080 },
  { name: "landscape-2", shape: "landscape", w: 1920, h: 1080 },
  { name: "landscape-3", shape: "landscape", w: 1280, h: 720 },
]).map((j, i) => ({ seconds: 8 - (i % 3 === 2 ? 1 : 0), near: i % 2 ? "블루 · 셋째" : "블루 · 김블루", far: i % 2 ? "레드 · 넷째" : "레드 · 박레드", speed: [31, 24, 18, 36, 27, 22][i] || 25, ...j }));
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body></body></html>`;
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/qa-clips.html") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    const job = JOBS.find((j) => j.src && path === `/__src/${j.name}`);
    if (job) return new Response(Bun.file(job.src), { headers: { "content-type": "video/webm" } });
    const f = Bun.file(join(root, path));
    return (await f.exists()) ? new Response(f) : new Response("nf", { status: 404 });
  },
});

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const made = [];
try {
  for (const job of JOBS) {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/qa-clips.html`);
    const rec = await page.evaluate(async (job) => {
      await document.fonts.load("700 12px Galmuri11");
      await document.fonts.load("400 12px Galmuri11");
      const { RallyRecorder } = await import("/js/recorder.js");
      let v, vw, vh, scene;
      if (job.src) {
        v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.src = `/__src/${job.name}`;
        document.body.append(v);
        await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
        v.currentTime = job.from;
        await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
        await v.play();
        vw = v.videoWidth; vh = v.videoHeight;
      } else {
        // a drawn hall: floor, a blue table in perspective with white lines and a net, two player shapes
        vw = job.w; vh = job.h;
        v = document.createElement("canvas"); v.width = vw; v.height = vh;
        const g = v.getContext("2d");
        scene = (t) => {
          const fl = g.createLinearGradient(0, 0, 0, vh); fl.addColorStop(0, "#3b3f48"); fl.addColorStop(1, "#6b5a46");
          g.fillStyle = fl; g.fillRect(0, 0, vw, vh);
          const q = [[0.3, 0.36], [0.7, 0.36], [0.86, 0.7], [0.14, 0.7]].map(([x, y]) => [x * vw, y * vh]);
          g.fillStyle = "#1f4f8f"; g.beginPath(); q.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
          g.strokeStyle = "#f2f2f2"; g.lineWidth = Math.max(2, vw / 300); g.stroke();
          g.beginPath(); g.moveTo(vw / 2, 0.36 * vh); g.lineTo(vw / 2, 0.7 * vh); g.stroke();
          g.fillStyle = "rgba(240,240,240,.85)"; g.fillRect(0.22 * vw, 0.5 * vh, 0.56 * vw, Math.max(4, vh / 90));
          const person = (cx, y0, y1, c) => { g.fillStyle = c; const w = vw * 0.07; g.fillRect(cx * vw - w / 2, y0 * vh, w, (y1 - y0) * vh); g.beginPath(); g.arc(cx * vw, y0 * vh - w * 0.45, w * 0.4, 0, Math.PI * 2); g.fill(); };
          person(0.7 + Math.sin(t * 2) * 0.02, 0.2, 0.42, "#2a2a2a");
          person(0.3 + Math.cos(t * 2) * 0.02, 0.72, 0.96, "#202020");
        };
      }
      const r = new RallyRecorder({ overlay: true });
      r.setSize(vw, vh);
      const body = (cx, y0, y1) => Array.from({ length: 33 }, (_, i) => ({ x: cx * vw + (i % 2 ? 8 : -8), y: (y0 + ((y1 - y0) * i) / 32) * vh, v: 1 }));
      if (!r.start()) return { error: "recorder did not start", mime: r.mimeType };
      const t0 = performance.now();
      let shots = 1;
      for (;;) {
        const t = (performance.now() - t0) / 1000;
        if (t > job.seconds) break;
        // the ball crosses the table once a second, alternately, as a curve with a fading trail
        const leg = Math.floor(t), f = t - leg, dir = leg % 2 ? -1 : 1;
        shots = leg + 1;
        const at = (u) => ({ x: vw * (0.5 + dir * (u - 0.5) * 0.6), y: vh * (0.55 - Math.sin(u * Math.PI) * 0.12) });
        const trail = Array.from({ length: 12 }, (_, i) => at(Math.max(0, f - (11 - i) * 0.04)));
        const state = {
          layout: "phone",
          players: {
            near: { label: job.near, end: 0, landmarks: body(0.3, 0.68, 0.96) },
            far: { label: job.far, end: 1, landmarks: body(0.7, 0.18, 0.42) },
          },
          ball: { trail, current: trail[trail.length - 1] },
          rally: { active: true, timeMs: Math.round(t * 1000), shots, speedKmh: job.speed },
          bounces: [],
          lastShot: null,
        };
        if (scene) scene(t);
        r.frame(v, state);
        await new Promise((res) => requestAnimationFrame(res));
      }
      const blob = await r.stop();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(s), type: blob.type, w: r.canvas.width, h: r.canvas.height };
    }, job);
    await ctx.close();
    if (rec.error) throw new Error(`${job.name}: ${rec.error} (${rec.mime})`);
    const ext = rec.type.includes("mp4") ? "mp4" : "webm";
    const file = join(out, `${job.name}.${ext}`);
    const bytes = Buffer.from(rec.b64, "base64");
    writeFileSync(file, bytes);
    const dur = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString().trim();
    made.push({ name: job.name, shape: job.shape, file, bytes: bytes.length, width: rec.w, height: rec.h, seconds: Number(dur) });
    console.log(`CLIP ${job.name} ${rec.w}x${rec.h} ${bytes.length}B ${dur}s`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
writeFileSync(join(out, "clips.json"), JSON.stringify(made, null, 2));
console.log(`CLIPS_DONE ${made.length}`);
