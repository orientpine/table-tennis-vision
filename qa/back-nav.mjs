// The way back, on every kind of screen, by the top-left button AND by the browser's back (WebKit,
// iPhone size, fake camera, isolated data). Each scenario is one PASS/FAIL line with what it saw.
//   bun qa/back-nav.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--out=evidence/r8/back] [--port=8970]
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r8/back";
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 8970) });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const results = [];
const errors = [];

async function open(role, { pin = false, query = "", device = "phone" } = {}) {
  const ctx = await browser.newContext(DEVICES[device]);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  await ctx.addInitScript(([r, p]) => {
    if (location.origin === "null") return;
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    if (r) localStorage.setItem("pp-role", r);
    if (p) localStorage.setItem("pp-pin", p);
  }, [role, pin ? app.pin : null]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${role}: ${e.stack || e.message}`));
  await page.goto(app.origin + "/" + query, { waitUntil: "load" });
  return { ctx, page };
}
// What the person sees: the visible screen name, the address, the camera mode if any.
const where = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
  return {
    name: [...document.querySelectorAll("[data-screen-name]")].filter(vis)[0]?.textContent.trim() || null,
    path: location.pathname + location.search,
    camera: window.__ppv ? window.__ppv.state.mode : null,
    leaveAsk: !!document.querySelector(".leave:not([hidden])"),
    back: [...document.querySelectorAll("[data-back]")].filter(vis).length > 0,
    tracksStopped: Number(sessionStorage.getItem("__tracksStopped") || 0),
    tracksOpened: Number(sessionStorage.getItem("__tracksOpened") || 0),
  };
});
const back = (page) => page.locator("[data-back]:visible").first().click();
const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail, s: (Date.now() - t0) / 1000 });
    console.log(`PASS ${name} ${JSON.stringify(detail)}`);
  } catch (err) {
    results.push({ name, pass: false, detail: String(err.message || err).split("\n")[0], s: (Date.now() - t0) / 1000 });
    console.log(`FAIL ${name} ${String(err.message || err).split("\n")[0]}`);
  }
}
const expect = (cond, what, seen) => { if (!cond) throw new Error(`${what}: ${JSON.stringify(seen)}`); };

try {
  for (const via of ["button", "browser"]) {
    const goBack = (page) => (via === "button" ? back(page) : page.goBack().catch(() => {}));

    await scenario(`${via}: 심판 경기 → 대진 → 순위 → 뒤로 두 번 = 대진, 경기`, async () => {
      const { ctx, page } = await open("referee", { pin: true });
      await page.waitForSelector(".pscore");
      await page.locator("nav.nav button", { hasText: "대진" }).click();
      await page.locator("nav.nav button", { hasText: "순위" }).click();
      await settle(page, 300);
      await goBack(page); await settle(page);
      const a = await where(page);
      await goBack(page); await settle(page);
      const b = await where(page);
      await ctx.close();
      expect(a.name === "대진" && b.name === "경기", "names", [a.name, b.name]);
      return [a.name, b.name];
    });

    await scenario(`${via}: 심판 모드 → 뒤로 = 경기`, async () => {
      const { ctx, page } = await open("referee", { pin: true });
      await page.waitForSelector(".pscore");
      await page.locator('[data-act="ref-enter"]').first().click();
      await page.waitForSelector(".ref");
      await goBack(page); await settle(page);
      const a = await where(page);
      const stillRef = await page.locator(".ref").count();
      await ctx.close();
      expect(a.name === "경기" && !stillRef, "after", a);
      return a.name;
    });

    await scenario(`${via}: 기록 → 지난 대회 → 뒤로 = 기록 목록`, async () => {
      const { ctx, page } = await open("viewer");
      await page.waitForSelector(".pscore, .tv-score");
      await page.locator("nav.nav button", { hasText: "기록" }).click();
      await page.locator('[data-act="hist-open"]', { hasText: "지난 대회" }).click();
      await page.locator('.hist-bar').waitFor({ state: "attached", timeout: 10000 });
      const inside = await where(page);
      await goBack(page); await settle(page);
      const a = await where(page);
      const list = await page.locator('[data-act="hist-open"]').count();
      await ctx.close();
      expect(inside.name === "대회 기록" && a.name === "기록" && list >= 2, "after", [inside.name, a.name, list]);
      return [inside.name, a.name];
    });

    await scenario(`${via}: 설정 → 새 대회 → 뒤로 = 설정 (기록 그대로)`, async () => {
      const { ctx, page } = await open("referee", { pin: true });
      await page.waitForSelector(".pscore");
      const rev0 = (await app.api("/api/state")).rev;
      await page.locator("nav.nav button", { hasText: "설정" }).click();
      await page.locator('[data-act="setup-new"]').click();
      await page.locator('dialog [data-ask="1"]').click();
      await page.waitForSelector('[data-act="setup-submit"]');
      await goBack(page); await settle(page);
      const a = await where(page);
      const rev = (await app.api("/api/state")).rev;
      await ctx.close();
      expect(a.name === "설정" && rev === rev0, "after", [a.name, rev, rev0]);
      return [a.name, rev];
    });

    await scenario(`${via}: 대진 → 순위 → 뒤로 세 번 = 모드 고르기, 뒤로 버튼 없고 브라우저 뒤로 = 앱 밖`, async () => {
      const { ctx, page } = await open("referee");
      await page.locator("nav.nav button", { hasText: "대진" }).click();
      await page.locator("nav.nav button", { hasText: "순위" }).click();
      await goBack(page);
      await page.locator('nav.nav button[aria-current="page"][data-tab="bracket"]').waitFor({ timeout: 8000 });
      await goBack(page);
      await page.locator('nav.nav button[aria-current="page"][data-tab="match"]').waitFor({ timeout: 8000 });
      await goBack(page);
      await page.waitForSelector(".role-card", { timeout: 8000 });
      await settle(page);
      const a = await where(page);
      const backs = await page.locator("[data-back]:visible").count();
      const url = page.url();
      if (via === "browser") {
        await page.goBack().catch(() => {});
        await settle(page);
        const still = page.url();
        const cards = await page.locator(".role-card").count();
        const inApp = still.startsWith(url.split("?")[0]) && !cards;
        await ctx.close();
        expect(a.name === "모드 고르기" && backs === 0 && !inApp, "after", { a, backs, still, cards });
        return { still };
      }
      await ctx.close();
      expect(a.name === "모드 고르기" && backs === 0, "after", { a, backs });
      return a.name;
    });

    await scenario(`${via}: 관전 TV 점수판 → 뒤로 = 모드 고르기, 뒤로 없음 → 관전 고르면 점수판`, async () => {
      const { ctx, page } = await open("viewer", { device: "tv" });
      await page.waitForSelector(".tv-score");
      await page.locator(".tv-role").click();
      await goBack(page); await settle(page);
      const a = await where(page);
      const backs = await page.locator("[data-back]:visible").count();
      await page.locator('.role-card[data-role="viewer"]').click();
      await settle(page);
      const b = await where(page);
      const board = await page.locator(".tv-score").count();
      await ctx.close();
      expect(a.name === "모드 고르기" && backs === 0 && b.name === "점수판" && board === 2, "after", [a.name, b.name, board, backs]);
      return [a.name, b.name];
    });

    await scenario(`${via}: 카메라 시작 화면(찍기 전) → 뒤로 = 모드 고르기, 확인 없이`, async () => {
      // a device that holds the PIN (without it 카메라 asks for the PIN first: qa/camera-pin.mjs)
      const { ctx, page } = await open(null, { pin: true, query: "?role" });
      await page.locator('.role-card[data-role="camera"]').click();
      await page.waitForFunction(() => window.__ppv && window.__ppv.state.mode === "intro", null, { timeout: 20000 });
      await page.locator(".screen--intro [data-back]").click({ trial: true });
      await goBack(page);
      await page.waitForSelector(".role-card", { timeout: 15000 });
      const a = await where(page);
      await ctx.close();
      expect(a.name === "모드 고르기" && !a.camera, "after", a);
      return a;
    });

    await scenario(`${via}: 카메라 찍는 중 → 뒤로 = 한 번 묻고, 계속 찍기 = 그대로 찍음`, async () => {
      const { ctx, page } = await open("camera", { pin: true });
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await settle(page, 600);
      await goBack(page); await settle(page);
      const asked = await where(page);
      await page.getByRole("button", { name: "계속 찍기" }).click();
      await settle(page, 1200);
      const after = await where(page);
      const live = await page.evaluate(() => (window.__camTracks || []).every((t) => t.readyState === "live"));
      await page.screenshot({ path: `${out}/${via}-camera-kept.png` });
      await ctx.close();
      expect(asked.leaveAsk && asked.camera === "running" && !after.leaveAsk && after.camera === "running" && live, "after", { asked, after, live });
      return { asked: asked.leaveAsk, mode: after.camera, live };
    });

    await scenario(`${via}: 카메라 찍는 중 → 뒤로 → 멈추고 나가기 = 카메라 꺼지고 모드 고르기`, async () => {
      const { ctx, page } = await open("camera", { pin: true });
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await settle(page, 600);
      await goBack(page); await settle(page);
      await page.screenshot({ path: `${out}/${via}-camera-ask.png` });
      const asked = await where(page);
      await page.getByRole("button", { name: "멈추고 나가기" }).click();
      await page.waitForSelector(".role-card", { timeout: 20000 });
      const a = await where(page);
      await page.screenshot({ path: `${out}/${via}-camera-left.png` });
      // the browser's back from here goes to the mode choice again, never straight into the camera
      await page.goBack().catch(() => {});
      await settle(page, 1500);
      const b = await where(page);
      await ctx.close();
      expect(asked.leaveAsk && a.name === "모드 고르기" && a.tracksStopped >= a.tracksOpened && a.tracksOpened > 0 && !b.camera, "after", { asked: asked.leaveAsk, a, b });
      return { opened: a.tracksOpened, stopped: a.tracksStopped, then: b.name || b.path };
    });

    await scenario(`${via}: 카메라 정지 상태 → 뒤로 = 묻지 않고 나감`, async () => {
      const { ctx, page } = await open("camera", { pin: true });
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await page.getByRole("button", { name: /정지/ }).click();
      await page.waitForFunction(() => window.__ppv.state.mode === "stopped");
      await goBack(page);
      await page.waitForSelector(".role-card", { timeout: 20000 });
      const a = await where(page);
      await ctx.close();
      expect(a.name === "모드 고르기" && a.tracksStopped >= a.tracksOpened, "after", a);
      return a.name;
    });

    await scenario(`${via}: 카메라 설정 열림 → 뒤로 = 설정만 닫힘`, async () => {
      const { ctx, page } = await open("camera", { pin: true });
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await page.getByRole("button", { name: /^설정/ }).click();
      await page.waitForSelector(".popover:not([hidden])");
      await goBack(page); await settle(page);
      const open1 = await page.locator(".popover:not([hidden])").count();
      const a = await where(page);
      await ctx.close();
      expect(!open1 && a.camera === "running" && !a.leaveAsk, "after", { open1, a });
      return a.camera;
    });

    for (const panel of ["history", "fix"]) {
      await scenario(`${via}: camera ${panel} → back closes only that panel`, async () => {
        const { ctx, page } = await open("camera", { pin: true });
        await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
        await startCamera(page);
        const selector = panel === "history" ? ".sheet" : ".fix";
        const opener = panel === "history" ? page.locator(".bar button").nth(3) : page.locator(".chip--fix");
        await opener.click();
        await page.locator(`${selector}:not([hidden])`).waitFor({ timeout: 10000 });
        expect(await opener.isDisabled(), "opener stays disabled", panel);
        await goBack(page);
        await page.locator(selector).waitFor({ state: "hidden", timeout: 10000 });
        const after = await where(page);
        await ctx.close();
        expect(after.camera === "running" && !after.leaveAsk, "after", after);
        return { panel, camera: after.camera };
      });
    }

    await scenario(`${via}: 코트 보정 중 → 뒤로 = 보정 취소, 카메라 그대로`, async () => {
      const { ctx, page } = await open("camera", { pin: true });
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await page.getByRole("button", { name: /코트 보정/ }).click();
      await page.waitForFunction(() => window.__ppv.state.mode === "calibrating");
      const during = await where(page);
      await goBack(page); await settle(page);
      const a = await where(page);
      await ctx.close();
      expect(during.back && during.name === "코트 보정" && a.camera === "running", "after", { during, a });
      return [during.name, a.camera];
    });
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/back-nav.json`, JSON.stringify({ results, errors }, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`BACKNAV_DONE pass=${results.length - failed} fail=${failed} pageErrors=${errors.length}`);
process.exit(failed || errors.length ? 1 : 0);
