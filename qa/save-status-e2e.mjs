// The PC save state on screen, real app in WebKit, phone and TV sizes, each case on a fresh device:
//   off       no key: intro, HUD chip and settings say off and how to turn it on
//   on        a key the server takes: all three say on
//   rejected  a stored key the server refuses: never shown as on
//   unknown   no answer from the server: says it could not check, never on
//   link      a fresh setup link turns it on; the same link tapped again says it is already on
// The key is never on screen. No key or token reaches the report or the console.
// Against qa/one-origin.mjs --data=<dir>:
//   PPV_WEBKIT=<webkit> bun qa/save-status-e2e.mjs --base=http://127.0.0.1:8960/vision/ --data=<dir> \
//     --clip=data/videos/clip12_720p60.webm [--out=evidence/setup-link/after]
import { devices, webkit } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSetupToken } from "../save-server.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/setup-link/run";
mkdirSync(out, { recursive: true });
const key = readFileSync(join(args.data, "upload-key"), "utf8").trim();
const tokenFile = join(args.data, "setup.json");
const sizes = {
  phone: { ...devices["iPhone 15"], viewport: { width: 393, height: 659 } },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};
const calibration = { corners: [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }], width: 1920, height: 1080 };

const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const consoleErrors = [];

async function device(size, stored, { block = false } = {}) {
  const ctx = await browser.newContext(sizes[size]);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(([cal, k]) => {
    if (location.protocol === "about:") return;
    localStorage.setItem("ppv.calibration", JSON.stringify(cal));
    if (k && !sessionStorage.getItem("seeded")) localStorage.setItem("ppv.uploadKey", JSON.stringify(k));
    sessionStorage.setItem("seeded", "1");
  }, [calibration, stored]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => consoleErrors.push(String(e.message)));
  if (block) await page.route("**/api/key-check", (r) => r.abort());
  return { ctx, page };
}

const intro = (page) => page.locator(".screen--intro").innerText().catch(() => "");
const settled = (page) => page.waitForFunction(() => window.__ppv && (!window.__ppv.state.save.keySet || window.__ppv.state.save.check), null, { timeout: 15000 }).catch(() => {});

// intro -> real file start -> HUD strip -> settings, one capture of each
async function screens(page, name) {
  await page.screenshot({ path: `${out}/${name}-intro.png` });
  const introText = await intro(page);
  await page.locator('input[type="file"]').first().setInputFiles(args.clip);
  await page.waitForFunction(() => ["ready", "running", "error"].includes(window.__ppv.state.mode), null, { timeout: 30000 });
  const mode = await page.evaluate(() => window.__ppv.state.mode);
  await page.screenshot({ path: `${out}/${name}-hud.png` });
  const chip = await page.evaluate(() => {
    const strip = document.querySelector(".strip");
    const c = strip?.querySelector(".chip--save");
    if (!c || !c.getClientRects().length) return null;
    const r = c.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    return { text: c.textContent, title: c.title, kind: c.dataset.saveKind, inside: r.left >= 0 && r.right <= innerWidth && r.right <= s.right + 1, clipped: strip.scrollWidth > strip.clientWidth + 1 };
  });
  await page.getByRole("button", { name: /설정/ }).first().click();
  await page.waitForSelector(".popover:not([hidden])");
  const settings = await page.locator(".popover").innerText();
  await page.screenshot({ path: `${out}/${name}-settings.png` });
  const leak = await page.evaluate((k) => document.documentElement.outerHTML.includes(k) || [...document.querySelectorAll("input")].some((i) => i.value === k), key);
  const supported = await page.evaluate(() => window.__ppv.state.save.supported);
  const settingsKind = await page.locator(".popover .chip--save").getAttribute("data-save-kind");
  return { mode, introText, chip, settings, leak, supported, settingsKind };
}

const has = (t, s) => (t || "").includes(s);
const results = {};
const checks = {};
for (const size of Object.keys(sizes)) {
  const base = args.base;
  const run = async (name, stored, opts, fn) => {
    const { ctx, page } = await device(size, stored, opts);
    try {
      await page.goto(base, { waitUntil: "networkidle" });
      await settled(page);
      const r = await screens(page, `${size}-${name}`);
      results[`${size}-${name}`] = { mode: r.mode, chip: r.chip, leak: r.leak };
      fn(r);
    } finally {
      await ctx.close();
    }
  };
  const c = (name, v) => { checks[`${size}.${name}`] = !!v; };

  await run("off", null, {}, (r) => {
    c("offIntro", has(r.introText, "PC 저장: 꺼짐") && has(r.introText, "대회 PIN을 넣으면 켜져요"));
    c("offChip", r.chip?.kind === (r.supported === false ? "bad" : "off") && r.chip.inside && !r.chip.clipped);
    c("offSettings", r.settingsKind === (r.supported === false ? "bad" : "off"));
  });
  await run("on", key, {}, (r) => {
    c("onIntro", has(r.introText, "PC 저장: 켜짐 ✓"));
    c("onChip", r.chip?.kind === (r.supported === false ? "bad" : "on") && r.chip.inside && !r.chip.clipped);
    c("onSettings", r.settingsKind === (r.supported === false ? "bad" : "on"));
    c("keyNotOnScreen", !r.leak);
  });
  await run("rejected", "x".repeat(43), {}, (r) => {
    c("rejectedNotOn", r.chip?.kind === "bad" && r.settingsKind === "bad");
  });
  await run("unknown", key, { block: true }, (r) => {
    c("unknownNotOn", r.chip?.kind === "bad" && r.settingsKind === "bad");
  });

  const { ctx, page } = await device(size, null);
  const { token } = createSetupToken({ tokenFile });
  const link = `${new URL("/", base).href}#setup=${token}`;
  let first = "", second = "", gotKey = false;
  await page.goto(link, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ppv?.state.save.notice, null, { timeout: 15000 }).catch(() => {});
  first = await intro(page);
  gotKey = (await page.evaluate(() => localStorage.getItem("ppv.uploadKey"))) === JSON.stringify(key);
  await page.screenshot({ path: `${out}/${size}-link-first.png` });
  await page.goto("about:blank");
  await page.goto(link, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ppv?.state.save.notice, null, { timeout: 15000 }).catch(() => {});
  second = await intro(page);
  await page.screenshot({ path: `${out}/${size}-link-again.png` });
  await ctx.close();
  c("linkTurnsOn", gotKey && has(first, "PC 저장이 켜졌어요") && has(first, "PC 저장: 켜짐 ✓"));
  c("linkAgainSaysAlreadyOn", has(second, "이미 켜져 있어요") && has(second, "PC 저장: 켜짐 ✓") && !has(second, "시간이 지났어요"));
}
await browser.close();

const pass = Object.values(checks).every(Boolean) && consoleErrors.length === 0;
writeFileSync(`${out}/report.json`, JSON.stringify({ results, checks, consoleErrors, pass }, null, 2));
console.log(`SAVE_STATUS ${pass ? "PASS" : "FAIL"} ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length}`);
for (const [k, v] of Object.entries(checks)) if (!v) console.log(`FAIL ${k}`);
process.exit(pass ? 0 : 1);
