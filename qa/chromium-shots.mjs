// Captures in the real pixel font (Chromium; the WPE WebKit build cannot decode woff2): the start
// screen on phone and TV, and the portrait pad scoreboard without and with a replay open.
//   bun qa/chromium-shots.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9860]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9860) });
const browser = await chromium.launch();
const open = async (device, role, url) => {
  const ctx = await browser.newContext(device);
  await ctx.addInitScript(([r]) => {
    if (location.origin === "null") return;
    if (r) { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", r); localStorage.setItem("pp-sound", "0"); }
  }, [role]);
  const page = await ctx.newPage();
  await page.goto(app.origin + url, { waitUntil: "load" });
  return { ctx, page };
};
const report = {};
try {
  for (const dev of ["phone", "tv"]) {
    const { ctx, page } = await open(DEVICES[dev], null, "/?start");
    await page.waitForSelector(".start-go");
    await page.evaluate(() => document.fonts.ready);
    report[`start-${dev}`] = await page.evaluate(() => {
      const b = document.querySelector(".start-go"), r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), pctW: Math.round((r.width / innerWidth) * 100), font: getComputedStyle(b).fontSize, faces: [...document.fonts].filter((f) => f.status === "loaded").length };
    });
    await page.screenshot({ path: `${out}/start-${dev}.png` });
    await ctx.close();
  }
  const { ctx, page } = await open(DEVICES.pad, "viewer", "/");
  await page.waitForSelector(".tv-score");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const pad = () => page.evaluate(() => {
    const v = document.querySelector(".tv-clip video")?.getBoundingClientRect();
    return { replay: !!document.querySelector(".tv-replay"), score: getComputedStyle(document.querySelector(".tv-score")).fontSize, cards: !!document.querySelector(".tv-cards") && getComputedStyle(document.querySelector(".tv-cards")).display !== "none", videoPctW: v ? Math.round((v.width / innerWidth) * 100) : null, overflow: document.documentElement.scrollHeight > innerHeight + 1 };
  });
  report.padNoReplay = await pad();
  await page.screenshot({ path: `${out}/pad-no-replay.png` });
  await page.locator('[data-act="clip-play"]').nth(1).click();
  await page.waitForSelector(".tv-replay");
  await page.waitForTimeout(1200);
  report.padReplay = await pad();
  await page.screenshot({ path: `${out}/pad-replay.png` });
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/shots.json`, JSON.stringify(report, null, 2));
console.log("SHOTS " + JSON.stringify(report));
