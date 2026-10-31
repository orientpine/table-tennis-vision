// What the camera does when automatic scoring is about to fail quietly (lead, 2026-10-31 06:07 KST).
//   starve  - the camera stops delivering new frames after the 10 s baseline: the portrait picture goes
//             small (middle row, chip "판정 안정 모드 · 영상 작게"); 30 s of good analysis bring the
//             full screen back; bad again keeps it small for the rest of the run; the history sheet
//             says when and why; the stored 판정용 영상 setting is unchanged
//   dark    - a dim picture shows "조명이 어두워요" once, recording goes on
//   small   - calibrating a table under 5% of the frame shows "탁구대가 작아요" on 확인, then records
//   bun qa/guards-ui.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=12850]
import { chromium } from "playwright";
import { DEVICES, startOneApp, CORNERS } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 12850) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };

// fake camera: the clip in a 540x960 canvas stream; window.__cam.mode switches it to "frozen" (no new
// frame) or "dim" (the clip at 15% brightness)
function camera(src) {
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage__video { visibility: visible !important; }";
    document.head.append(st);
  });
  window.__cam = { mode: "live" };
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
    const draw = () => {
      if (window.__cam.mode === "frozen") return;
      g.filter = window.__cam.mode === "dim" ? "brightness(0.15)" : "none";
      g.drawImage(v, 0, 0, c.width, c.height);
    };
    draw();
    setInterval(draw, 1000 / 30);
    return c.captureStream(30);
  };
}

async function open() {
  const ctx = await browser.newContext(DEVICES.phone);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "camera"); });
  await ctx.addInitScript(camera, `${app.origin}/__qa/cam.webm`);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(app.origin + "/");
  await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 }).catch(async (err) => {
    const seen = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body?.innerText.slice(0, 200), role: localStorage.getItem("pp-role") })).catch(() => null);
    console.log("NO_APP", JSON.stringify(seen), errors.slice(0, 3));
    throw err;
  });
  await page.getByRole("button", { name: /카메라 시작/ }).click();
  await page.waitForFunction(() => window.__ppv?.state.mode === "calibrating", null, { timeout: 120000 });
  return { ctx, page, errors };
}
async function calibrate(page, corners) {
  const s = await page.evaluate(() => window.__ppv.state.video);
  for (const c of corners) {
    const pt = await page.evaluate(([x, y]) => { const v = document.querySelector("video.stage__video"); const r = v.getBoundingClientRect(); const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k }; }, [(c.x * s.width) / 1920, (c.y * s.height) / 1080]);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(250);
  }
  await page.getByRole("button", { name: /^확인/ }).click();
}
const toastSaid = (page, text, ms) => page.waitForFunction((t) => (document.getElementById("toast")?.textContent || "").includes(t), text, { timeout: ms }).then(() => true, () => false);

const only = args.only ? new Set(args.only.split(",")) : null;
const want = (k) => !only || only.has(k);
try {
  // starve: after the 10 s baseline, freeze the camera -> picture small; live again for 30 s -> full
  // screen; freeze again -> small for the rest of the run, even after 30 more good seconds
  if (want("starve")) {
    const { ctx, page, errors } = await open();
    await calibrate(page, CORNERS);
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
    const view = () => page.evaluate(() => {
      const s = document.querySelector(".stage").getBoundingClientRect();
      const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.includes("판정 안정 모드"));
      return { compact: !!window.__ppv.state.stable?.compact, locked: !!window.__ppv.state.stable?.locked, attr: document.querySelector(".app").getAttribute("data-stable"), h: Math.round(s.height), vh: innerHeight, chip: chip && !chip.hidden && chip.offsetWidth ? chip.textContent : null };
    });
    await page.waitForTimeout(11000);
    await page.evaluate(() => { window.__cam.mode = "frozen"; });
    // two bad 5 s windows in a row (10 s) before it switches
    const small = await page.waitForFunction(() => window.__ppv.state.stable?.compact, null, { timeout: 30000 }).then(() => true, () => false);
    await page.waitForTimeout(400);
    const v1 = await view();
    check("starve: frozen camera -> picture small, chip says so", small && v1.attr === "1" && v1.h < v1.vh * 0.85 && v1.chip === "판정 안정 모드 · 영상 작게", v1);
    await page.evaluate(() => { window.__cam.mode = "live"; });
    const back = await page.waitForFunction(() => !window.__ppv.state.stable?.compact, null, { timeout: 50000 }).then(() => true, () => false);
    await page.waitForTimeout(400);
    const v2 = await view();
    check("starve: 30 s of good analysis -> full screen again, chip gone", back && v2.attr === "0" && v2.h >= v2.vh * 0.95 && !v2.chip, v2);
    await page.evaluate(() => { window.__cam.mode = "frozen"; });
    const again = await page.waitForFunction(() => window.__ppv.state.stable?.compact, null, { timeout: 30000 }).then(() => true, () => false);
    await page.evaluate(() => { window.__cam.mode = "live"; });
    await page.waitForTimeout(40000);
    const v3 = await view();
    check("starve: bad again after coming back -> small for the rest of the run", again && v3.compact && v3.locked && v3.attr === "1", v3);
    // the chip is a button: a tap goes full screen at once, and a frozen camera does not switch again
    await page.getByRole("button", { name: "판정 안정 모드 끄고 전체 화면으로" }).click();
    await page.waitForTimeout(400);
    const v4 = await view();
    await page.evaluate(() => { window.__cam.mode = "frozen"; });
    await page.waitForTimeout(20000);
    const v5 = await view();
    await page.evaluate(() => { window.__cam.mode = "live"; });
    check("starve: chip tap -> full screen now, frozen 20 s after it stays full", !v4.compact && v4.attr === "0" && v4.h >= v4.vh * 0.95 && !v5.compact && v5.attr === "0", { v4, v5 });
    const stored = await page.evaluate(() => localStorage.getItem("ppv.analysisFrom"));
    check("starve: the stored 판정용 영상 setting is untouched", stored === null || stored === '"screen"', { stored });
    await page.getByRole("button", { name: "기록", exact: true }).first().click();
    await page.waitForTimeout(500);
    const note = await page.locator(".sheet .screen__note").first().textContent().catch(() => "");
    check("starve: history sheet says when and why", /영상 작게/.test(note || "") && /전체 화면으로 돌아감/.test(note || "") && /fps/.test(note || ""), { note });
    check("starve: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  // off: 판정 안정 모드 set to 끄기 in settings; a frozen camera never makes the picture small, and the
  // choice is remembered on the device
  if (want("off")) {
    const { ctx, page, errors } = await open();
    await calibrate(page, CORNERS);
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
    await page.getByRole("button", { name: /^설정/ }).first().click();
    await page.waitForTimeout(400);
    await page.getByRole("group", { name: "판정 안정 모드" }).getByRole("button", { name: "끄기" }).click();
    const pressed = await page.getByRole("group", { name: "판정 안정 모드" }).getByRole("button", { name: "끄기" }).getAttribute("aria-pressed");
    await page.getByRole("button", { name: /^설정/ }).first().click();
    await page.waitForTimeout(11000);
    await page.evaluate(() => { window.__cam.mode = "frozen"; });
    const switched = await page.waitForFunction(() => window.__ppv.state.stable?.compact, null, { timeout: 25000 }).then(() => true, () => false);
    const attr = await page.evaluate(() => document.querySelector(".app").getAttribute("data-stable"));
    const stored = await page.evaluate(() => localStorage.getItem("ppv.stableMode"));
    check("off: frozen camera 25 s with 끄기 -> picture never small", !switched && attr === "0" && pressed === "true", { switched, attr, pressed });
    check("off: 끄기 is remembered on the device", stored === '"off"', { stored });
    check("off: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  // dark: dim the picture while recording
  if (want("dark")) {
    const { ctx, page, errors } = await open();
    await calibrate(page, CORNERS);
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
    await page.evaluate(() => { window.__cam.mode = "dim"; });
    const said = await toastSaid(page, "조명이 어두워요", 15000);
    const mode = await page.evaluate(() => window.__ppv.state.mode);
    check("dark: low-light notice shown, recording goes on", said && mode === "running", { said, mode });
    check("dark: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  // small: a table well under 5% of the frame
  if (want("small")) {
    const { ctx, page, errors } = await open();
    const small = [{ x: 860, y: 560 }, { x: 900, y: 540 }, { x: 1060, y: 540 }, { x: 1100, y: 560 }];
    await calibrate(page, small);
    const said = await toastSaid(page, "탁구대가 작아요", 5000);
    const mode = await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 }).then(() => "running", () => "not running");
    check("small: small-table notice on 확인, calibration still goes on", said && mode === "running", { said, mode });
    check("small: no page errors", errors.length === 0, errors);
    await ctx.close();
  }
  // a normal table gets no small-table notice
  if (want("normal")) {
    const { ctx, page } = await open();
    await calibrate(page, CORNERS);
    const said = await toastSaid(page, "탁구대가 작아요", 2500);
    check("normal table: no small-table notice", !said, { said });
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
const fails = results.filter((r) => !r.pass).length;
console.log(`GUARDS_UI checks=${results.length} fails=${fails}`);
process.exit(fails ? 1 : 0);
