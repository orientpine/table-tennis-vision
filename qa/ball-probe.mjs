// Why start-kof finds no ball near the net: per missing frame, the ball's projected centre and size
// from the page's camera and the canvas pixel there, with the orbit on and off (Chromium, phone).
//   bun qa/ball-probe.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9720] [--ms=9000]
import { chromium } from "playwright";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9720) });
const browser = await chromium.launch();
const probe = (page, spin, ms) => page.evaluate(async ([spin, ms]) => {
  const m = await import("/start.js");
  const old = document.querySelector(".start-rally");
  const c = old.cloneNode();
  old.replaceWith(c);
  m.playRally(c, Math.random, { spin });
  const g = c.getContext("2d", { willReadFrequently: true });
  const isBall = (d, i) => d[i] === 255 && d[i + 1] === 211 && d[i + 2] === 77;
  const rows = [];
  let last = -1, frames = 0;
  return new Promise((done) => {
    const t0 = performance.now();
    const step = () => {
      const s = c.rally.scene;
      if (s.frames !== last && s.sc) {
        last = s.frames; frames++;
        const w = m.ballAt(s.t, s.sc);
        if (s.t < s.sc.end && Math.abs(w.y) < 0.5 && s.t > 0.4) {
          const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width;
          let found = false;
          for (let i = 0; i < d.length - W * 4 - 4 && !found; i += 4) found = isBall(d, i) && isBall(d, i + 4) && isBall(d, i + W * 4) && isBall(d, i + W * 4 + 4);
          if (!found) {
            const p = m.project(s.cam, w.x, w.y, w.z), x = Math.round(p.x), y = Math.round(p.y), i = (y * W + x) * 4;
            const size = Math.max(2, Math.round(p.p * 0.1));
            let near = 0, tinted = 0;
            for (let yy = y - 4; yy <= y + 4; yy++) for (let xx = x - 4; xx <= x + 4; xx++) {
              if (xx < 0 || yy < 0 || xx >= W || yy >= c.height) continue;
              const k = (yy * W + xx) * 4, dr = d[k] - 255, dg = d[k + 1] - 211, db = d[k + 2] - 77;
              if (Math.hypot(dr, dg, db) < 30) near++;
              else if (d[k] > 200 && d[k + 1] > 190 && d[k + 2] > 90 && d[k + 2] < 200) tinted++;
            }
            rows.push({ near, tinted, t: Math.round(s.t * 100) / 100, scene: m.SCENES.indexOf(s.sc), deg: Math.round(s.cam.deg), x, y, size, inside: x >= 0 && y >= 0 && x < W && y < c.height, rgba: [d[i], d[i + 1], d[i + 2], d[i + 3]], ballFirst: w.y * s.cam.c.y <= 0 });
          }
        }
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(step); else done({ frames, missing: rows.length, rows: rows.slice(0, 12) });
    };
    requestAnimationFrame(step);
  });
}, [spin, ms]);
try {
  for (const spin of [15, 0]) {
    const ctx = await browser.newContext(DEVICES.phone);
    const page = await ctx.newPage();
    await page.goto(app.origin + "/?start");
    await page.waitForSelector(".start-go");
    const r = await probe(page, spin, Number(args.ms || 20000));
    console.log(`PROBE spin=${spin} ${JSON.stringify(r)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
console.log("PROBE_DONE");
