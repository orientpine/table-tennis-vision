// Does the pixel font really draw? Computed font-family only repeats the CSS, so this loads each face
// in each engine and compares the drawn width of Korean text with the fallback.
//   bun qa/font-load.mjs --url=<page url> [--engines=chromium,webkit]
import { chromium, webkit } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const launch = { chromium: () => chromium.launch(), webkit: () => webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) };
let bad = 0;
for (const name of (args.engines || "chromium,webkit").split(",")) {
  const browser = await launch[name]();
  const page = await browser.newPage();
  const failed = [];
  page.on("requestfailed", (r) => { if (/woff2/.test(r.url())) failed.push(`${r.url().split("/").pop()} ${r.failure()?.errorText}`); });
  page.on("response", (r) => { if (/woff2/.test(r.url())) failed.push(`${r.url().split("/").pop()} ${r.status()} ${r.headers()["content-type"]}`); });
  await page.goto(args.url, { waitUntil: "load" });
  const r = await page.evaluate(async () => {
    const out = {};
    const c = document.createElement("canvas").getContext("2d");
    const w = (font) => { c.font = font; return Math.round(c.measureText("시작하기 점수 취소 PINGPONG").width * 10) / 10; };
    out.fallback = w("400 16px sans-serif");
    for (const f of ["400 16px Galmuri9", "400 16px Galmuri11", "700 16px Galmuri11"]) {
      const face = await Promise.race([document.fonts.load(f, "시작하기").then((x) => `faces=${x.length}`, (e) => `ERR ${e.name}`), new Promise((res) => setTimeout(() => res("TIMEOUT"), 8000))]);
      out[f] = { face, width: w(f) };
    }
    out.status = [...document.fonts].map((f) => `${f.family}/${f.weight}:${f.status}`);
    return out;
  });
  const drawn = ["400 16px Galmuri9", "400 16px Galmuri11", "700 16px Galmuri11"].every((f) => /faces=[1-9]/.test(r[f].face) && r[f].width !== r.fallback);
  console.log(`FONT ${name} drawn=${drawn} ${JSON.stringify(r)} net=${JSON.stringify(failed)}`);
  if (!drawn) bad++;
  await browser.close();
}
console.log(`FONT_DONE bad=${bad}`);
process.exit(bad ? 1 : 0);
