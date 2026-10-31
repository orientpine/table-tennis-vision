// Is the overlay in the rally replay clip, and does it read at a phone's width? The real
// RallyRecorder (public/js/recorder.js) records a short clip in Chromium from a flat grey source with
// two players, a ball trail and a rally running; one frame of that clip is decoded with ffmpeg and
// shrunk to 393 px wide (a phone replay), then measured:
//   label   tallest text ink inside a name-tag box (navy panel), px at 393 wide   (bar: >= 10)
//   trail   thickness of the dashed trail line between dots, px at 393 wide       (bar: >= 2)
//   strip   height of the score strip at the top, px at 393 wide
//   ink     share of pixels that differ from the grey source (overlay present at all)
// --overlay=off checks the 설정 "영상만" clip: no overlay pixels at all (ink < 0.1%).
//   bun qa/replay-overlay.mjs --root=<vision checkout> --out=<dir> --tag=before|after [--overlay=on|off] [--port=9871]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measure } from "./overlay-measure.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const root = join(args.root, "public");
const out = args.out;
const tag = args.tag || "run";
const overlay = args.overlay !== "off";
const port = Number(args.port || 9871);
mkdirSync(out, { recursive: true });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body></body></html>`;
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/qa-replay.html") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    const f = Bun.file(join(root, path));
    return (await f.exists()) ? new Response(f) : new Response("nf", { status: 404 });
  },
});

const browser = await chromium.launch();
const rows = [];
try {
  for (const [shape, vw, vh] of [["portrait", 720, 1280], ["landscape", 1280, 720]]) {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/qa-replay.html`);
    const rec = await page.evaluate(async ({ vw, vh, overlay }) => {
      await document.fonts.load("700 12px Galmuri11");
      await document.fonts.load("400 12px Galmuri11");
      const { RallyRecorder } = await import("/js/recorder.js");
      const src = document.createElement("canvas");
      src.width = vw; src.height = vh;
      const g = src.getContext("2d");
      const r = new RallyRecorder({ overlay });
      r.setSize(vw, vh);
      const body = (cx, y0, y1) => Array.from({ length: 33 }, (_, i) => ({ x: cx * vw + (i % 2 ? 6 : -6), y: (y0 + ((y1 - y0) * i) / 32) * vh, v: 1 }));
      // the trail runs level across the middle, clear of both players and their name tags, one point
      // every 6% of the width so the line between two dots can be measured on its own
      const trailY = Math.round(vh * 0.5);
      const step = Math.round(vw * 0.06);
      const trail = Array.from({ length: 10 }, (_, i) => ({ x: vw * 0.2 + i * step, y: trailY }));
      const state = {
        layout: "phone",
        players: {
          near: { label: "블루 · 김블루", end: 0, landmarks: body(0.25, 0.62, 0.95) },
          far: { label: "레드 · 3", end: 1, landmarks: body(0.75, 0.12, 0.4) },
        },
        ball: { trail, current: trail[trail.length - 1] },
        rally: { active: true, timeMs: 1820, shots: 2, speedKmh: 14 },
        bounces: [],
        lastShot: null,
      };
      if (!r.start()) return { error: "recorder did not start", mime: r.mimeType };
      // about 2 s of frames, so the 0.8 s frame (and the replay captures' 0.8 s pause) is inside the clip
      for (let i = 0; i < 120; i++) {
        g.fillStyle = "rgb(128,128,128)";
        g.fillRect(0, 0, vw, vh);
        g.fillStyle = `rgb(${128 + (i % 2)},128,128)`; // a changing pixel keeps the encoder producing frames
        g.fillRect(0, vh - 2, 2, 2);
        r.frame(src, state);
        await new Promise((res) => requestAnimationFrame(res));
      }
      const blob = await r.stop();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(s), type: blob.type, w: r.canvas.width, h: r.canvas.height, trailY: Math.round(trailY * r.scale), trailX0: Math.round(vw * 0.2 * r.scale), trailStep: step * r.scale, trailN: trail.length };
    }, { vw, vh, overlay });
    await ctx.close();
    if (rec.error) throw new Error(`${shape}: ${rec.error} (${rec.mime})`);
    const ext = rec.type.includes("mp4") ? "mp4" : "webm";
    const clip = join(out, `${tag}-${shape}${overlay ? "" : "-off"}.${ext}`);
    const bytes = Buffer.from(rec.b64, "base64");
    writeFileSync(clip, bytes);
    const png = clip.replace(/\.\w+$/, "-393.png");
    const W = 393, H = Math.round((rec.h / rec.w) * W / 2) * 2;
    const ff = (...a) => Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", "0.8", "-i", clip, "-frames:v", "1", "-vf", `scale=${W}:${H}:flags=area`, ...a]);
    ff("-y", png);
    const raw = ff("-f", "rawvideo", "-pix_fmt", "rgb24", "-").stdout;
    if (!raw || raw.length !== W * H * 3) throw new Error(`${shape}: decoded ${raw?.length} bytes, want ${W * H * 3}`);
    rows.push({ tag, shape, overlay, clip, png, bytes: bytes.length, size: `${rec.w}x${rec.h}`, ...measure(raw, W, H, rec, W / rec.w) });
  }
} finally {
  await browser.close();
  server.stop(true);
}

const pass = rows.every((r) => (r.overlay ? r.label >= 10 && r.trail >= 2 && r.ink > 0.002 : r.ink < 0.001));
const verdict = { tag, overlay, pass, rows };
writeFileSync(join(out, `${tag}${overlay ? "" : "-off"}.json`), JSON.stringify(verdict, null, 2));
for (const r of rows) console.log(`${r.tag} ${r.shape} overlay=${r.overlay ? "on" : "off"} ${r.size} ${r.bytes}B label=${r.label}px trail=${r.trail}px strip=${r.strip}px ink=${r.ink} boxes=${r.boxes}`);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
