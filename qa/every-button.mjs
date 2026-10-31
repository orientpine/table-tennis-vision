// Press every button and link on every screen of the one app, as each mode sees it, and record what
// happened (WebKit, isolated data, fake camera). Each press starts from the same screen; a press
// that wrote to the tournament puts the data back to the seed before the next one.
//   bun qa/every-button.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--devices=phone,tv]
//     [--screens=<comma list of names>] [--out=evidence/r8/buttons] [--port=8980]
// Outcome per press:
//   바뀜      the screen, address, a dialog, a toggle, the video or the server changed
//   열림      a file chooser or a native dialog opened
//   이미 선택됨 the control was already the current one (current tab, chosen mode, pressed toggle)
//   비활성    disabled on purpose (shown, not pressable)
//   아무 일 없음  nothing changed  -> FAIL
//   갇힘      the new screen has no way back (no back button, no close)  -> FAIL
//   오류      a page error during the press  -> FAIL
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r8/buttons";
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 8980) });
// --engine=chromium presses the same controls in Chromium (to tell a WebKit-only stall from an app fault)
const launch = () => (args.engine === "chromium" ? chromium.launch() : webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}));
let browser = await launch();
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish in ${ms / 1000} s`)), ms))]);

const tab = (label) => async (page) => { await page.locator("nav.nav button", { hasText: label }).click(); await page.waitForTimeout(300); };
const camera = async (page) => { await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 }); await startCamera(page); };
// Screens: [name, role, holds PIN, query, steps to reach it from "/"]
const SCREENS = [
  ["시작 화면", null, false, "?start", []],
  ["모드 고르기", null, false, "?role", []],
  ["관전 경기", "viewer", false, "", []],
  ["관전 대진", "viewer", false, "", [tab("대진")]],
  ["관전 순위", "viewer", false, "", [tab("순위")]],
  ["관전 기록", "viewer", false, "", [tab("기록")]],
  ["관전 지난 대회", "viewer", false, "", [tab("기록"), async (p) => { await p.locator('[data-act="hist-open"]', { hasText: "지난 대회" }).click(); await p.locator('.hist-bar').waitFor({ state: "attached", timeout: 10000 }); }]],
  ["관전 설정", "viewer", false, "", [tab("설정")]],
  ["PIN 입력", "referee", false, "", [async (p) => { await p.locator('[data-act="pin"]').first().click(); await p.waitForSelector("#pin-input"); }]],
  ["심판 경기", "referee", true, "", []],
  ["심판 대진", "referee", true, "", [tab("대진")]],
  ["심판 순위", "referee", true, "", [tab("순위")]],
  ["심판 기록", "referee", true, "", [tab("기록")]],
  ["심판 설정", "referee", true, "", [tab("설정")]],
  ["새 대회", "referee", true, "", [tab("설정"), async (p) => { await p.locator('[data-act="setup-new"]').click(); await p.locator('dialog [data-ask="1"]').click(); await p.waitForSelector('[data-act="setup-submit"]'); for (const [i, n] of ["가나", "다라", "마바", "사아"].entries()) await p.locator(`[data-draft="p${i}"]`).fill(n); await p.evaluate(() => document.activeElement.blur()); await p.waitForTimeout(100); }]],
  ["심판 모드", "referee", true, "", [async (p) => { await p.locator('[data-act="ref-enter"]').first().click(); await p.waitForSelector(".ref"); }]],
  ["카메라 시작", "camera", true, "", [async (p) => p.waitForFunction(() => window.__ppv && window.__ppv.state.mode === "intro", null, { timeout: 20000 })]],
  ["카메라 시작 PIN 없음", "camera", false, "", [async (p) => p.waitForFunction(() => window.__ppv && window.__ppv.state.mode === "intro", null, { timeout: 20000 })]],
  ["카메라 촬영", "camera", true, "", [camera]],
  ["카메라 설정", "camera", true, "", [camera, async (p) => { await p.getByRole("button", { name: /^설정/ }).click(); await p.waitForSelector(".popover:not([hidden])"); }]],
  ["카메라 기록", "camera", true, "", [camera, async (p) => { await p.getByRole("button", { name: /^기록/ }).click(); await p.waitForSelector(".sheet:not([hidden])"); }]],
  ["카메라 점수 고치기", "camera", true, "", [camera, async (p) => { await p.locator(".chip--fix").click(); await p.waitForSelector(".fix:not([hidden])"); }]],
  ["카메라 코트 보정", "camera", true, "", [camera, async (p) => { await p.getByRole("button", { name: /코트 보정/ }).click(); await p.waitForFunction(() => window.__ppv.state.mode === "calibrating"); }]],
  ["카메라 나가기 확인", "camera", true, "", [camera, async (p) => { await p.locator(".strip [data-back]").click(); await p.waitForSelector(".leave:not([hidden])"); }]],
];
const only = args.screens ? new Set(args.screens.split(",")) : null;

let pageErrors = [];
async function openScreen(dev, [, role, pin, query, steps]) {
  const ctx = await browser.newContext(DEVICES[dev]);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  ctx.setDefaultTimeout(15000);
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  await ctx.addInitScript(([r, p]) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    localStorage.clear();
    if (r) localStorage.setItem("pp-role", r);
    if (p) localStorage.setItem("pp-pin", p);
    localStorage.setItem("pp-sound", "0");
    localStorage.setItem("pp-tab", "match");
  }, [role, pin ? app.pin : null]);
  // the system share sheet never returns in headless WebKit: record the call instead (iPhone opens the sheet)
  await ctx.addInitScript(() => { if (navigator.share) navigator.share = async (d) => { window.__qaShared = (window.__qaShared || 0) + 1; void d; }; });
  await ctx.addInitScript(() => document.addEventListener("seeked", () => { window.__qaSeeks = (window.__qaSeeks || 0) + 1; }, true));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(app.origin + "/" + query, { waitUntil: "load" });
  await page.waitForSelector(".pscore, .tv-score, .role-card, .app, .champ, .start-go", { timeout: 20000 });
  for (const s of steps) await s(page);
  await page.waitForTimeout(300);
  return { ctx, page };
}

// A WebKit tab that wedges while opening is a harness problem: one fresh try, after clean data.
// A wedged WPE stops answering even new contexts: on a timeout, a fresh browser and clean data.
async function reopen(dev, screen) {
  try {
    return await within(openScreen(dev, screen), 45000, "open");
  } catch (err) {
    console.log(`RETRY open ${dev} ${screen[0]}: ${String(err.message || err).split("\n")[0]}`);
    await within(browser.close(), 5000, "close").catch(() => {});
    browser = await launch();
    await app.reset();
    return within(openScreen(dev, screen), 60000, "open");
  }
}

const CONTROLS = "button, a[href], select, label.btn--file, [role=button]";
const listControls = (page) => page.evaluate((sel) => {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden]") && s.pointerEvents !== "none";
  };
  // what is on top: an open dialog or overlay owns the screen
  const top = document.querySelector("dialog[open]") || document.querySelector(".leave:not([hidden])") || document.querySelector(".sheet:not([hidden])");
  return [...document.querySelectorAll(sel)].filter((e) => vis(e) && (!top || top.contains(e) || (top.matches(".sheet") && e.closest(".strip")))).map((e, i) => (e.dataset.qaI = String(i), {
    i,
    label: (e.getAttribute("aria-label") || e.textContent || e.getAttribute("title") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 32),
    disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true",
    current: e.getAttribute("aria-current") === "page" || e.getAttribute("aria-pressed") === "true" || e.getAttribute("aria-checked") === "true" || (e.matches(".roles button, .role-card") && e.classList.contains("on")),
    tag: e.tagName.toLowerCase(),
  }));
}, CONTROLS);
const snap = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
  const v = [...document.querySelectorAll("video[data-clip-video], .tv-clip video")].find(vis);
  // A playing clip and the camera's running clock change by themselves: they are not a press's result.
  const live = window.__ppv ? [...document.querySelectorAll(".popover, .sheet, .fix, .leave, .bar, .pointbar, .calibbar, .screen")].filter(vis).map((e) => e.innerText).join("\n") : document.body.innerText;
  return JSON.stringify({
    text: live,
    inputs: [...document.querySelectorAll("input:not([type=file]), select")].map((e) => e.value).join("|"),
    url: location.href,
    hist: history.length,
    dialog: document.querySelectorAll("dialog[open]").length,
    overlays: [...document.querySelectorAll(".popover, .sheet, .fix, .leave, .sheet__foot")].map((e) => e.hidden).join(),
    states: [...document.querySelectorAll("[aria-pressed],[aria-expanded],[aria-checked]")].map((e) => (e.getAttribute("aria-pressed") || "") + (e.getAttribute("aria-expanded") || "") + (e.getAttribute("aria-checked") || "")).join(""),
    mode: window.__ppv ? window.__ppv.state.mode : null,
    video: v ? v.getAttribute("src") : null,
    seeks: window.__qaSeeks || 0,
    shared: window.__qaShared || 0,
    scroll: Math.round(scrollY),
    toast: document.getElementById("toast")?.className || "",
  });
});
const wayBack = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
  if ([...document.querySelectorAll("[data-back], .role-card")].some(vis)) return true;
  const top = document.querySelector("dialog[open]") || document.querySelector(".leave:not([hidden]), .popover:not([hidden]), .sheet:not([hidden])");
  return !!(top && [...top.querySelectorAll("button")].some(vis));
});

// WPE can leave a context's close() pending forever; never let that stall the run.
const closeCtx = (ctx) => Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);

const rows = [];
try {
  for (const dev of (args.devices || "phone,tv").split(",")) {
    for (const screen of SCREENS) {
      const [name, role] = screen;
      if (only && !only.has(name)) continue;
      if (dev === "tv" && role === "viewer" && name !== "관전 경기") continue; // a TV spectator has the scoreboard only (no tabs)
      let ctx, page;
      try {
        ({ ctx, page } = await reopen(dev, screen));
      } catch (err) {
        rows.push({ device: dev, screen: name, control: "(화면)", outcome: "오류", detail: `화면을 못 엶: ${String(err.message || err).split("\n")[0].slice(0, 80)}` });
        continue;
      }
      const controls = await within(listControls(page), 15000, "list");
      await within(page.screenshot({ path: `${out}/${dev}-${name}.png` }), 15000, "shot").catch(() => {});
      console.log(`SCREEN ${dev} ${name} controls=${controls.length}`);
      for (const c of controls) {
        const row = { device: dev, screen: name, control: c.label, outcome: "", detail: "" };
        if (c.disabled) { row.outcome = "비활성"; rows.push(row); continue; }
        if (!ctx) ({ ctx, page } = await reopen(dev, screen));
        // a page that stopped answering: a fresh browser, then this press again
        let now = await within(listControls(page), 15000, "list").catch(async () => {
          console.log(`RETRY wedged ${dev} ${name} [${c.label}]`);
          await within(browser.close(), 5000, "close").catch(() => {});
          browser = await launch();
          await app.reset();
          ({ ctx, page } = await reopen(dev, screen));
          return listControls(page);
        });
        let me = now.find((x) => x.i === c.i && x.label === c.label) || now.find((x) => x.label === c.label);
        if (!me) {
          await closeCtx(ctx);
          ({ ctx, page } = await reopen(dev, screen));
          now = await listControls(page);
          me = now.find((x) => x.i === c.i && x.label === c.label) || now.find((x) => x.label === c.label);
        }
        pageErrors = [];
        const posts = [];
        const onReq = (r) => { if (r.method() !== "GET" && r.url().includes("/api/")) posts.push(`${r.method()} ${new URL(r.url()).pathname}`); };
        page.on("request", onReq);
        let opened = "";
        const onChooser = () => { opened = "파일 고르기"; };
        const onDialog = (d) => { opened = `브라우저 창(${d.type()})`; d.dismiss().catch(() => {}); };
        page.on("filechooser", onChooser);
        page.on("dialog", onDialog);
        const before = await within(snap(page), 15000, "snap").catch(() => "");
        const h = me ? await page.$(`[data-qa-i="${me.i}"]`) : null;
        try {
          if (!h) throw new Error("사라짐");
          const press = (async () => {
            if (c.tag === "select") {
              const opts = await h.evaluate((s) => [...s.options].filter((o) => !o.disabled).map((o) => o.value));
              await h.selectOption(opts[opts.length - 1] ?? "");
            } else {
              await h.click({ timeout: 5000 });
            }
            await page.waitForTimeout(900);
          })();
          await Promise.race([press, new Promise((_, rej) => setTimeout(() => rej(new Error("press did not finish in 20 s")), 20000))]);
        } catch (err) {
          row.detail = String(err.message || err).split("\n")[0].slice(0, 80);
        }
        let after = "";
        let navigated = false;
        try { after = await Promise.race([snap(page), new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 15000))]); } catch (err) { navigated = !/hung/.test(String(err)); if (!navigated) pageErrors.push("page stopped answering after the press"); }
        if (!after) { await page.waitForLoadState("load").catch(() => {}); await page.waitForTimeout(800); after = await snap(page).catch(() => ""); navigated = true; }
        const back = await within(wayBack(page), 10000, "back").catch(() => false);
        if (pageErrors.length) { row.outcome = "오류"; row.detail = pageErrors.join(" | ").slice(0, 120); }
        else if (opened) row.outcome = "열림", row.detail = opened;
        else if (after && JSON.parse(after).shared > (before ? JSON.parse(before).shared : 0)) row.outcome = "열림", row.detail = "공유 창";
        else if (c.current && after === before && !posts.length) row.outcome = "이미 선택됨";
        else if (navigated || after !== before || posts.length) {
          row.outcome = back ? "바뀜" : "갇힘";
          const a = after ? JSON.parse(after) : {};
          const b = before ? JSON.parse(before) : {};
          row.detail = [posts.join(","), a.url !== b.url ? `주소 ${new URL(a.url || "http://x/").pathname}${new URL(a.url || "http://x/").search}` : "", a.mode !== b.mode ? `카메라 ${b.mode}→${a.mode}` : "", a.dialog !== b.dialog ? "창" : "", a.video !== b.video || a.seeks !== b.seeks ? "영상" : "", a.toast !== b.toast && /show/.test(a.toast || "") ? "알림" : ""].filter(Boolean).join(" ") || row.detail || "화면 바뀜";
        } else row.outcome = "아무 일 없음";
        page.off("request", onReq);
        page.off("filechooser", onChooser);
        page.off("dialog", onDialog);
        rows.push(row);
        console.log(`PRESS ${dev} ${name} [${c.label}] ${row.outcome} ${row.detail}`);
        // next press starts from the same screen: reopen when anything changed, reset data after writes
        if (row.outcome !== "아무 일 없음" && row.outcome !== "이미 선택됨") {
          await closeCtx(ctx);
          ctx = null;
          if (posts.length) await app.reset();
        }
      }
      if (ctx) await closeCtx(ctx);
    }
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}

const bad = rows.filter((r) => ["아무 일 없음", "갇힘", "오류"].includes(r.outcome));
const count = (o) => rows.filter((r) => r.outcome === o).length;
const lines = [
  "# 모든 버튼 누르기", "",
  `눌러 본 것 ${rows.length}개 · 바뀜 ${count("바뀜")} · 열림 ${count("열림")} · 이미 선택됨 ${count("이미 선택됨")} · 비활성 ${count("비활성")} · **아무 일 없음 ${count("아무 일 없음")} · 갇힘 ${count("갇힘")} · 오류 ${count("오류")}**`, "",
  "| 기기 | 화면 | 버튼 | 결과 | 무엇이 |", "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.device} | ${r.screen} | ${r.control.replace(/\|/g, "/")} | ${r.outcome} | ${String(r.detail).replace(/\|/g, "/")} |`),
];
writeFileSync(`${out}/buttons.json`, JSON.stringify(rows, null, 2));
writeFileSync(`${out}/buttons.md`, lines.join("\n") + "\n");
console.log(`BUTTONS_DONE presses=${rows.length} noop=${count("아무 일 없음")} trapped=${count("갇힘")} errors=${count("오류")}`);
process.exit(bad.length ? 1 : 0);
