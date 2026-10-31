// Corner snapping through the real app UI (iPhone 15 landscape; --engine=webkit|chromium): open a file, tap four
// rough corners, wait for the snap message, read the snapped markers, confirm, and compare the
// saved calibration with the corners read from zoomed crops (qa/eval-set.json).
//   PPV_QA=1 PORT=8801 bun server.js &
//   bun qa/calib-snap-ui.mjs --base=http://127.0.0.1:8801/vision/ --clip=data/videos/clip12_720p60.webm \
//     --taps='<json, 1920x1080 px>' --truth='<json, 1920x1080 px>' --out=evidence/r4/snap-ui
import { chromium, devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || "http://127.0.0.1:8801/vision/";
const taps = JSON.parse(args.taps);
const truth = JSON.parse(args.truth);
const out = args.out || "evidence/r4/snap-ui";
mkdirSync(out, { recursive: true });

const iphone = devices["iPhone 15"];
const browser = args.engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ ...iphone, viewport: { width: iphone.viewport.height, height: iphone.viewport.width } });
await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
const page = await ctx.newPage();
const consoleErrors = [];
// On a vision-only server (no tournament app behind the same origin) the camera's one probe of the
// tournament's /api/state answers 404 by design (one app since lane 6); it is listed, not counted.
const ignoredErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const url = m.location()?.url || "";
  if (/\/api\/state(\?|$)/.test(url) && /404/.test(m.text())) ignoredErrors.push(`${m.text()} ${url}`);
  else consoleErrors.push(`${m.text()} ${url}`.trim());
});
const st = () => page.evaluate(() => window.__ppv.state);

await page.goto(base, { waitUntil: "networkidle" });
const chooser = page.waitForEvent("filechooser");
await page.locator(".screen--intro label.btn--file").tap();
await (await chooser).setFiles(args.clip);
await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 120000 });
if ((await st()).mode !== "calibrating") await page.getByRole("button", { name: /코트 보정/ }).tap();
await page.waitForFunction(() => window.__ppv.state.mode === "calibrating", null, { timeout: 10000 });
const vw = (await st()).video.width;
const k = vw / 1920;
const toScreen = (c) =>
  page.evaluate(([x, y]) => {
    const v = document.querySelector("video");
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    return { x: r.left + (r.width - v.videoWidth * s) / 2 + x * s, y: r.top + (r.height - v.videoHeight * s) / 2 + y * s };
  }, [c.x * k, c.y * k]);
for (const c of taps) {
  const pt = await toScreen(c);
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForTimeout(200);
}
await page.screenshot({ path: `${out}/01-taps.png` });
await page.waitForFunction(() => !/맞추는 중/.test(document.querySelector(".calibbar__text").textContent), null, { timeout: 10000 });
const message = await page.evaluate(() => document.querySelector(".calibbar__text").textContent);
await page.screenshot({ path: `${out}/02-snapped.png` });
await page.getByRole("button", { name: /확인/ }).tap({ timeout: 5000 });
await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 10000 });
// The pose model needs a few seconds to warm up in a headless browser while the clip plays,
// so sample the HUD every second and keep the moment the ball trail is live.
const samples = [];
let best = null;
for (let i = 0; i < Number(args.settle || 12); i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const st = window.__ppv.state;
    const v = document.querySelector("video");
    return { fps: Math.round(st.perf.fps), trail: st.ball.trail.length, poses: ["near", "far"].filter((p) => st.players[p].landmarks).length, shots: st.rally ? st.rally.shots : 0, tracking: st.tracking, videoT: Math.round(v.currentTime * 10) / 10, ended: v.ended };
  });
  samples.push(s);
  if (!best || s.trail > best.trail) { best = s; if (s.trail > 0) await page.screenshot({ path: `${out}/03-running.png` }); }
  if (s.ended) break;
}
await page.screenshot({ path: `${out}/03-running.png` });
const live = { best, samples };
const saved = (await st()).calibration.corners.map((c) => ({ x: c.x / k, y: c.y / k }));
const err = (set) => set.map((p, i) => Math.round(Math.hypot(p.x - truth[i].x, p.y - truth[i].y) * 10) / 10);
const report = { base, clip: args.clip, message, live, tapErrPx1080: err(taps), savedErrPx1080: err(saved), saved, consoleErrors, ignoredErrors };
const pass = /딱 맞췄어요/.test(message) && best.fps > 0 && best.poses >= 1 && Math.max(...report.savedErrPx1080) <= 8 && !consoleErrors.length;
writeFileSync(`${out}/report.json`, JSON.stringify({ ...report, pass }, null, 2));
await browser.close();
console.log(`SNAP_UI ${pass ? "PASS" : "FAIL"} live=${JSON.stringify(best)} message="${message}" tapErr=${JSON.stringify(report.tapErrPx1080)} savedErr=${JSON.stringify(report.savedErrPx1080)} consoleErrors=${consoleErrors.length}`);
process.exit(pass ? 0 : 1);
