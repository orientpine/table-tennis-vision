// PC save by tournament PIN through the real app, in Chromium and WebKit, on qa/one-origin.mjs:
//   pin        PIN typed on the first screen: screen says on, a real upload lands, the upload key never
//              reaches the browser, a reload stays on with no second PIN call
//   referee    PIN typed in the tournament app at "/", then the camera screen: on
//   lockout    five wrong PINs on the save path lock the tournament's own PIN check too; stays off
//   key        a device on the upload key (setup link) keeps it when the PIN is typed
//   changed    new tournament PIN: PIN device goes off and says why, key device stays on; new PIN: on
// Each case is a fresh isolated context with its own client address. No PIN, key or token is written
// to the report.
//   PPV_WEBKIT=<webkit> bun qa/save-pin-e2e.mjs --base=http://127.0.0.1:8970/vision/ --data=<dir> --out=<dir> [--engines=chromium,webkit]
import { chromium, devices, webkit } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSetupToken } from "../save-server.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base;
const origin = new URL(base).origin;
const out = args.out || "evidence/save-pin/run";
mkdirSync(out, { recursive: true });
const key = readFileSync(join(args.data, "upload-key"), "utf8").trim();
const tokenFile = join(args.data, "setup.json");
const engines = (args.engines || "chromium,webkit").split(",");
const phone = { ...devices["iPhone 15"], viewport: { width: 393, height: 659 } };
delete phone.defaultBrowserType;
const launchers = {
  chromium: () => chromium.launch({ ...(process.env.PPV_CHROMIUM ? { executablePath: process.env.PPV_CHROMIUM } : {}) }),
  webkit: () => webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}),
};
const players = { name: "저장 시험", players: ["블루", "레드", "셋째", "넷째"], format: "double", bestOf: 3 };
const tourFile = join(args.data, "tour/tournament.json");
let pin = existsSync(tourFile) ? JSON.parse(readFileSync(tourFile, "utf8")).pin : null;
const newTournament = async () => {
  const res = await fetch(origin + "/api/tournament", { method: "POST", headers: { "content-type": "application/json", ...(pin ? { "x-pin": pin } : {}) }, body: JSON.stringify({ ...players, force: true }) });
  if (!res.ok) throw new Error("create tournament " + res.status);
  pin = (await res.json()).pin;
};

let ipSeq = 1;
async function device(browser, engine, name, url = base) {
  const ctx = await browser.newContext({ ...(engine === "chromium" ? { ...phone, isMobile: true, hasTouch: true } : phone), extraHTTPHeaders: { "x-forwarded-for": "10.77." + (engine === "webkit" ? 2 : 1) + "." + ipSeq++ } });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  const page = await ctx.newPage();
  const calls = [];
  const bodies = [];
  page.on("response", async (r) => {
    if (!r.url().includes("/api/")) return;
    calls.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() });
    bodies.push(await r.text().catch(() => ""));
  });
  await page.goto(url, { waitUntil: "load" });
  if (url === base) await settled(page);
  return { ctx, page, calls, bodies, name: engine + "-" + name };
}
const settled = (page) => page.waitForFunction(() => window.__ppv && (!window.__ppv.state.save.keySet || window.__ppv.state.save.check), null, { timeout: 15000 });
const isOn = (page) => page.waitForFunction(() => window.__ppv.state.save.check === "ok" && document.body.innerText.includes("PC 저장: 켜짐"), null, { timeout: 15000 }).then(() => true, () => false);
const introSays = (page) => page.locator(".screen--intro").innerText().catch(() => "");
async function typePin(page, value) {
  await page.fill('input[name="intro-pin"]', value);
  await page.getByRole("button", { name: "켜기" }).click();
  await page.waitForFunction(() => window.__ppv.state.tour.connected || window.__ppv.state.tour.error, null, { timeout: 15000 });
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ppv.uploadKey") || "null"));
const bytes = () => { const b = new Uint8Array(200); b.set([0x66, 0x74, 0x79, 0x70], 4); return [...b]; };
const uploadFromPage = (page) => page.evaluate(async (b) => {
  const k = JSON.parse(localStorage.getItem("ppv.uploadKey") || "null");
  const form = new FormData();
  form.set("record", JSON.stringify({ shots: 1, durationMs: 1000, bounces: [] }));
  form.set("video", new Blob([new Uint8Array(b)], { type: "video/mp4" }), "rally");
  const res = await fetch("/vision/api/rallies", { method: "POST", headers: k ? { "x-ppv-key": k } : {}, body: form });
  const body = await res.json().catch(() => ({}));
  const share = body.share ? (await fetch("/vision/" + body.share)).status : null;
  return { status: res.status, share };
}, bytes());
const shot = (d, step) => d.page.screenshot({ path: out + "/" + d.name + "-" + step + ".png" });

const checks = {};
const facts = {};
for (const engine of engines) {
  const c = (k, v) => { checks[engine + "." + k] = !!v; };
  const browser = await launchers[engine]();
  try {
    await newTournament();
    // pin
    const a = await device(browser, engine, "pin");
    c("offFirst", (await introSays(a.page)).includes("PC 저장: 꺼짐") && (await introSays(a.page)).includes("대회 PIN을 넣으면 켜져요"));
    await shot(a, "1-off");
    await typePin(a.page, pin);
    c("onAfterPin", await isOn(a.page));
    await shot(a, "2-intro-on");
    c("bothOnOneScreen", (await a.page.evaluate(() => window.__ppv.state.tour.connected)) && (await introSays(a.page)).includes("PC 저장: 켜짐"));
    c("noticeOneLine", (await introSays(a.page)).includes("점수 기록과 PC 저장이 켜졌어요"));
    const token = await stored(a.page);
    c("deviceToken", token && token !== key && /^[A-Za-z0-9_-]{43}$/.test(token));
    c("keyNeverSent", !a.bodies.some((b) => b.includes(key)));
    const up = await uploadFromPage(a.page);
    facts[engine + ".upload"] = up;
    c("uploads", up.status === 201 && up.share === 200);
    a.calls.length = 0;
    await a.page.reload({ waitUntil: "load" });
    await settled(a.page);
    c("reloadStaysOn", await isOn(a.page));
    c("reloadNoPinCall", !a.calls.some((x) => x.path.endsWith("/pin-save")));

    // referee
    const b = await device(browser, engine, "referee", origin + "/");
    await b.page.locator('[data-act="role"][data-role="referee"]').first().click();
    await b.page.locator('nav.nav button', { hasText: "설정" }).click();
    await b.page.fill("#pin-input", pin);
    await b.page.locator("#pin-input").press("Enter");
    await b.page.waitForFunction(() => !!localStorage.getItem("pp-pin"), null, { timeout: 10000 });
    await b.page.goto(base, { waitUntil: "load" });
    c("refereeThenCameraOn", await isOn(b.page));
    await shot(b, "camera-on");

    // lockout: wrong PINs on the save path; the right PIN in the normal form is then refused too
    const l = await device(browser, engine, "lockout");
    const wrong = pin === "0000" ? "1111" : "0000";
    const wrongCodes = await l.page.evaluate(async (w) => {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch("/vision/api/pin-save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: w }) })).status);
      return codes;
    }, wrong);
    facts[engine + ".wrongCodes"] = wrongCodes;
    c("wrong401", wrongCodes.every((x) => x === 401));
    await typePin(l.page, pin);
    c("sharedLock", l.calls.some((x) => x.path === "/api/pin/verify" && x.status === 429));
    c("lockShown", (await introSays(l.page)).includes("1분 뒤") && (await l.page.locator(".screen--intro .screen__note").last().evaluate((n) => { const r = n.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })));
    await shot(l, "locked");
    c("lockedOff", (await stored(l.page)) === null && !(await l.page.evaluate(() => document.body.innerText.includes("PC 저장: 켜짐"))));
    const locked = await uploadFromPage(l.page);
    c("lockedUpload401", locked.status === 401);

    // key: a device already on keeps the upload key
    const { token: setup } = createSetupToken({ tokenFile });
    const k = await device(browser, engine, "key");
    await k.page.goto(base + "#setup=" + setup, { waitUntil: "load" });
    c("keyOn", await isOn(k.page));
    k.calls.length = 0;
    await k.page.evaluate((p) => localStorage.setItem("pp-pin", p), pin);
    await k.page.reload({ waitUntil: "load" });
    await k.page.waitForFunction(() => window.__ppv.state.tour.connected, null, { timeout: 10000 });
    await settled(k.page);
    c("keyKept", (await stored(k.page)) === key && !k.calls.some((x) => x.path.endsWith("/pin-save")));

    // changed
    const oldPin = pin;
    await newTournament();
    c("pinReallyChanged", oldPin !== pin);
    await a.page.reload({ waitUntil: "load" });
    await settled(a.page);
    await a.page.waitForFunction(() => window.__ppv.state.save.check === "rejected", null, { timeout: 10000 });
    await a.page.waitForFunction(() => window.__ppv.state.save.notice, null, { timeout: 10000 });
    const said = await introSays(a.page);
    await shot(a, "4-pin-changed");
    c("changedPinBox", await a.page.locator('input[name="intro-pin"]').isVisible());
    c("changedOff", said.includes("PC 저장: 꺼짐") && said.includes("대회 PIN을 넣으면 켜져요") && said.includes("새 PIN을 넣으면"));
    c("changedUpload401", (await uploadFromPage(a.page)).status === 401);
    c("stalePinDropped", (await a.page.evaluate(() => localStorage.getItem("ppv.tourPin"))) === null || (await a.page.evaluate(() => localStorage.getItem("ppv.tourPin"))) === "null");
    await k.page.reload({ waitUntil: "load" });
    c("keyDeviceStaysOn", await isOn(k.page));
    await typePin(a.page, pin);
    c("newPinOn", await isOn(a.page));
    await shot(a, "5-new-pin-on");
    c("newToken", (await stored(a.page)) !== token);
    c("newUpload", (await uploadFromPage(a.page)).status === 201);
  } catch (err) {
    c("finished", false);
    facts[engine + ".error"] = String(err.message || err).replaceAll(key, "<key>").replaceAll(pin ?? "<none>", "<pin>").slice(0, 400);
  }
  await browser.close();
}
const pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
const failed = Object.keys(checks).filter((k) => !checks[k]);
writeFileSync(out + "/report.json", JSON.stringify({ pass, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, failed, checks, facts }, null, 2));
console.log("SAVE_PIN " + (pass ? "PASS" : "FAIL") + " " + Object.values(checks).filter(Boolean).length + "/" + Object.keys(checks).length + (failed.length ? " failed: " + failed.join(" ") : "") + " " + JSON.stringify(facts));
process.exit(pass ? 0 : 1);
