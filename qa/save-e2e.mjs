// Rally save end to end through the real camera path (Chromium fake camera, iPhone portrait):
// set the upload key -> camera start -> 4-tap calibration -> a real rally ends -> the clip and
// record are uploaded -> open the share link (page 200, video plays) -> delete -> link is 404.
//   bun qa/save-e2e.mjs --base=http://127.0.0.1:8801/vision/ --y4m=<rally.y4m> --corners='<json, 1920x1080 scale>'
//       --key=<upload key> --saves=<server save dir> [--ui=1] [--out=evidence/r2/save]
import { chromium } from "playwright";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || "http://127.0.0.1:8801/vision/";
const out = args.out || "evidence/r2/save";
const corners = JSON.parse(args.corners);
const ui = args.ui === "1";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${args.y4m}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ["camera"] });
await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
const page = await ctx.newPage();
const requests = [];
page.on("request", (r) => requests.push({ method: r.method(), url: r.url() }));
const steps = [];
const step = async (name, fn) => {
  try {
    steps.push({ name, pass: true, detail: await fn() });
  } catch (err) {
    steps.push({ name, pass: false, detail: String(err.message || err).split("\n")[0] });
  }
  await page.screenshot({ path: `${out}/${String(steps.length).padStart(2, "0")}-${name}.png` }).catch(() => {});
};
const st = () => page.evaluate(() => window.__ppv.state);

await page.goto(base, { waitUntil: "networkidle" });
const setKey = async () => {
  if (ui) {
    await page.getByRole("button", { name: /설정/ }).first().tap();
    await page.locator("input[name=upload-key]").fill(args.key);
    await page.getByRole("button", { name: /열쇠 저장/ }).tap();
    await page.waitForFunction(() => window.__ppv.state.save.keySet, null, { timeout: 10000 });
    await page.screenshot({ path: `${out}/settings-key.png` });
    await page.locator(".popover button[aria-label='설정 닫기']").tap();
  } else {
    await page.evaluate((k) => localStorage.setItem("ppv.uploadKey", JSON.stringify(k)), args.key);
    await page.reload({ waitUntil: "networkidle" });
  }
  await page.waitForFunction(() => window.__ppv.state.save.keySet, null, { timeout: 10000 });
  return (await st()).save;
};
if (!ui) await step("set-key", setKey);
await step("camera-calibrate", async () => {
  await page.getByRole("button", { name: /카메라 시작/ }).tap();
  await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv.state.mode), null, { timeout: 120000 });
  const s = await st();
  if (s.mode === "error") throw new Error(JSON.stringify(s.error));
  if (s.mode === "calibrating") {
    for (const c of corners) {
      const pt = await page.evaluate(([x, y]) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
      await page.touchscreen.tap(pt.x, pt.y);
      await page.waitForTimeout(250);
    }
    await page.getByRole("button", { name: /확인/ }).tap();
  }
  await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 10000 });
  return { supported: (await st()).save.supported };
});
if (ui) await step("set-key", setKey);
let entry = null;
await page.evaluate(() => {
  window.__qaLog = [];
  setInterval(() => {
    const s = window.__ppv.state;
    window.__qaLog.push({ fps: s.perf.fps, tracking: s.tracking, shots: s.rally.shots, bounces: s.bounces.length, history: s.history.length });
  }, 1000);
});
await step("rally-then-stop", async () => {
  // A kept rally (2+ shots, 1+ bounce) either ends by itself or is stopped the way the owner does;
  // the fake camera loops one clip, so a rally that is still going is stopped once it qualifies.
  await page.waitForFunction(() => {
    const s = window.__ppv.state;
    return s.history.some((h) => h.upload) || (s.save.recording && s.rally.shots >= 2 && s.bounces.length >= 1);
  }, null, { timeout: 300000, polling: 100 });
  const ended = (await st()).history.some((h) => h.upload);
  await page.waitForTimeout(ended ? 0 : 300);
  await page.getByRole("button", { name: /정지/ }).tap();
  return { endedByItself: ended, rally: (await st()).rally };
});
await step("rally-uploaded", async () => {
  await page.waitForFunction(() => {
    const h = window.__ppv.state.history.find((r) => r.upload);
    return h && (h.upload.status === "done" || h.upload.status === "failed");
  }, null, { timeout: 60000, polling: 500 });
  entry = (await st()).history.find((r) => r.upload);
  if (entry.upload.status !== "done") throw new Error(JSON.stringify(entry.upload));
  return { shots: entry.shots, durationMs: entry.durationMs, upload: entry.upload, savedDirs: readdirSync(args.saves).length };
});
await step("history", async () => {
  await page.getByRole("button", { name: /^기록$/ }).first().tap();
  await page.waitForTimeout(600);
  const text = await page.locator(".sheet").innerText();
  if (ui && !/올림/.test(text)) throw new Error(`history sheet shows no 올림: ${text.slice(0, 200)}`);
  return { sheet: text.slice(0, 300) };
});
let share = null;
await step("open-share-link", async () => {
  share = await ctx.newPage();
  const res = await share.goto(entry.upload.url, { waitUntil: "load" });
  if (res.status() !== 200) throw new Error(`share page ${res.status()}`);
  const v = await share.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.querySelector("video");
        const done = () => resolve({ duration: el.duration, w: el.videoWidth, h: el.videoHeight, error: el.error && el.error.code });
        if (el.readyState >= 1) return done();
        el.addEventListener("loadedmetadata", done, { once: true });
        el.addEventListener("error", done, { once: true });
        setTimeout(done, 15000);
      }),
  );
  await share.evaluate(() => {
    const el = document.querySelector("video");
    el.currentTime = Math.min(1, (el.duration || 2) / 2);
    return new Promise((r) => el.addEventListener("seeked", r, { once: true }));
  }).catch(() => {});
  await share.screenshot({ path: `${out}/share-page.png` });
  if (!(v.w > 0) || v.error) throw new Error(`video ${JSON.stringify(v)}`);
  return v;
});
await step("delete", async () => {
  if (ui) {
    await page.locator(".rally", { hasText: "올림" }).first().getByRole("button", { name: /지우기/ }).tap();
    await page.waitForFunction((id) => !window.__ppv.state.history.some((r) => r.id === id), entry.id, { timeout: 10000 });
  } else {
    const status = await page.evaluate(async ([id, key]) => (await fetch(`./api/rallies/${id}`, { method: "DELETE", headers: { "x-ppv-key": key } })).status, [entry.upload.id, args.key]);
    if (status !== 204) throw new Error(`delete ${status}`);
  }
  const after = await share.goto(entry.upload.url);
  const video = await share.goto(`${entry.upload.url}/video`);
  if (after.status() !== 404 || video.status() !== 404) throw new Error(`after delete page ${after.status()} video ${video.status()}`);
  return { page: after.status(), video: video.status(), savedDirs: readdirSync(args.saves).length };
});
const offending = requests.filter((r) => !r.url.startsWith(new URL(base).origin));
const log = await page.evaluate(() => window.__qaLog).catch(() => []);
const report = { base, ui, steps, log, uploads: requests.filter((r) => r.method === "POST").map((r) => r.url), offending };
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(`SAVE_E2E ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")} offending=${offending.length}`);
for (const s of steps) if (!s.pass) console.log(`FAIL ${s.name} ${s.detail}`);
process.exit(steps.every((s) => s.pass) ? 0 : 1);
