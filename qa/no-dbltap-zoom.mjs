// Owner Q407 (2026-10-31): a double tap anywhere must not zoom either app, and two fingers still zoom.
// iOS zooms on a double tap wherever the touch-action chain is plain auto, and WebKit restarts that
// chain at each scroll area, so every element must compute manipulation or a stricter value that was
// already there (calibration layer and markers: none). Also: the viewport tag must not block pinch,
// a double tap on an empty spot leaves visualViewport.scale at 1, two-finger zoom still zooms
// (Chromium), a calibration marker still drags, and a mode card is coloured only while held.
// Neither headless engine on this PC zooms on a double tap even with plain auto (probe 2026-10-31),
// so the computed touch-action check is the one that fails before the fix; iOS Safari does zoom.
//   bun qa/no-dbltap-zoom.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir>
//     [--engine=webkit|chromium] [--port=9930] [--camera=0]
import { chromium, devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/no-dbltap-zoom";
mkdirSync(out, { recursive: true });
const engine = args.engine || "webkit";
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9930) });
const browser = engine === "chromium" ? await chromium.launch() : await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const fails = [];
const rows = [];
let checks = 0;
const check = (name, ok, detail = {}) => { checks++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); if (!ok) fails.push(name); };

// Every element of the document, hidden ones included: one left at auto is a spot where iOS can zoom.
const touchMeasure = (page) => page.evaluate(() => {
  const label = (e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + (typeof e.className === "string" && e.className.trim() ? `.${e.className.trim().split(/\s+/)[0]}` : "");
  const all = [...document.querySelectorAll("*")];
  const auto = all.filter((e) => getComputedStyle(e).touchAction === "auto").map(label);
  // stricter values must be the ones that were already there (calibration), never on the page itself
  const strict = all.filter((e) => !["auto", "manipulation"].includes(getComputedStyle(e).touchAction)).map((e) => `${label(e)}=${getComputedStyle(e).touchAction}`);
  const scrollers = all.filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY + getComputedStyle(e).overflowX)).map((e) => `${label(e)}=${getComputedStyle(e).touchAction}`);
  return { auto: auto.length, autoAt: [...new Set(auto)].slice(0, 6), strict: [...new Set(strict)], scrollers: [...new Set(scrollers)], html: getComputedStyle(document.documentElement).touchAction, body: getComputedStyle(document.body).touchAction, scale: visualViewport.scale };
});
const STRICT_OK = /^(div\.calib|button\.calib__pt)=none$/;
// A spot that is not a control: double-tapping it is exactly what zoomed the owner's screen.
const emptySpot = (page) => page.evaluate(() => {
  // the second pass is for a screen the picture fills (the replay player): the picture is the empty spot
  for (const ctl of ["button, a, input, select, textarea, label, summary, video, canvas, [data-act], [role=button], [tabindex], .calib", "button, a, input, select, textarea, label, summary, [data-act], [role=button], .calib"]) {
    for (let y = 0.15; y < 0.95; y += 0.05) {
      for (let x = 0.08; x < 0.95; x += 0.12) {
        const px = innerWidth * x, py = innerHeight * y;
        const e = document.elementFromPoint(px, py);
        if (e && !e.closest(ctl)) return { x: Math.round(px), y: Math.round(py), at: e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "") };
      }
    }
  }
  return null;
});
const doubleTap = async (page, name) => {
  const spot = await emptySpot(page);
  if (!spot) return check(`${name} 빈 곳 찾음`, false);
  await page.touchscreen.tap(spot.x, spot.y);
  await Bun.sleep(120); // a double tap is defined by its timing
  await page.touchscreen.tap(spot.x, spot.y);
  await Bun.sleep(600);
  const scale = await page.evaluate(() => visualViewport.scale);
  check(`${name} 빈 곳 두 번 탭 뒤 확대 1배`, Math.abs(scale - 1) < 0.001, { spot, scale });
};
const screen = async (page, name, { tap = true } = {}) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const m = await touchMeasure(page);
  rows.push({ screen: name, ...m });
  check(`${name} auto 0개`, m.auto === 0, { auto: m.auto, autoAt: m.autoAt });
  check(`${name} 문서·본문 manipulation`, m.html === "manipulation" && m.body === "manipulation", { html: m.html, body: m.body });
  check(`${name} 스크롤 영역 manipulation 이상`, m.scrollers.every((s) => !s.endsWith("=auto")), { scrollers: m.scrollers });
  check(`${name} 더 엄격한 값은 기존 보정 규칙뿐`, m.strict.every((s) => STRICT_OK.test(s)), { strict: m.strict });
  if (tap) await doubleTap(page, name);
  await page.screenshot({ path: `${out}/${engine}-${name.replace(/[\/ ]/g, "_")}.png` });
};
const open = async (role, withPin, query = "") => {
  const ctx = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 393, height: 852 }, isMobile: engine === "chromium" ? true : undefined, hasTouch: true });
  await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
  await ctx.addInitScript(([r, p]) => {
    if (location.origin === "null" || sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    sessionStorage.setItem("pp-started", "1");
    if (r) localStorage.setItem("pp-role", r);
    if (p) localStorage.setItem("pp-pin", p);
    localStorage.setItem("pp-sound", "0");
  }, [role, withPin ? app.pin : null]);
  const page = await ctx.newPage();
  await page.goto(app.origin + "/" + query, { waitUntil: "load" });
  return { ctx, page };
};
const tab = (page, t) => page.locator("nav.nav button", { hasText: t }).click();

try {
  // 1. the viewport tag keeps two-finger zoom (no user-scalable=no, no maximum-scale)
  for (const path of ["/", "/vision/", "/vision/replay.html"]) {
    const res = await fetch(app.origin + path);
    if (res.status === 404 && path.endsWith("replay.html")) continue;
    const html = await res.text();
    const vp = (html.match(/<meta[^>]+name="viewport"[^>]*>/) || [""])[0];
    check(`viewport ${path} 두 손가락 확대 막지 않음`, !!vp && !/user-scalable\s*=\s*(no|0)/i.test(vp) && !/maximum-scale/i.test(vp), { vp });
  }
  { // 2. start screen and mode picker; a mode card is coloured only while held
    const { ctx, page } = await open(null, false, "?start");
    await page.waitForSelector(".start-go");
    await screen(page, "시작화면");
    await ctx.close();
    const p2 = await open(null, false, "?role");
    await p2.page.waitForSelector(".role-card");
    await screen(p2.page, "모드 고르기");
    const card = await p2.page.locator(".role-card").first().boundingBox();
    const lit = () => p2.page.evaluate(() => [...document.querySelectorAll(".role-card")].filter((c) => c.classList.contains("pressed") || c.classList.contains("on")).length);
    const before = await lit();
    await p2.page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await p2.page.mouse.down();
    const held = await lit();
    await p2.page.mouse.move(card.x + card.width / 2, card.y + card.height + 200);
    await p2.page.mouse.up();
    const after = await lit();
    check("모드 버튼: 들어올 때 색 없음, 누르는 동안만 색, 밖에서 떼면 꺼짐", before === 0 && held === 1 && after === 0 && (await p2.page.locator(".role-card").count()) > 0, { before, held, after });
    await p2.ctx.close();
  }
  { // 3. referee with the PIN, every tab; two-finger zoom still zooms (Chromium can synthesize a pinch)
    const { ctx, page } = await open("referee", true);
    await page.waitForSelector("nav.nav button");
    await screen(page, "심판 경기");
    if (engine === "chromium") { // its own page: a zoom survives a reload and leaves the tabs off screen
      const zoom = await open("referee", true);
      await zoom.page.waitForSelector("nav.nav button");
      // two real touch points spreading apart; Chromium honours touch-action here (pan-x pan-y keeps 1x)
      const cdp = await zoom.ctx.newCDPSession(zoom.page);
      const spot = await emptySpot(zoom.page);
      const pts = (d) => [{ x: spot.x - d, y: spot.y, id: 1 }, { x: spot.x + d, y: spot.y, id: 2 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(20) });
      for (let d = 25; d <= 120; d += 5) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) }); await Bun.sleep(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await Bun.sleep(500);
      const scale = await zoom.page.evaluate(() => visualViewport.scale);
      check("두 손가락 벌리면 확대됨", scale > 1.2, { spot, scale });
      await zoom.ctx.close();
    }
    for (const t of ["대진", "순위", "기록", "설정"]) { await page.reload(); await page.waitForSelector("nav.nav button"); await tab(page, t); await screen(page, `심판 ${t}`); }
    await page.reload();
    await page.waitForSelector("nav.nav button");
    await tab(page, "경기");
    await page.locator('[data-act="ref-enter"]').first().click();
    await page.waitForSelector(".ref");
    await screen(page, "심판 모드", { tap: false }); // the score buttons fill the screen: no empty spot, and a tap would score
    await ctx.close();
  }
  { // 4. spectator and the full-screen rally replay (measured only; the player is the replay-data lane's)
    const { ctx, page } = await open("viewer", false);
    await page.waitForSelector(".pscore, .tv-score");
    await screen(page, "관전 경기");
    const play = page.locator('[data-act="clip-play"]').first();
    if (await play.count()) {
      await play.click();
      await page.waitForSelector(".replay-full");
      await screen(page, "관전 다시 보기");
    } else check("관전 다시 보기 버튼 있음", false);
    await ctx.close();
  }
  if (args.camera !== "0") { // 5. camera: start, calibration (taps and a marker drag), running
    const { ctx, page } = await open("camera", true);
    await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
    await screen(page, "카메라 시작화면");
    await page.getByRole("button", { name: /카메라 시작/ }).click();
    await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
    const s = await page.evaluate(() => ({ mode: window.__ppv.state.mode, w: window.__ppv.state.video?.width, h: window.__ppv.state.video?.height }));
    check("카메라 보정 화면 열림", s.mode === "calibrating", s);
    if (s.mode === "calibrating") {
      const corners = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];
      for (const c of corners) {
        const pt = await page.evaluate(([x, y]) => {
          const v = document.querySelector("video");
          const r = v.getBoundingClientRect();
          const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
          return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
        }, [c.x * (s.w / 1920), c.y * (s.h / 1080)]);
        await page.mouse.click(pt.x, pt.y);
      }
      await screen(page, "카메라 보정", { tap: false });
      const kept = await page.evaluate(() => ({ calib: getComputedStyle(document.querySelector(".calib")).touchAction, pt: [...document.querySelectorAll(".calib__pt")].map((e) => getComputedStyle(e).touchAction) }));
      check("보정 층과 모서리 표시는 none 그대로", kept.calib === "none" && kept.pt.length === 4 && kept.pt.every((v) => v === "none"), kept);
      const m = page.locator(".calib__pt").nth(1);
      const a = await m.boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + i * 5, a.y + a.height / 2 + i * 3);
      await page.mouse.up();
      const b = await m.boundingBox();
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      check("보정 모서리 끌기 그대로 (40px 끌면 따라옴)", moved > 30 && (await page.locator(".calib__pt").count()) === 4, { moved: Math.round(moved) });
      await page.getByRole("button", { name: /확인/ }).click();
      await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 }).catch(() => {});
      await screen(page, "카메라 촬영중", { tap: false });
      await page.getByRole("button", { name: /^설정/ }).click();
      await screen(page, "카메라 설정", { tap: false });
    }
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/${engine}-touch.json`, JSON.stringify({ rows, fails }, null, 2));
console.log(`NO_DBLTAP_ZOOM engine=${engine} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
