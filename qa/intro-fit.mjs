// The camera start screen (intro) fits on TV 1920, phone 393 and phone 360: the title's lines do not
// sit on each other, no two blocks of the screen overlap, nothing is wider than the screen, and the
// PC 저장 PIN field is wide enough to show its whole placeholder. Seen on a device without the PIN
// (the field shows) and on one with it (tournament linked, PC 저장 on). Lead 2026-10-31: on TV the
// title's two lines overlapped and the PIN field was cut to "대회".
//   bun qa/intro-fit.mjs --engine=chromium|webkit --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9790]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { DEVICES, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const engine = args.engine || "chromium";
const out = `${args.out}/${engine}`;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9790) });
const browser = engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch();
const fails = [];
let passes = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${engine} ${name} ${JSON.stringify(detail)}`); if (ok) passes++; else fails.push(name); };
const VIEWS = {
  tv: DEVICES.tv,
  p393: DEVICES.phone,
  p360: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const measure = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden]"); };
  const intro = document.querySelector(".screen--intro .screen__inner");
  // title: the text's line boxes, top to bottom; a line that starts above the previous one's bottom overlaps it
  const title = intro.querySelector(".screen__title");
  const range = document.createRange();
  range.selectNodeContents(title);
  const lines = [];
  for (const r of range.getClientRects()) {
    const same = lines.find((l) => Math.abs(l.top - r.top) < 2);
    if (same) { same.bottom = Math.max(same.bottom, r.bottom); continue; }
    lines.push({ top: r.top, bottom: r.bottom });
  }
  lines.sort((a, b) => a.top - b.top);
  const titleOverlap = lines.slice(1).map((l, i) => Math.round((lines[i].bottom - l.top) * 10) / 10).filter((d) => d > 0.5);
  // blocks of the screen (role row, brand, title, list, PC 저장 box, buttons, note) never cross
  const blocks = [...intro.children].filter(vis).map((e) => ({ cls: e.className || e.tagName, r: e.getBoundingClientRect() }));
  const blockOverlap = [];
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i].r, b = blocks[j].r;
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (x > 0.5 && y > 0.5) blockOverlap.push(`${blocks[i].cls} x ${blocks[j].cls}`);
  }
  // the PIN field shows its whole placeholder
  const field = [...intro.querySelectorAll("input")].find((i) => vis(i) && /PIN/.test(i.placeholder));
  let pin = null;
  if (field) {
    const s = getComputedStyle(field);
    const g = document.createElement("canvas").getContext("2d");
    g.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const need = Math.ceil(g.measureText(field.placeholder).width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight));
    pin = { width: Math.round(field.clientWidth), need };
  }
  return { lines: lines.length, titleOverlap, blockOverlap, pin, scroll: document.documentElement.scrollWidth, inner: innerWidth };
};

try {
  for (const [name, view] of Object.entries(VIEWS)) {
    for (const withPin of [false, true]) {
      const ctx = await browser.newContext(view);
      await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
      await ctx.addInitScript((p) => {
        if (location.origin === "null" || sessionStorage.getItem("__preset")) return;
        sessionStorage.setItem("__preset", "1");
        sessionStorage.setItem("pp-started", "1");
        localStorage.clear();
        localStorage.setItem("pp-role", "camera");
        localStorage.setItem("pp-sound", "0");
        if (p) localStorage.setItem("pp-pin", p);
      }, withPin ? app.pin : null);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message || e)));
      await page.goto(app.origin + "/", { waitUntil: "load" });
      await page.waitForFunction(() => window.__ppv && window.__ppv.state.mode === "intro", null, { timeout: 20000 });
      await page.evaluate(() => document.fonts.ready);
      // the state this device settles in: the PIN field (no PIN) or PC 저장 on (PIN)
      await page.waitForFunction((p) => {
        const t = document.body.innerText;
        return p ? t.includes("PC 저장: 켜짐") : [...document.querySelectorAll(".screen--intro input")].some((i) => /PIN/.test(i.placeholder) && i.getBoundingClientRect().width > 0);
      }, withPin, { timeout: 20000 }).catch(() => {});
      const m = await page.evaluate(measure);
      const tag = `${name}-${withPin ? "pin" : "nopin"}`;
      await page.screenshot({ path: `${out}/${tag}.png` });
      check(`${tag}: the title's lines do not overlap`, m.titleOverlap.length === 0, { lines: m.lines, overlap: m.titleOverlap });
      check(`${tag}: no two blocks of the start screen overlap`, m.blockOverlap.length === 0, m.blockOverlap);
      check(`${tag}: nothing is wider than the screen`, m.scroll <= m.inner, { scroll: m.scroll, inner: m.inner });
      if (!withPin) check(`${tag}: the PC 저장 PIN field shows its whole placeholder`, !!m.pin && m.pin.width >= m.pin.need, m.pin);
      check(`${tag}: no page errors`, errors.length === 0, errors);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await app.stop?.();
}
console.log(`INTRO_FIT_DONE engine=${engine} pass=${passes} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
