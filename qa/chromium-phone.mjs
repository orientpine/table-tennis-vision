// Android and desktop Chrome are Chromium: every main screen at phone widths with mobile emulation
// (isolated servers). A page wider than the screen zooms the layout out on a phone and pushes the
// fixed bottom menu off the visible area, so width and a real tap on each tab are both checked.
//   bun qa/chromium-phone.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9820]
import { chromium, devices } from "playwright";
import { startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9820) });
const browser = await chromium.launch(process.env.PPV_CHROMIUM ? { executablePath: process.env.PPV_CHROMIUM } : {});
const fails = [];
let checks = 0;
const check = (name, ok, detail) => { checks++; if (!ok) { fails.push(name); console.log(`FAIL ${name} ${JSON.stringify(detail)}`); } };
const width = (page) => page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth, visual: Math.round(visualViewport.width) }));
try {
  for (const [w, h] of [[360, 640], [393, 659], [412, 915]]) {
    for (const [role, pin] of [["referee", true], ["referee", false], ["viewer", false]]) {
      const ctx = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await ctx.addInitScript(([r, p]) => {
        if (location.origin === "null") return;
        sessionStorage.setItem("pp-started", "1");
        localStorage.setItem("pp-role", r);
        localStorage.setItem("pp-sound", "0");
        if (p) localStorage.setItem("pp-pin", p);
        navigator.share = () => Promise.resolve(); // iPhone has it, so 공유하기 sits beside 링크 복사
      }, [role, pin ? app.pin : null]);
      const page = await ctx.newPage();
      await page.goto(app.origin + "/", { waitUntil: "load" });
      await page.waitForSelector("nav.nav button", { timeout: 15000 });
      for (const tab of ["경기", "대진", "순위", "기록", "설정"]) {
        const label = `${w}x${h}/${role}${pin ? "+pin" : ""}/${tab}`;
        await page.locator("nav.nav button", { hasText: tab }).click({ timeout: 6000 }).catch((e) => check(`${label} tap`, false, String(e.message).split("\n")[0]));
        await page.waitForFunction((t) => document.querySelector("nav.nav button.on")?.textContent.includes(t), tab, { timeout: 3000 }).catch(() => check(`${label} opened`, false, {}));
        const m = await width(page);
        check(`${label} width`, m.inner === m.visual && m.scroll <= m.inner, m);
        if (tab === "설정" && role === "referee") {
          const gap = await page.evaluate(() => { const i = document.querySelector("#pin-input").getBoundingClientRect(); const b = document.querySelector('[data-form="pin"] button').getBoundingClientRect(); return Math.max(b.left - i.right, b.top - i.bottom); });
          check(`${label} PIN 칸과 저장 버튼 12px 이상`, gap >= 12, { gap });
        }
      }
      await ctx.close();
    }
  }
  const ctx = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(app.origin + "/?start", { waitUntil: "load" });
  await page.locator(".start-go").click({ timeout: 8000 });
  await page.waitForSelector(".role-card");
  const m = await width(page);
  check("360x640 start -> picker width", m.scroll <= m.inner && m.inner === m.visual, m);
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
console.log(`CHROMIUM_PHONE checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
