// The rally clip as the camera phone records it: the real camera screen (fake camera playing a test
// clip, calibrated) in Chromium with the real font, portrait and landscape phone, PC save on. Waits for
// the first saved rally clip, then keeps it with the recorder's cost (ms per frame, panel repaints,
// canvas size), a capture of the camera screen, and the clip's frame at the moment the rally ends.
//   bun qa/replay-screen-clip.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--shapes=portrait,landscape] [--count=1] [--port=9975]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9975) });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const report = {};
try {
  for (const shape of (args.shapes || "portrait,landscape").split(",")) {
    const { defaultBrowserType, ...desc } = shape === "portrait" ? DEVICES.phone : DEVICES.land;
    const ctx = await browser.newContext(desc);
    await ctx.addInitScript(() => { sessionStorage.setItem("pp-started", "1"); });
    await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
    await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, { "pp-pin": app.pin, "pp-role": "camera", "ppv.uploadKey": JSON.stringify(app.key), "ppv.tourMode": JSON.stringify("all") });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/vision/", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await startCamera(page);
    // the first rally clip that reaches the PC
    const want = Number(args.count || 1);
    await page.waitForFunction((n) => (window.__ppv.state.history || []).filter((h) => h.upload && h.upload.status === "done").length >= n, want, { timeout: 120000 * want, polling: 500 });
    const infos = await page.evaluate(() => window.__ppv.state.history.filter((x) => x.upload && x.upload.status === "done").map((h) => ({ url: h.upload.url, bytes: h.upload.bytes, durationMs: h.durationMs, shots: h.shots })));
    const rec = await page.evaluate(() => window.__ppv.state.perf.rec);
    await page.screenshot({ path: join(out, `${shape}-camera-screen.png`) });
    report[shape] = [];
    for (const [i, info] of infos.slice(0, want).entries()) {
      const res = await fetch(new URL(info.url).pathname.replace(/^\/vision\/s\//, `${app.origin}/vision/s/`) + "/video");
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = buf.subarray(4, 8).toString() === "ftyp" ? "mp4" : "webm";
      const tag = want > 1 ? `${shape}-${i + 1}` : shape;
      const file = join(out, `${tag}-clip.${ext}`);
      writeFileSync(file, buf);
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0", file]).stdout.toString().trim().replace(/\n/g, " ");
      // the clip's last frame (the rally just decided)
      Bun.spawnSync(["ffmpeg", "-v", "error", "-sseof", "-0.3", "-i", file, "-frames:v", "1", "-y", join(out, `${tag}-clip-end.png`)]);
      report[shape].push({ ...info, rec, file, savedBytes: buf.length, probe });
      console.log(`SCREEN_CLIP ${tag} ${JSON.stringify(report[shape].at(-1))}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
writeFileSync(join(out, "screen-clip.json"), JSON.stringify(report, null, 2));
console.log("SCREEN_CLIP_DONE");
