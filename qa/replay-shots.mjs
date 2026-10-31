// 관전 rally replay, captured the way a spectator uses it: open the match as 관전 and press 다시 보기 on
// an older rally (not the latest point), on phone, pad and TV. Run once per build for before/after.
//   bun qa/replay-shots.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --tag=before|after --out=<dir> [--port=9600]
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9600) });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const report = {};
try {
  for (const dev of ["phone", "pad", "tv"]) {
    const ctx = await browser.newContext(DEVICES[dev]);
    await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
    await ctx.addInitScript(() => { localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-sound", "0"); });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/");
    await page.waitForSelector(".pscore, .tv-score");
    await page.waitForTimeout(800);
    // the older saved rally: the second "다시 보기" (the first is the latest point)
    const replay = page.locator('[data-act="clip-play"]');
    const n = await replay.count();
    let pressed = null;
    if (n >= 2) {
      await replay.nth(1).scrollIntoViewIfNeeded();
      await replay.nth(1).click();
      await page.waitForTimeout(1500);
      pressed = await page.evaluate(() => {
        const v = document.querySelector("video[data-clip-video]");
        const h = document.querySelector(".clip-now h2, .tv-clip h2");
        return { title: h && h.textContent.trim(), playing: !!v && !v.paused, time: v ? Math.round(v.currentTime * 10) / 10 : null };
      });
      await page.locator(".clip-now, .tv-clip").first().scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.screenshot({ path: `${out}/${dev}-관전-다시보기.png` });
    report[dev] = { replayButtons: n, pressed };
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/replay.json`, JSON.stringify(report, null, 2));
console.log(`REPLAY_DONE ${args.tag} ${JSON.stringify(report)}`);
