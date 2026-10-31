// Preview-branch smoke for the "판정용 영상(시험)" setting
// (the owner's phone check, 2026-10-31).
//   화면 (default): only the stage video holds the camera stream; the hidden analysis video has nothing.
//   따로 작게 / 따로 크게: the hidden video holds a clone of the stream (its own track), never the same one.
//   Each setting: calibrate with 4 taps and reach running.
//   Changing the setting while running restarts the camera so it applies.
//   bun qa/analysis-source-smoke.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --port=<n>
import { chromium } from "playwright";
import { DEVICES, fakeCamera, startOneApp, CORNERS } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 12760) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };

// what each video element holds: the stage video, the hidden analysis video, the test's fake source
const videos = (page) => page.evaluate(() => {
  const stage = document.querySelector("video.stage__video");
  const probe = [...document.querySelectorAll("video")].find((v) => v !== stage && v.getAttribute("aria-hidden") === "true" && !v.src);
  const ids = (v) => (v && v.srcObject ? v.srcObject.getVideoTracks().map((t) => t.id) : []);
  return { stage: ids(stage), probe: ids(probe), probeHas: !!(probe && probe.srcObject), mode: window.__ppv.state.mode };
});
const guide = (page) => page.evaluate(() => ({
  text: document.querySelector(".calibbar__text")?.textContent || "",
  restart: [...document.querySelectorAll(".calibbar__actions button")].filter((b) => !b.hidden && b.offsetWidth).map((b) => b.textContent.trim()),
}));

async function openCamera(from) {
  const ctx = await browser.newContext(DEVICES.phone);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  await ctx.addInitScript((f) => { localStorage.setItem("pp-role", "camera"); localStorage.setItem("ppv.analysisFrom", JSON.stringify(f)); }, from);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(app.origin + "/");
  await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
  await page.getByRole("button", { name: /카메라 시작/ }).click();
  await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 120000 });
  return { ctx, page, errors };
}
async function tapCorners(page) {
  const s = await page.evaluate(() => window.__ppv.state.video);
  for (const c of CORNERS) {
    const pt = await page.evaluate(([x, y]) => { const v = document.querySelector("video.stage__video"); const r = v.getBoundingClientRect(); const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k }; }, [(c.x * s.width) / 1920, (c.y * s.height) / 1080]);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(250);
  }
  await page.getByRole("button", { name: /^확인/ }).click();
  await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
}

try {
  for (const [from, label] of [["screen", "화면"], ["probe", "따로 작게"], ["probe-big", "따로 크게"]]) {
    const { ctx, page, errors } = await openCamera(from);
    await page.waitForTimeout(2600);   // longer than the 2 s no-picture limit
    const v = await videos(page);
    const g = await guide(page);
    check(`${label}: calibrating, no edge warning`, v.mode === "calibrating" && !g.text.includes("화면 밖"), { mode: v.mode, guide: g.text });
    if (from === "screen") check(`${label}: one video holds the camera, hidden video empty`, v.stage.length === 1 && !v.probeHas, v);
    else check(`${label}: hidden video has its own cloned track`, v.stage.length === 1 && v.probe.length === 1 && v.probe[0] !== v.stage[0], v);
    await tapCorners(page);
    const after = await videos(page);
    check(`${label}: 4 taps reach running`, after.mode === "running", { mode: after.mode });
    check(`${label}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }

  // the setting applies to a running camera by restarting it
  {
    const { ctx, page } = await openCamera("screen");
    await tapCorners(page);
    const before = await videos(page);
    await page.getByRole("button", { name: /^설정/ }).first().click();
    await page.getByRole("button", { name: "따로 작게" }).click();
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const after = await videos(page);
    check("switch 화면 -> 따로 작게 while running restarts the camera", before.stage[0] !== after.stage[0] && after.probe.length === 1 && after.probe[0] !== after.stage[0] && after.mode === "running", { before, after });
    await ctx.close();
  }

} finally {
  await browser.close();
  await app.stop();
}
const fails = results.filter((r) => !r.pass).length;
console.log(`ANALYSIS_SMOKE checks=${results.length} fails=${fails}`);
process.exit(fails ? 1 : 0);
