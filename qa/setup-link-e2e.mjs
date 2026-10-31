// One-time setup link through the real app in WebKit (iPhone 15): a fresh link opens, the app
// stores the upload key, the address bar loses the #setup part, no request URL carries the
// token; the same link opened again is refused. Neither the token nor the key is written to the
// report or the console.
//   bun qa/setup-link-e2e.mjs --base=<app url> --setup-file=<server setup-tokens.json> --key-file=<server upload-key> [--out=evidence/r2/setup]
import { devices, webkit } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSetupToken } from "../save-server.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base;
const out = args.out || "evidence/r2/setup";
mkdirSync(out, { recursive: true });
const { token } = createSetupToken({ tokenFile: args["setup-file"] });
const key = readFileSync(args["key-file"], "utf8").trim();
const link = `${base}#setup=${token}`;

const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const open = async (name) => {
  const ctx = await browser.newContext({ ...devices["iPhone 15"] });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  const page = await ctx.newPage();
  const urls = [];
  page.on("request", (r) => urls.push({ method: r.method(), url: r.url(), body: r.postData() || "" }));
  await page.goto(link, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ppv && (window.__ppv.state.save.keySet || window.__ppv.state.save.keyError), null, { timeout: 15000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  const s = await page.evaluate(() => ({ href: location.href, save: window.__ppv.state.save, stored: localStorage.getItem("ppv.uploadKey"), intro: document.querySelector(".screen--intro")?.innerText || "" }));
  await ctx.close();
  return {
    hashGone: !s.href.includes("#"),
    keySet: s.save.keySet,
    storedKeyMatches: s.stored === JSON.stringify(key),
    notice: s.save.notice,
    noticeOnScreen: !!s.save.notice && s.intro.includes(s.save.notice),
    tokenInAnyUrl: urls.some((u) => u.url.includes(token)),
    setupPosts: urls.filter((u) => u.method === "POST" && u.url.endsWith("/api/setup")).length,
  };
};
const first = await open("first-open");
const second = await open("second-open");
await browser.close();
const checks = {
  firstStoresKey: first.keySet && first.storedKeyMatches,
  firstHashGone: first.hashGone,
  firstNoticeShown: first.noticeOnScreen,
  tokenNeverInUrl: !first.tokenInAnyUrl && !second.tokenInAnyUrl,
  oneSetupPostEach: first.setupPosts === 1 && second.setupPosts === 1,
  secondRefused: !second.keySet && !second.storedKeyMatches && second.hashGone,
};
const pass = Object.values(checks).every(Boolean);
writeFileSync(`${out}/report.json`, JSON.stringify({ base, first: { ...first }, second: { ...second }, checks, pass }, null, 2));
console.log(`SETUP_LINK ${Object.entries(checks).map(([k, v]) => `${k}=${v ? "PASS" : "FAIL"}`).join(" ")}`);
process.exit(pass ? 0 : 1);
