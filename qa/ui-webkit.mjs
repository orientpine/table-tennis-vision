import { devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || process.env.PPV_BASE || "http://127.0.0.1:8801/vision/";
const clip = args.clip;
const corners = JSON.parse(args.corners);
const out = args.out || "evidence/ui-real";
const orientation = args.orientation || "portrait";
mkdirSync(out, { recursive: true });

const iphone = devices["iPhone 15"];
const viewport = orientation === "landscape" ? { width: iphone.viewport.height, height: iphone.viewport.width } : iphone.viewport;
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const ctx = await browser.newContext({ ...iphone, viewport });
await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
  if (m.text().startsWith("ppv:")) console.log("PAGE", m.text());
});
const steps = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    steps.push({ name, pass: true, detail });
  } catch (err) {
    steps.push({ name, pass: false, detail: String(err.message || err).split("\n")[0] });
  }
  await page.screenshot({ path: `${out}/${orientation}-${String(steps.length).padStart(2, "0")}-${name}.png` });
};
const st = () => page.evaluate(() => window.__ppv.state);
const waitMode = (modes, timeout = 120000) => page.waitForFunction((m) => m.includes(window.__ppv?.state.mode), modes, { timeout });

const measure = () =>
  page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && !el.closest("[hidden]") && getComputedStyle(el).visibility !== "hidden";
    };
    const controls = [...document.querySelectorAll("button, [role=button], input:not([type=file]), label")].filter(vis).map((el) => {
      const r = el.getBoundingClientRect();
      return { name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      small: controls.filter((c) => c.w < 44 || c.h < 44),
      controls: controls.length,
      hOverflow: document.documentElement.scrollWidth > innerWidth,
      vOverflow: document.documentElement.scrollHeight > innerHeight,
    };
  });

await page.goto(base, { waitUntil: "networkidle" });
await step("intro", async () => {
  const m = await measure();
  if (m.small.length || m.hOverflow) throw new Error(`small=${JSON.stringify(m.small)} hOverflow=${m.hOverflow}`);
  return m;
});
await step("open-file", async () => {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".screen--intro label.btn--file").tap();
  await (await chooser).setFiles(clip);
  await waitMode(["calibrating", "running", "error"]);
  const s = await st();
  if (s.mode === "error") throw new Error(JSON.stringify(s.error));
  return { mode: s.mode, video: s.video };
});
await step("calibrate-4-taps", async () => {
  const s0 = await st();
  if (s0.mode !== "calibrating") await page.getByRole("button", { name: /코트 보정/ }).tap();
  await waitMode(["calibrating"], 10000);
  const vw = (await st()).video.width;
  const k = vw / 1920;
  for (const c of corners) {
    const pt = await page.evaluate(([x, y]) => {
      const v = document.querySelector("video");
      const r = v.getBoundingClientRect();
      const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { x: r.left + (r.width - v.videoWidth * s) / 2 + x * s, y: r.top + (r.height - v.videoHeight * s) / 2 + y * s };
    }, [c.x * k, c.y * k]);
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(200);
  }
  await page.getByRole("button", { name: /확인/ }).tap({ timeout: 5000 });
  try {
    await waitMode(["running"], 10000);
  } catch (err) {
    const diag = await page.evaluate(() => {
      const v = document.querySelector("video");
      const s = window.__ppv.state;
      return { mode: s.mode, calibration: !!s.calibration, error: s.error, paused: v.paused, currentTime: v.currentTime, ended: v.ended, readyState: v.readyState };
    });
    throw new Error(`not running after confirm: ${JSON.stringify(diag)}`);
  }
  const got = (await st()).calibration.corners;
  const err = Math.max(...got.map((g, i) => Math.hypot(g.x - corners[i].x * k, g.y - corners[i].y * k)));
  const videoPxPerCssPx = await page.evaluate(() => {
    const v = document.querySelector("video");
    const r = v.getBoundingClientRect();
    return 1 / Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  });
  const errCss = err / videoPxPerCssPx;
  // The fourth tap snaps the corners onto the table's white border (calib-refine.js), so the
  // saved corners may sit a few px from exact taps; more than 8 px (1080p) is a wrong snap.
  if (err > 8 * k) throw new Error(`corner error ${err.toFixed(2)} video px = ${errCss.toFixed(2)} CSS px`);
  const currentTime = await page.evaluate(() => document.querySelector("video").currentTime);
  return { maxCornerErrorVideoPx: Math.round(err * 100) / 100, maxCornerErrorCssPx: Math.round(errCss * 100) / 100, videoTimeAfterCalibration: Math.round(currentTime * 100) / 100 };
});
await step("running-hud", async () => {
  const samples = [];
  for (const at of [2, 4, 6]) {
    await page.waitForTimeout(2000);
    const s = await st();
    const media = await page.evaluate(() => {
      const v = document.querySelector("video");
      return { paused: v.paused, readyState: v.readyState, currentTime: Math.round(v.currentTime * 100) / 100, error: v.error && v.error.code };
    });
    const hud = {
      rallyTimeMs: Math.round(s.rally.timeMs),
      shots: s.rally.shots,
      speedKmh: s.rally.speedKmh,
      bounces: s.bounces.map((b) => b.side),
      lastShot: s.lastShot && s.lastShot.label,
      near: { moveM: s.players.near.moveM, wristKmh: s.players.near.wristKmh, shotKmh: s.players.near.shotKmh },
      far: { moveM: s.players.far.moveM, wristKmh: s.players.far.wristKmh, shotKmh: s.players.far.shotKmh },
    };
    samples.push({ at, videoTime: media.currentTime, fps: s.perf.fps, shots: s.rally.shots, trail: s.ball.trail.length, poses: ["near", "far"].filter((p) => s.players[p].landmarks).length, media, hud });
    await page.screenshot({ path: `${out}/${orientation}-skeleton-${at}s.png` });
    if (args.live) await page.screenshot({ path: `${args.live}-${orientation}-${at}s.png` });
  }
  const m = await measure();
  if (m.small.length || m.hOverflow) throw new Error(`small=${JSON.stringify(m.small)} hOverflow=${m.hOverflow}`);
  const processed = samples.every((x) => x.fps > 0) && samples.some((x) => x.trail > 0) && samples.every((x) => x.poses >= 1);
  if (!processed) throw new Error(`no live processing: ${JSON.stringify(samples)}`);
  return { samples, ...m };
});
await step("swap-players", async () => {
  const before = await page.evaluate(() => window.__ppv.pipeline.players.swapped);
  await page.getByRole("button", { name: /자리 교체/ }).tap();
  const after = await page.evaluate(() => window.__ppv.pipeline.players.swapped);
  if (before === after) throw new Error("swap flag unchanged");
  return { before, after };
});
await step("stop", async () => {
  await page.getByRole("button", { name: /정지/ }).first().tap({ timeout: 5000 });
  await waitMode(["stopped"], 5000);
  return { mode: (await st()).mode };
});
await step("history", async () => {
  await page.getByRole("button", { name: /기록/ }).first().tap({ timeout: 5000 });
  await page.waitForFunction(() => window.__ppv.state.showHistory, null, { timeout: 5000 });
  if (args.live) await page.screenshot({ path: `${args.live}-${orientation}-history.png` });
  return { rallies: (await st()).history.length, history: (await st()).history };
});
await browser.close();
const report = { base, orientation, viewport, steps, consoleErrors };
writeFileSync(`${out}/${orientation}-report.json`, JSON.stringify(report, null, 2));
console.log(`UI_${orientation.toUpperCase()} ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")} consoleErrors=${consoleErrors.length}`);
for (const s of steps) if (!s.pass) console.log("FAIL", s.name, s.detail);
