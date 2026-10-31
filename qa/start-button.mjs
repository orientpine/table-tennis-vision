// The start screen's START button in Chromium with the real pixel font: on each screen size the
// button and its drawn word stay inside the screen and inside each other, the button is at least 44 px,
// its name still says what it does, it has visible thickness that shrinks while pressed without the
// tap target moving, a keyboard focus lights it, and a press sinks before the mode picker opens.
//   bun qa/start-button.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9660]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const VIEWS = { phone: DEVICES.phone, p360: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, land: DEVICES.land, pad: DEVICES.pad, tv: DEVICES.tv };
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9660) });
const browser = await chromium.launch();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); if (!ok) fails.push(name); };
const measure = (page) => page.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const btn = document.querySelector(".start-go"), face = btn.querySelector(".start-face"), word = btn.querySelector(".start-word");
  let ink = 0;
  if (word) { const c = word.getContext("2d").getImageData(0, 0, word.width, word.height).data; for (let i = 3; i < c.length; i += 4) if (c[i]) ink++; }
  const f = face ? getComputedStyle(face) : null;
  return { btn: box(btn), face: box(face), word: box(word), ink, vw: innerWidth, vh: innerHeight, text: btn.textContent.trim(), outline: f ? parseFloat(f.outlineWidth) * (f.outlineStyle === "none" ? 0 : 1) : 0, filter: f?.filter, scroll: document.documentElement.scrollWidth > innerWidth };
});
const round = (m) => JSON.parse(JSON.stringify(m, (k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));
try {
  for (const [name, view] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext(view);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(app.origin + "/?start", { waitUntil: "load" });
    await page.waitForSelector(".start-go");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const rest = await measure(page);
    await page.screenshot({ path: `${out}/${name}-rest.png` });
    const named = await page.getByRole("button", { name: "시작하기(START)" }).count();
    check(`${name}: screen readers hear 시작하기(START)`, named === 1, { named });
    check(`${name}: the button is drawn START, not 시작하기`, !rest.text.includes("시작하기") && rest.ink > 0, { text: rest.text, ink: rest.ink });
    const B = rest.btn, F = rest.face, W = rest.word;
    check(`${name}: at least 44 px and inside the screen`, B.h >= 44 && B.w >= 44 && B.l >= 0 && B.t >= 0 && B.r <= rest.vw && B.b <= rest.vh && !rest.scroll, round(B));
    check(`${name}: word inside the face, 2 px clear`, !!F && !!W && W.l - F.l >= 2 && F.r - W.r >= 2 && W.t - F.t >= 2 && F.b - W.b >= 2, round({ F, W }));
    const thick = (m) => (m.face ? Math.min(m.btn.r - m.face.r, m.btn.b - m.face.b) : 0);
    check(`${name}: visible thickness`, thick(rest) >= 5, { thick: thick(rest) });
    const cx = (B.l + B.r) / 2, cy = (B.t + B.b) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(80);
    const down = await measure(page);
    await page.screenshot({ path: `${out}/${name}-pressed.png` });
    await page.mouse.move(0, 0);
    await page.mouse.up();
    check(`${name}: a press sinks and thins, tap box unmoved`, thick(down) <= thick(rest) / 2 && thick(rest) > 0 && down.btn.l === B.l && down.btn.t === B.t && down.btn.w === B.w && down.btn.h === B.h, { rest: thick(rest), down: thick(down) });
    await page.locator(".start-go").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    const foc = await measure(page);
    await page.screenshot({ path: `${out}/${name}-focus.png` });
    check(`${name}: keyboard focus lights the button`, foc.outline >= 3 && foc.filter !== rest.filter, { outline: foc.outline, filter: foc.filter });
    await page.evaluate(() => { const b = document.querySelector(".start-go"); window.__sunk = false; new MutationObserver(() => { if (b.classList.contains("pressed")) window.__sunk = true; }).observe(b, { attributes: true }); });
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".role-card", { timeout: 3000 }).catch(() => {});
    const ms = Date.now() - t0;
    const sunk = await page.evaluate(() => window.__sunk);
    check(`${name}: Enter sinks, then the mode picker opens`, sunk && (await page.locator(".role-card").count()) > 0 && ms < 1500, { sunk, ms });
    check(`${name}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
  { // Touch: a quick tap must still show the press.
    const ctx = await browser.newContext(VIEWS.phone);
    const page = await ctx.newPage();
    await page.goto(app.origin + "/?start", { waitUntil: "load" });
    await page.waitForSelector(".start-go");
    await page.evaluate(() => { const b = document.querySelector(".start-go"); window.__sunk = false; new MutationObserver(() => { if (b.classList.contains("pressed")) window.__sunk = true; }).observe(b, { attributes: true }); });
    await page.locator(".start-go").tap();
    await page.waitForSelector(".role-card", { timeout: 3000 }).catch(() => {});
    check("phone: a quick tap sinks, then the mode picker opens", await page.evaluate(() => window.__sunk) && (await page.locator(".role-card").count()) > 0, {});
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop?.();
}
console.log(`START_BUTTON_DONE fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
