// The camera turns after it starts (the owner's iPhone, 2026-10-31 06:10 KST): the stream reports a landscape
// 960x540 frame, then, once calibration is on screen, a portrait 540x960 one. Everything sized at start
// must follow the new shape:
//   taps      - a tap anywhere on the portrait picture (4 corners and the centre) puts the corner under
//               the finger, within 2 px (before: squeezed into a landscape band, all on one line)
//   loupe     - dragging a corner, the magnifier's centre is the video point under the finger, within
//               2 screen px (before: an offset, owner: "손가락이 닿은 곳이 확대된게 아니라 오프셋")
//   analysis  - the analysis canvas becomes portrait (height > width)
//   recorder  - the rally clip canvas becomes portrait
//   bun qa/video-resize.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=12780]
import { chromium } from "playwright";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 12780) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };

// fake camera: a canvas stream of the clip that turns from 960x540 to 540x960 shortly after the app
// shows calibration, the way an upright iPhone's first frames arrive in the sensor's shape
function turningCamera(src) {
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage__video { visibility: visible !important; }";
    document.head.append(st);
  });
  const t = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  t.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    const c = document.createElement("canvas");
    c.width = 960; c.height = 540;
    const g = c.getContext("2d");
    let turned = false;
    const draw = () => {
      if (!turned && window.__ppv?.state.mode === "calibrating") {
        turned = true;
        setTimeout(() => { c.width = 540; c.height = 960; window.__turnedAt = performance.now(); }, 500);
      }
      g.fillStyle = "#334"; g.fillRect(0, 0, c.width, c.height);
      const k = Math.min(c.width / v.videoWidth, c.height / v.videoHeight);
      g.drawImage(v, (c.width - v.videoWidth * k) / 2, (c.height - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
    };
    draw();
    setInterval(draw, 1000 / 30);
    return c.captureStream(30);
  };
}

try {
  const ctx = await browser.newContext(DEVICES.phone);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "camera"); });
  await ctx.addInitScript(turningCamera, `${app.origin}/__qa/cam.webm`);
  // record where the loupe reads from: the centre of the drawImage source rectangle, in video px
  await ctx.addInitScript(() => {
    const orig = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas.classList && this.canvas.classList.contains("calib__loupe") && a.length === 9) window.__loupe = { x: a[1] + a[3] / 2, y: a[2] + a[4] / 2 };
      return orig.apply(this, a);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(app.origin + "/");
  await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
  await page.getByRole("button", { name: /카메라 시작/ }).click();
  await page.waitForFunction(() => window.__ppv?.state.mode === "calibrating", null, { timeout: 120000 });
  await page.waitForFunction(() => window.__turnedAt && document.querySelector("video.stage__video").videoHeight > document.querySelector("video.stage__video").videoWidth, null, { timeout: 20000 });
  await page.waitForTimeout(800);

  // the real picture box on screen (calibration shows the whole picture: contain)
  const geo = () => page.evaluate(() => {
    const v = document.querySelector("video.stage__video");
    const r = v.getBoundingClientRect();
    const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const s = document.querySelector(".stage").getBoundingClientRect();
    return { k, ox: r.left + (r.width - v.videoWidth * k) / 2, oy: r.top + (r.height - v.videoHeight * k) / 2, vw: v.videoWidth, vh: v.videoHeight, sx: s.left, sy: s.top };
  });
  const g = await geo();
  const at = (fx, fy) => ({ x: g.ox + g.vw * g.k * fx, y: g.oy + g.vh * g.k * fy });
  const targets = [["왼쪽 위", at(0.08, 0.08)], ["오른쪽 위", at(0.92, 0.08)], ["오른쪽 아래", at(0.92, 0.92)], ["왼쪽 아래", at(0.08, 0.92)], ["가운데", at(0.5, 0.5)]];
  const markerAt = (i) => page.evaluate((i) => { const m = document.querySelectorAll(".calib__pt")[i]; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
  const markerStage = (i) => page.evaluate((i) => { const m = document.querySelectorAll(".calib__pt")[i]; return { x: parseFloat(m.style.left), y: parseFloat(m.style.top) }; }, i);

  // taps: four corners
  for (let i = 0; i < 4; i++) {
    const [name, p] = targets[i];
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
    const m = await markerStage(i);
    const err = Math.hypot(m.x + g.sx - p.x, m.y + g.sy - p.y);
    check(`tap ${name}: corner under the finger`, err <= 2, { err: Math.round(err * 10) / 10 });
  }
  // loupe: drag corner 1 to each of the five places, a little inside the tapped corners so the drag
  // never starts on top of another corner's marker
  const near = [["가운데", at(0.5, 0.5)], ["왼쪽 위", at(0.16, 0.16)], ["오른쪽 위", at(0.84, 0.16)], ["오른쪽 아래", at(0.84, 0.84)], ["왼쪽 아래", at(0.16, 0.84)]];
  for (const [name, p] of near) {
    const from = await markerAt(0);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + 12, { steps: 2 });
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForTimeout(100);
    const l = await page.evaluate(() => window.__loupe);
    await page.mouse.up();
    const want = { x: (p.x - g.ox) / g.k, y: (p.y - g.oy) / g.k };
    const err = l ? Math.hypot(l.x - want.x, l.y - want.y) * g.k : Infinity;
    const m = await markerStage(0);
    const merr = Math.hypot(m.x + g.sx - p.x, m.y + g.sy - p.y);
    check(`loupe ${name}: centre under the finger`, err <= 2 && merr <= 2, { loupeErrPx: Math.round(err * 10) / 10, markerErrPx: Math.round(merr * 10) / 10 });
  }
  const sizes = await page.evaluate(() => ({ video: window.__ppv.state.video, analysis: { w: window.__ppv.pipeline.pw, h: window.__ppv.pipeline.ph }, recorder: window.__ppv.recorder?.canvas ? { w: window.__ppv.recorder.canvas.width, h: window.__ppv.recorder.canvas.height } : null }));
  check("state.video follows the turned camera", sizes.video.height > sizes.video.width, sizes.video);
  check("analysis canvas is portrait", sizes.analysis.h > sizes.analysis.w, sizes.analysis);
  check("rally clip canvas is portrait", !!sizes.recorder && sizes.recorder.h > sizes.recorder.w, sizes.recorder);
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
} finally {
  await browser.close();
  await app.stop();
}
const fails = results.filter((r) => !r.pass).length;
console.log(`VIDEO_RESIZE checks=${results.length} fails=${fails}`);
process.exit(fails ? 1 : 0);
