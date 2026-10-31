// 내 자리에서 보기 (Chromium, isolated tournament): the card-order switch lives in the settings tab, not
// under the referee or spectator cards; turning it on there flips the two player cards on both
// screens, is remembered on this device (pp-flip, the old key, so an old choice carries over), and
// writes nothing to the tournament (rev unchanged).
//   bun qa/flip-setting.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9700]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9700) });
const browser = await chromium.launch();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); if (!ok) fails.push(name); };
const rev = async () => (await (await fetch(`${app.origin}/api/state`)).json()).rev;
const tab = (page, label) => page.locator("nav.nav button", { hasText: label }).click();
const order = (page) => page.evaluate(() => [...document.querySelectorAll(".pane .pname")].map((e) => e.textContent.trim()));
try {
  for (const [role, pin] of [["referee", true], ["viewer", false]]) {
    const ctx = await browser.newContext(DEVICES.phone);
    await ctx.addInitScript(([r, p, old]) => {
      if (location.origin === "null" || sessionStorage.getItem("__preset")) return;
      sessionStorage.setItem("__preset", "1");
      sessionStorage.setItem("pp-started", "1");
      localStorage.setItem("pp-role", r);
      localStorage.setItem("pp-sound", "0");
      localStorage.setItem("pp-tab", "match");
      if (p) localStorage.setItem("pp-pin", p);
      if (old) localStorage.setItem("pp-flip", old);
    }, [role, pin ? app.pin : null, null]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(app.origin + "/", { waitUntil: "load" });
    await page.waitForSelector(".pane .pname");
    const r0 = await rev();
    const before = await order(page);
    const under = await page.locator('.controls [data-act="flip"]').count();
    check(`${role}: no card-order button under the cards`, under === 0, { under });
    await page.screenshot({ path: `${out}/${role}-match.png`, fullPage: true });
    await tab(page, "설정");
    const sw = page.getByRole("button", { name: /내 자리에서 보기/ });
    check(`${role}: settings has 내 자리에서 보기, off`, (await sw.count()) === 1 && (await sw.getAttribute("aria-pressed")) === "false" && /꺼짐/.test(await sw.textContent()), {});
    await sw.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${role}-settings-off.png` });
    await sw.click();
    const on = page.getByRole("button", { name: /내 자리에서 보기/ });
    check(`${role}: turned on`, (await on.getAttribute("aria-pressed")) === "true" && /켜짐/.test(await on.textContent()) && (await page.evaluate(() => localStorage.getItem("pp-flip"))) === "1", {});
    await on.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${role}-settings-on.png` });
    await tab(page, "경기");
    await page.waitForSelector(".pane .pname");
    const after = await order(page);
    check(`${role}: the two cards swapped`, before.length === 2 && after[0] === before[1] && after[1] === before[0], { before, after });
    await page.screenshot({ path: `${out}/${role}-match-flipped.png`, fullPage: true });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".pane .pname");
    check(`${role}: remembered after reload`, JSON.stringify(await order(page)) === JSON.stringify(after), {});
    check(`${role}: nothing written to the tournament`, (await rev()) === r0, { r0, r1: await rev() });
    check(`${role}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
  { // An old pp-flip=1 from the bottom button carries over.
    const ctx = await browser.newContext(DEVICES.phone);
    await ctx.addInitScript(() => { if (location.origin === "null") return; sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-tab", "settings"); localStorage.setItem("pp-flip", "1"); });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/", { waitUntil: "load" });
    await tab(page, "설정");
    const sw = page.getByRole("button", { name: /내 자리에서 보기/ });
    await sw.waitFor();
    check("an old flip choice shows as 켜짐", (await sw.getAttribute("aria-pressed")) === "true", {});
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
console.log(`FLIP_SETTING_DONE fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
