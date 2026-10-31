// How big every video really is on a portrait screen (WebKit, isolated servers): shown picture
// width and height, share of the screen, empty space above and below it, and whether something
// sits on top of the picture (replay and share pages only: the camera screen floats its panels on
// the picture by design since 2026-10-30, and qa/overlay-layout.mjs checks they keep off the table). A 16:9 and a 9:16 camera source both run: an iPhone held upright can
// deliver either.
//   bun qa/video-size.mjs --vision=<checkout> --tournament=<checkout> --clip=<16:9 webm> --clip-tall=<9:16 webm> --tag=before|after --out=<dir> [--port=9840]
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const screens = { phone: DEVICES.phone, pad: { ...DEVICES.pad, viewport: { width: 768, height: 1024 } } };
const rows = [];

const measure = (page) => page.evaluate(() => {
  const list = [...document.querySelectorAll("video")].filter((v) => {
    const r = v.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && getComputedStyle(v).visibility !== "hidden" && !v.closest("[hidden]");
  });
  const sw = innerWidth, sh = innerHeight;
  return list.map((v) => {
    const r = v.getBoundingClientRect();
    const fit = getComputedStyle(v).objectFit;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const s = fit === "cover" ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
    const w = Math.min(vw * s, r.width), h = Math.min(vh * s, r.height);
    const x = r.x + (r.width - w) / 2, y = r.y + (r.height - h) / 2;
    const hits = [0.02, 0.5, 0.98].map((fy) => {
      const p = [x + w / 2, y + h * fy];
      const e = document.elementFromPoint(p[0], p[1]);
      return { fy, by: e && e !== v && !e.closest(".stage") && !e.closest(".clip-now, .tv-clip") ? (e.className || e.tagName).toString().slice(0, 40) : null, off: p[1] < 0 || p[1] > sh };
    });
    return {
      size: `${vw}x${vh}`, fit, w: Math.round(w), h: Math.round(h),
      widthPct: Math.round((w / sw) * 100), areaPct: Math.round(((w * h) / (sw * sh)) * 100),
      boxH: Math.round(r.height), bandTop: Math.round(y - r.y), bandBottom: Math.round(r.bottom - (y + h)),
      covered: hits.filter((c) => c.by).map((c) => c.by), offscreen: hits.some((c) => c.off),
    };
  });
});
const push = (screen, surface, source, list) => {
  for (const m of list.length ? list : [null]) rows.push({ screen, surface, source, ...(m || { missing: true }) });
};

for (const [source, clip, port] of [["16:9", args.clip, Number(args.port || 9840)], ["9:16", args["clip-tall"], Number(args.port || 9840) + 40]]) {
  const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip, port });
  try {
    for (const [name, device] of Object.entries(screens)) {
      {
        const ctx = await browser.newContext(device);
        await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
        await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
        await ctx.addInitScript(() => localStorage.setItem("pp-role", "camera"));
        const page = await ctx.newPage();
        await page.goto(app.origin + "/");
        await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
        await startCamera(page);
        await page.waitForTimeout(1500);
        push(name, "카메라 촬영", source, await measure(page));
        await page.screenshot({ path: `${out}/${name}-${source.replace(":", "x")}-촬영.png` });
        const fill = page.locator(".stage__fit:visible");
        if (source === "16:9" && await fill.count()) {
          await fill.click();
          await page.waitForTimeout(800);
          push(name, "카메라 채움", source, await measure(page));
          await page.screenshot({ path: `${out}/${name}-16x9-채움.png` });
        }
        await page.getByRole("button", { name: /코트 보정/ }).click();
        await page.waitForFunction(() => window.__ppv.state.mode === "calibrating", null, { timeout: 8000 });
        await page.waitForTimeout(600);
        push(name, "보정", source, await measure(page));
        await page.screenshot({ path: `${out}/${name}-${source.replace(":", "x")}-보정.png` });
        await ctx.close();
      }
      if (source === "16:9") {
        const ctx = await browser.newContext(device);
        await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
        await ctx.addInitScript(() => { localStorage.setItem("pp-role", "viewer"); localStorage.setItem("pp-sound", "0"); });
        const page = await ctx.newPage();
        await page.goto(app.origin + "/");
        await page.waitForSelector(".pscore, .tv-score");
        await page.waitForTimeout(800);
        const replay = page.locator('[data-act="clip-play"]');
        await replay.nth(Math.min(1, (await replay.count()) - 1)).click();
        await page.waitForTimeout(1500);
        push(name, "관전 다시 보기", source, await measure(page));
        await page.screenshot({ path: `${out}/${name}-다시보기.png` });
        const clipSrc = await page.locator("video[data-clip-video]").first().getAttribute("src");
        await page.goto(new URL(clipSrc.replace(/\/video$/, ""), page.url()).href);
        await page.waitForSelector("video", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1200);
        push(name, "하이라이트 공유 페이지", source, await measure(page));
        await page.screenshot({ path: `${out}/${name}-공유.png` });
        await ctx.close();
      }
    }
  } finally {
    await app.stop();
  }
}
await browser.close();
const fails = rows.filter((r) => r.missing || (r.surface === "보정" && r.fit !== "contain") || (r.surface !== "보정" && r.widthPct < 95) || (r.surface !== "보정" && r.source !== "16:9" && r.fit !== "cover") || (r.covered?.length && !r.surface.startsWith("카메라")) || r.offscreen);
writeFileSync(`${out}/video-size.json`, JSON.stringify(rows, null, 2));
const md = ["| 화면 | 영상 | 소스 | 폭×높이 | 화면 폭 % | 화면 면적 % | 위 빈 칸 | 아래 빈 칸 | 맞춤 | 가림 |", "|---|---|---|---|---|---|---|---|---|---|"];
for (const r of rows) md.push(r.missing ? `| ${r.screen} | ${r.surface} | ${r.source} | 없음 | | | | | | |` : `| ${r.screen} | ${r.surface} | ${r.size} | ${r.w}×${r.h} | ${r.widthPct} | ${r.areaPct} | ${r.bandTop} | ${r.bandBottom} | ${r.fit} | ${[...r.covered, r.offscreen ? "화면 밖" : ""].filter(Boolean).join(", ") || "없음"} |`);
writeFileSync(`${out}/video-size.md`, md.join("\n") + "\n");
console.log(`VIDEO_SIZE ${args.tag} rows=${rows.length} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
