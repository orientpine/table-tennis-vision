// The spectator replay of a clip the real recorder made (qa/replay-overlay.mjs output), captured in
// Chromium with the real pixel font on phone and TV, paused on one frame. Run once with the before
// clip and once with the after clip to put the two side by side.
//   bun qa/replay-overlay-shots.mjs --vision=<checkout> --tournament=<checkout> --clip=<recorded clip> --tag=before|after --out=<dir> [--port=9640]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";
import { measure } from "./overlay-measure.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9640) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const report = {};
try {
  const P360 = { ...DEVICES.phone, viewport: { width: 360, height: 640 } };
  for (const dev of (args.devices || "phone,p360,tv").split(",")) {
    const { defaultBrowserType, ...desc } = dev === "p360" ? P360 : DEVICES[dev];
    const ctx = await browser.newContext(desc);
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-sound", "0"); });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/");
    await page.waitForSelector(".pscore, .tv-score");
    await page.evaluate(() => document.fonts.ready);
    const replay = page.locator('[data-act="clip-play"]');
    if (await replay.count()) {
      await replay.first().scrollIntoViewIfNeeded();
      await replay.first().click();
    }
    const video = page.locator("[data-clip-video]").first();
    await video.waitFor();
    // the same moment of the clip on every build: 0.8 s in, paused
    const state = await video.evaluate(async (v) => {
      if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
      v.pause();
      v.currentTime = 0.8;
      await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      const r = v.getBoundingClientRect();
      return { err: v.error && v.error.code, w: v.videoWidth, h: v.videoHeight, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    });
    await video.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${args.tag}-${dev}.png` });
    const vpng = `${out}/${args.tag}-${dev}-video.png`;
    await video.screenshot({ path: vpng });
    // the picture (object-fit: contain) as it shows on screen, cut at the fixed bottom menu if any:
    // measured back in CSS px, so a tag is as tall as the eye sees it
    const vis = await video.evaluate((v) => {
      const r = v.getBoundingClientRect();
      const sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      const w = v.videoWidth * sc, h = v.videoHeight * sc;
      const x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
      const nav = [...document.querySelectorAll("nav, .tabs, .bottom-nav, [data-nav]")].map((n) => n.getBoundingClientRect()).filter((n) => n.height && n.bottom >= innerHeight - 1 && n.top > y).map((n) => n.top);
      const bottom = Math.min(y + h, innerHeight, ...nav);
      return { x: Math.round(x), y: Math.round(y), w: Math.floor(w), h: Math.floor(bottom - y), hiddenPx: Math.max(0, Math.round(y + h - bottom)) };
    });
    const ppng = `${out}/${args.tag}-${dev}-picture.png`;
    await page.screenshot({ path: ppng, clip: { x: vis.x, y: vis.y, width: vis.w, height: vis.h } });
    const W = vis.w, H = vis.h;
    const raw = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", ppng, "-vf", `scale=${W}:${H}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;
    const m = raw && raw.length === W * H * 3 ? measure(raw, W, H) : { error: `decoded ${raw?.length}` };
    // the picture inside the box (object-fit: contain)
    const sc = Math.min(W / state.w, H / state.h);
    // the replay open: does the box take the clip's shape, and does anything spill sideways or get
    // cut off at the bottom of a clipped panel (the TV side panel hides what does not fit)
    const layout = await page.evaluate(() => {
      const v = document.querySelector("[data-clip-video]");
      const cut = [];
      for (const box of document.querySelectorAll(".tv-panel")) {
        const b = box.getBoundingClientRect();
        for (const c of box.children) { const r = c.getBoundingClientRect(); if (r.height && r.bottom > b.bottom + 1) cut.push(`${c.className}`.slice(0, 30)); }
      }
      const wide = [...document.querySelectorAll(".pscore, .tv-side, .clip-now, .tv-clip")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map((e) => `${e.className}`.slice(0, 30));
      // the rally list next to or under the clip: rows shown whole, and rows spilling sideways
      const list = document.querySelector(".rallies .clip-list");
      const lr = list?.getBoundingClientRect();
      const rows = list ? [...list.children] : [];
      const rallyRows = rows.filter((li) => { const r = li.getBoundingClientRect(); return r.height && r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 && r.bottom <= innerHeight; }).length;
      const rowSpill = rows.filter((li) => li.scrollWidth > li.clientWidth + 1 || [...li.children].some((c) => { const r = c.getBoundingClientRect(); const p = li.getBoundingClientRect(); return r.right > p.right + 1 || r.left < p.left - 1; })).length;
      return { tall: v.classList.contains("is-tall"), overflowX: document.documentElement.scrollWidth > innerWidth, cut, wide, rallyRows, rowSpill };
    });
    report[dev] = { ...state, ...layout, hiddenUnderMenuPx: vis.hiddenPx, picture: { w: Math.round(state.w * sc), h: Math.round(state.h * sc) }, label: m.label, strip: m.strip, error: m.error };
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
writeFileSync(`${out}/${args.tag}.json`, JSON.stringify(report, null, 2));
console.log(`REPLAY_OVERLAY_SHOTS ${args.tag} ${JSON.stringify(report)}`);
