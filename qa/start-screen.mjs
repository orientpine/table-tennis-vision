// The start screen (WebKit, isolated servers): four viewports with animation running and with reduced
// motion, then the visit flow and the taps a remembered mode costs.
//   bun qa/start-screen.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9620]
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9620) });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`); if (!ok) fails.push(name); };
const measure = (page) => page.evaluate(() => {
  const inside = (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
  const btn = document.querySelector(".start-go").getBoundingClientRect();
  // The title's lines, not its box: the dark glow canvas bleeds past the box on purpose.
  const parts = [...document.querySelectorAll(".ln, .start-rally, .start-press, .start-go")];
  return { back: document.querySelectorAll("[data-back]").length, outside: parts.filter((e) => !inside(e)).length, btnH: Math.round(btn.height), btnW: Math.round(btn.width), scroll: document.documentElement.scrollHeight > innerHeight + 1, clipped: parts.filter((e) => e.scrollWidth > e.clientWidth + 1).length, font: getComputedStyle(document.querySelector(".start-logo")).fontFamily.split(",")[0] };
});
const pixels = (page) => page.evaluate(() => { const c = document.querySelector(".start-rally"); return c.toDataURL(); });
try {
  for (const [dev, device] of Object.entries(DEVICES)) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const ctx = await browser.newContext({ ...device, reducedMotion });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(app.origin + "/");
      await page.waitForSelector(".start-go");
      // Layout is measured once the one-time title entrance has landed (the letters start scaled up).
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished)));
      const m = await measure(page);
      const a = await pixels(page);
      await page.waitForFunction((was) => document.querySelector(".start-rally").toDataURL() !== was, a, { timeout: 2500 }).catch(() => {});
      const moved = (await pixels(page)) !== a;
      const label = `${dev}/${reducedMotion}`;
      check(`${label} layout`, m.back === 0 && m.outside === 0 && !m.scroll && m.clipped === 0 && m.btnH >= 44 && /Galmuri/.test(m.font) && !errors.length, { ...m, errors });
      check(`${label} animation`, moved === (reducedMotion === "no-preference"), { moved });
      await page.screenshot({ path: `${out}/${dev}-${reducedMotion}.png` });
      await ctx.close();
    }
  }
  const ctx = await browser.newContext(DEVICES.phone);
  await ctx.addInitScript(() => localStorage.setItem("pp-role", "viewer"));
  const page = await ctx.newPage();
  await page.goto("about:blank");
  await page.goto(app.origin + "/");
  await page.locator(".start-go").click();
  await page.waitForSelector(".role-card");
  check("picker has no back", (await page.locator("[data-back]").count()) === 0);
  // owner, 2026-10-31: a remembered mode is not painted in advance; a card takes its colour only while held.
  check("remembered mode is not painted", (await page.locator(".role-card.on, .role-card.pressed").count()) === 0 && (await page.locator(".role-card").count()) === 3);
  await page.screenshot({ path: `${out}/picker-remembered.png` });
  await page.locator('.role-card[data-role="viewer"]').click();
  await page.waitForSelector(".pscore");
  const tapsNew = 2;
  await page.reload();
  await page.waitForSelector(".pscore", { timeout: 10000 });
  check("reload in a visit resumes the mode with 0 taps", (await page.locator(".start-go").count()) === 0);
  await page.locator('[data-act="back"]:visible').first().click();
  await page.waitForSelector(".role-card");
  await page.goBack();
  await page.waitForSelector(".start-go", { timeout: 5000 }).catch(() => {});
  check("browser back: picker -> start", (await page.locator(".start-go").count()) === 1);
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector(".start-go"), null, { timeout: 5000 }).catch(() => {});
  check("browser back: start -> out of the app", !page.url().startsWith(app.origin), { url: page.url() });
  writeFileSync(`${out}/taps.json`, JSON.stringify({ tapsRememberedNewVisit: tapsNew, tapsReload: 0 }, null, 2));
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
console.log(`START_SCREEN_DONE fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
