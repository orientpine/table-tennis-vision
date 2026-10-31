import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const base = args.base || "http://127.0.0.1:8801/vision/";
const engine = args.engine === "webkit" ? webkit : chromium;
const out = args.out || "evidence/raw/eval.json";
const params = new URLSearchParams({
  video: args.video || "./videos/test_2.mp4",
  step: args.step || "2",
  from: args.from || "0",
  to: args.to || "100000",
  pose: args.pose || "1",
  poseEvery: args.poseEvery || "1",
  procWidth: args.procWidth || "640",
  delegate: args.delegate || "GPU",
});
if (args.corners) params.set("corners", args.corners);
for (const key of ["dumpPose", "dumpCands", "rawPose", "srcFps", "poseModel", "numPoses"]) if (args[key]) params.set(key, args[key]);

const browser = await engine.launch(
  engine === chromium
    ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] }
    : process.env.PPV_WEBKIT
      ? { executablePath: process.env.PPV_WEBKIT }
      : {},
);
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.error("[page]", m.text());
});
const url = `${base}qa/eval.html?${params}`;
console.log("open", url);
await page.goto(url);
await page.waitForFunction(() => window.__result, null, { timeout: 0, polling: 1000 });
const result = await page.evaluate(() => window.__result);
await browser.close();
mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(out, JSON.stringify(result));
if (result.error) {
  console.error("EVAL_ERROR", result.error);
  process.exit(1);
}
console.log(`EVAL_DONE frames=${result.frames.length} events=${result.events.length} wallMs=${Math.round(result.wallMs)} perf=${JSON.stringify(result.perf)} delegate=${result.delegate} -> ${out}`);
