// The start screen's players, before and after, in Chromium with the real pixel font: for each screen
// (phone 393, phone 360, TV), each of the four points and each camera angle round the table (0..315
// in 45 degree steps), the picture at the deciding hit and at that hitter's backswing just before,
// drawn at that exact moment through the canvas's draw hook. Each shot is the stage (the scene between
// title and button) plus a close crop of the hitter, so the racket in the hand and the bent arms and
// legs can be judged. A compare run lays two capture folders side by side, one sheet per screen, point
// and moment, before on top and after below.
//   bun qa/start-players.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9670]
//   bun qa/start-players.mjs --compare=<before dir>,<after dir> --out=<dir>
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const ALL_VIEWS = { phone: DEVICES.phone, p360: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, tv: DEVICES.tv };
const VIEWS = Object.fromEntries(Object.entries(ALL_VIEWS).filter(([k]) => !args.views || args.views.split(",").includes(k)));
const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const MOMENTS = { deciding: 0, backswing: -0.14 };

if (args.compare) {
  const [before, after] = args.compare.split(",");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const img = (p) => (existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : "");
  const made = [];
  for (const view of Object.keys(VIEWS)) for (let i = 0; i < 4; i++) for (const moment of Object.keys(MOMENTS)) {
    const cell = (dir, deg, kind) => `<td><img class="${kind}" src="${img(`${dir}/${view}-p${i + 1}-${moment}-${deg}-${kind}.png`)}"></td>`;
    const rows = [["전 (master)", before], ["후 (이 브랜치)", after]];
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:12px;background:#10142e;color:#f2f6ff;font:15px sans-serif}td{padding:3px;vertical-align:top;text-align:center}img{image-rendering:pixelated;display:block}img.stage{width:200px}img.crop{height:220px;max-width:200px;object-fit:contain}th{font-weight:600;padding:4px}</style>
<h3>${view} · 장면 ${i + 1} · ${moment === "deciding" ? "결정 순간" : "백스윙(결정 0.14초 전)"} · 궤도 각도</h3>
<table><tr><th></th>${ANGLES.map((d) => `<th>${d}°</th>`).join("")}</tr>
${rows.map(([name, dir]) => `<tr><th>${name}<br>장면</th>${ANGLES.map((d) => cell(dir, d, "stage")).join("")}</tr><tr><th>${name}<br>치는 선수 확대</th>${ANGLES.map((d) => cell(dir, d, "crop")).join("")}</tr>`).join("")}
</table>`;
    await page.setContent(html);
    await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
    const file = `${out}/sheet-${view}-p${i + 1}-${moment}.png`;
    await page.screenshot({ path: file, fullPage: true });
    made.push(file);
  }
  await browser.close();
  console.log(`START_PLAYERS_SHEETS ${made.length}`);
  process.exit(0);
}

const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9670) });
const browser = await chromium.launch();
let shots = 0;
const errors = [];
try {
  for (const [name, device] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext({ ...device, reducedMotion: "no-preference" });
    // Hold the animation loop so each screenshot shows exactly the frame drawn through the hook.
    await ctx.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (f) => raf((t) => (window.__hold ? null : f(t)));
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
    await page.goto(app.origin + "/");
    await page.waitForSelector(".start-go");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = 1000; } window.__hold = true; });
    const stage = await page.evaluate(() => { const r = document.querySelector(".start-stage").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    for (let i = 0; i < 4; i++) for (const [moment, dt] of Object.entries(MOMENTS)) for (const deg of ANGLES) {
      // The deciding hit's loop time is the point's still; the hitter is whoever plays that hit.
      const box = await page.evaluate(async ([i, dt, deg]) => {
        const m = await import("/start.js");
        const c = document.querySelector(".start-rally"), sc = m.SCENES[i];
        c.rally.draw(sc.still + dt, i, deg);
        const s = c.rally.scene, t = s.t, hit = sc.nodes.filter((n) => n.who).reduce((a, n) => (Math.abs(n.t - sc.climax) < Math.abs(a.t - sc.climax) ? n : a));
        const p = m.poseAt(hit.who, t, sc), pts = [[p.x, p.y, 0], [p.x, p.y, 2.0 + p.jump], [p.racket.x, p.racket.y, p.racket.z], [p.x - 0.5, p.y, 1], [p.x + 0.5, p.y, 1]].map(([x, y, z]) => m.project(s.cam, x, y, z));
        const r = c.getBoundingClientRect(), k = r.width / c.width;
        const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
        const pad = 0.25 * (y1 - y0);
        return { t, who: hit.who, x: r.left + (x0 - pad) * k, y: r.top + (y0 - pad) * k, width: (x1 - x0 + 2 * pad) * k, height: (y1 - y0 + 2 * pad) * k };
      }, [i, dt, deg]);
      const base = `${out}/${name}-p${i + 1}-${moment}-${deg}`;
      await page.screenshot({ path: `${base}-stage.png`, clip: stage });
      const vw = device.viewport.width, vh = device.viewport.height;
      const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(vw - Math.max(0, box.x), box.width), height: Math.min(vh - Math.max(0, box.y), box.height) };
      await page.screenshot({ path: `${base}-crop.png`, clip });
      shots += 2;
    }
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/errors.json`, JSON.stringify(errors, null, 2));
console.log(`START_PLAYERS_SHOTS ${shots} errors=${errors.length}`);
process.exit(errors.length ? 1 : 0);
