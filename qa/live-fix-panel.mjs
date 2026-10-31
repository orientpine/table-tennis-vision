// Live check of the deployed camera screen on the public address, without touching the real
// tournament: WebKit iPhone 15 (393x852), fake camera (the test clip served by the browser route),
// a stand-in PIN whose /api/pin/verify and every POST /api/* are answered inside the browser
// (403, never sent), and the tournament WebSocket closed in the browser (no camera presence on
// the venue screens). Reads /api/state for real. Checks: the build, the 점수 chip and the open
// panel with the real match, the camera running, then that no fix write left the browser.
//   bun qa/live-fix-panel.mjs --base=<public origin>/ --clip=<webm> [--out=evidence/r7/live]
import { devices, webkit } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r7/live";
mkdirSync(out, { recursive: true });
const base = args.base.replace(/\/?$/, "/");
const clip = readFileSync(args.clip);
const corners = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
// service workers blocked: a worker could forward /api requests past the routes below
const ctx = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "block" });
await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
const sent = [];
const blocked = [];
await ctx.route("**/__qa/cam.webm", (r) => r.fulfill({ status: 200, contentType: "video/webm", body: clip }));
await ctx.route("**/api/**", (r) => {
  const req = r.request();
  if (req.method() === "GET") { sent.push(`GET ${new URL(req.url()).pathname}`); return r.continue(); }
  const path = new URL(req.url()).pathname;
  blocked.push(`${req.method()} ${path} ${req.postData() || ""}`.slice(0, 160));
  if (path === "/api/pin/verify") return r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  return r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"live check: not sent"}' });
});
await ctx.routeWebSocket(/\/ws/, (ws) => ws.close());
await ctx.addInitScript(() => {
  const target = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  target.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = "/__qa/cam.webm"; v.muted = true; v.loop = true; v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    const c = document.createElement("canvas"); c.width = 960; c.height = 540;
    const g = c.getContext("2d");
    setInterval(() => g.drawImage(v, 0, 0, c.width, c.height), 1000 / 30);
    return c.captureStream(30);
  };
  document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = ".stage__video { visibility: visible !important; }"; document.head.append(st); });
  if (!sessionStorage.getItem("__live")) { sessionStorage.setItem("__live", "1"); localStorage.setItem("pp-role", "camera"); localStorage.setItem("pp-pin", "live-check-not-a-pin"); }
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const res = { steps: {} };
try {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ppv && window.__ppv.state.tour.connected, null, { timeout: 30000 });
  res.address = new URL(page.url()).pathname;
  res.build = await page.evaluate(async () => (await (await fetch("/vision/sw.js")).text()).match(/BUILD = "([0-9a-f]+)"/)?.[1]);
  await page.getByRole("button", { name: /카메라 시작/ }).click();
  await page.waitForFunction(() => ["calibrating", "running"].includes(window.__ppv.state.mode), null, { timeout: 120000 });
  if ((await page.evaluate(() => window.__ppv.state.mode)) === "calibrating") {
    const s = await page.evaluate(() => window.__ppv.state.video);
    for (const c of corners) {
      const pt = await page.evaluate(([x, y]) => { const v = document.querySelector("video.stage__video"); const r = v.getBoundingClientRect(); const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k }; }, [c.x * (s.width / 1920), c.y * (s.height / 1080)]);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(300);
    }
    await page.getByRole("button", { name: /확인/ }).click();
  }
  await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
  res.steps.running = true;
  await page.locator(".chip--fix").click();
  await page.waitForSelector(".fix:not([hidden])", { timeout: 10000 });
  const t0 = await page.evaluate(() => document.querySelector(".stage__video").currentTime);
  await page.waitForTimeout(1500);
  res.panel = await page.evaluate((t0) => ({
    score: document.querySelector(".fix__score").textContent,
    recent: [...document.querySelectorAll(".fix__recent button")].map((b) => b.textContent),
    mode: window.__ppv.state.mode,
    videoAdvanced: document.querySelector(".stage__video").currentTime > t0,
    track: document.querySelector(".stage__video").srcObject.getVideoTracks()[0].readyState,
  }), t0);
  await page.screenshot({ path: `${out}/live-panel-p852.png` });
  // one +1 tap: the write is answered in the browser (403) and never reaches the server
  await page.locator(".fix__plus[data-side='0']").click();
  await page.waitForFunction(() => !window.__ppv.state.tour.fix.busy, null, { timeout: 10000 });
  res.afterTap = await page.evaluate(() => ({ error: window.__ppv.state.tour.error, note: document.querySelector(".fix__note").textContent }));
  await page.screenshot({ path: `${out}/live-panel-tap-blocked.png` });
} catch (err) {
  res.error = String(err.message || err).split("\n")[0];
} finally {
  res.blocked = blocked;
  res.gets = [...new Set(sent)];
  res.consoleErrors = errors;
  writeFileSync(`${out}/report.json`, JSON.stringify(res, null, 2));
  await browser.close();
}
console.log(JSON.stringify(res));
process.exit(res.error ? 1 : 0);
