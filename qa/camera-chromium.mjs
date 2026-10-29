import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || process.env.PPV_BASE || "http://127.0.0.1:8801/vision/";
const y4m = args.y4m;
const outDir = args.out || "evidence/camera";
const seconds = Number(args.seconds || 12);
const corners = JSON.parse(args.corners || "[]");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${y4m}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const ctx = await browser.newContext({
  viewport: args.tv ? { width: 1920, height: 1080 } : args.landscape ? { width: 852, height: 393 } : { width: 393, height: 852 },
  deviceScaleFactor: args.tv ? 1 : 3,
  isMobile: !args.tv,
  hasTouch: true,
  permissions: ["camera"],
});
const page = await ctx.newPage();
const requests = [];
let started = false;
page.on("request", (r) => requests.push({ afterStart: started, method: r.method(), type: r.resourceType(), url: r.url() }));
page.on("websocket", (ws) => requests.push({ afterStart: started, method: "WS", type: "websocket", url: ws.url() }));
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const resp = await page.goto(base, { waitUntil: "networkidle" });
const csp = resp.headers()["content-security-policy"] || null;
await page.screenshot({ path: `${outDir}/01-intro.png` });
started = true;
await page.getByRole("button", { name: /카메라 시작/ }).tap();
await page.waitForFunction(() => window.__ppv && ["calibrating", "running", "error"].includes(window.__ppv.state.mode), null, { timeout: 120000 });
const modeAfterStart = await page.evaluate(() => window.__ppv.state.mode);
await page.screenshot({ path: `${outDir}/02-after-start.png` });
if (modeAfterStart === "error") {
  console.log("CAMERA_ERROR", JSON.stringify(await page.evaluate(() => window.__ppv.state.error)));
  await browser.close();
  process.exit(1);
}
if (modeAfterStart === "calibrating") {
  const video = await page.evaluate(() => ({ w: window.__ppv.state.video.width, h: window.__ppv.state.video.height }));
  for (const c of corners) {
    const pt = await page.evaluate(([x, y]) => {
      const v = document.querySelector("video");
      const r = v.getBoundingClientRect();
      const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { x: r.left + (r.width - v.videoWidth * s) / 2 + x * s, y: r.top + (r.height - v.videoHeight * s) / 2 + y * s };
    }, [c.x * (video.w / 1920), c.y * (video.h / 1080)]);
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: `${outDir}/03-calibration-4-taps.png` });
  await page.getByRole("button", { name: /확인/ }).tap();
}
const samples = [];
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1000);
  samples.push(
    await page.evaluate(() => {
      const s = window.__ppv.state;
      return { mode: s.mode, fps: s.perf.fps, ms: Math.round(s.perf.ms * 10) / 10, shots: s.rally.shots, trail: s.ball.trail.length, bounces: s.bounces.length, poses: ["near", "far"].filter((k) => s.players[k].landmarks).length, history: s.history.length };
    }),
  );
  if (i === 5 || i === seconds - 1) await page.screenshot({ path: `${outDir}/04-running-${i}.png` });
}
const final = await page.evaluate(() => {
  const s = window.__ppv.state;
  return { mode: s.mode, video: s.video, calibration: !!s.calibration, history: s.history, rally: s.rally, players: { near: { ...s.players.near, landmarks: !!s.players.near.landmarks }, far: { ...s.players.far, landmarks: !!s.players.far.landmarks } } };
});
let stopError = null;
try {
  await page.getByRole("button", { name: /정지/ }).first().tap({ timeout: 5000 });
} catch (err) {
  stopError = String(err.message || err).split("\n")[0];
}
await page.waitForTimeout(500);
const modeAfterStop = await page.evaluate(() => window.__ppv.state.mode);
await page.screenshot({ path: `${outDir}/05-stopped.png` });
await browser.close();

const origin = new URL(base).origin;
const after = requests.filter((r) => r.afterStart);
const offending = after.filter((r) => new URL(r.url).origin !== origin || r.method !== "GET" || r.type === "websocket");
const report = { base, csp, modeAfterStart, modeAfterStop, stopError, samples, final, requestsAfterStart: after, offendingRequests: offending, consoleErrors };
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
const maxShots = Math.max(...samples.map((s) => s.shots), 0);
const maxTrail = Math.max(...samples.map((s) => s.trail), 0);
console.log(`CAMERA_DONE start=${modeAfterStart} stop=${modeAfterStop} stopError=${stopError ? "YES" : "no"} maxShots=${maxShots} maxTrail=${maxTrail} history=${final.history.length} fps=${samples.map((s) => s.fps).join(",")} reqAfterStart=${after.length} offending=${offending.length} csp=${!!csp}`);
