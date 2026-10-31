// 카메라 goes in with the same tournament PIN as 심판 (owner, 2026-10-31: "카메라도 심판모드와 같은 pin을
// 써서 들어가게 해줘"). On the mode picker, a device without a PIN that presses 카메라 gets the same
// PIN form the referee uses (same check, same lockout, same device memory): a wrong PIN or 취소 keeps it
// out, the right one opens the camera and stays remembered. A device that holds the PIN goes straight
// in; after 이 기기에서 PIN 지우기 it is asked again. 심판 and 관전 are unchanged, and with no tournament
// yet (no PIN exists) the camera opens as 심판 opens its setup: without asking. Phone 393 and TV 1920.
//   bun qa/camera-pin.mjs --engine=chromium|webkit --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9690]
//   bun qa/camera-pin.mjs --compare=<before dir>,<after dir> --out=<dir>   (side-by-side sheets)
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICES, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));

if (args.compare) {
  const [a, b] = args.compare.split(",");
  mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const uri = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  for (const f of readdirSync(b).filter((n) => n.endsWith(".png"))) {
    const left = readdirSync(a).includes(f) ? `<img src="${uri(join(a, f))}">` : "<p>(없음)</p>";
    await page.setContent(`<style>body{margin:0;background:#111;color:#fff;font:20px sans-serif;display:flex;gap:16px;padding:16px}figure{margin:0;flex:1}img{width:100%}</style>
      <figure><figcaption>고치기 전 · ${f}</figcaption>${left}</figure><figure><figcaption>고친 뒤 · ${f}</figcaption><img src="${uri(join(b, f))}"></figure>`);
    await page.waitForLoadState("load");
    await page.screenshot({ path: join(args.out, f), fullPage: true });
  }
  await browser.close();
  console.log(`CAMERA_PIN_COMPARE out=${args.out}`);
  process.exit(0);
}

const engine = args.engine || "chromium";
const out = `${args.out}/${engine}`;
mkdirSync(out, { recursive: true });
const port = Number(args.port || 9690);
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port });
const wrong = String((Number(app.pin) + 1) % 10000).padStart(4, "0");
const browser = engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch();
const fails = [];
let passes = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${engine} ${name} ${JSON.stringify(detail)}`); if (ok) passes++; else fails.push(name); };
const VIEWS = { p393: DEVICES.phone, tv: DEVICES.tv };

async function device(view, { pin = null, role = null, origin = app.origin } = {}) {
  const ctx = await browser.newContext(view);
  await ctx.addInitScript(fakeCamera, `${origin}/__qa/cam.webm`);
  await ctx.addInitScript(([r, p]) => {
    if (location.origin === "null" || sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    sessionStorage.setItem("pp-started", "1");
    localStorage.clear();
    localStorage.setItem("pp-sound", "0");
    if (r) localStorage.setItem("pp-role", r);
    if (p) localStorage.setItem("pp-pin", p);
  }, [role, pin]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  return { ctx, page, errors };
}
const toPicker = async (page, origin = app.origin) => {
  await page.goto(origin + "/?role", { waitUntil: "load" });
  await page.waitForSelector(".role-card", { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
};
const press = async (page, role) => {
  const card = page.locator(`.role-card[data-role="${role}"]`);
  // WebKit on a touch phone: a real touch tap (the TV has no touch screen, so it clicks).
  if (engine === "webkit" && (await page.evaluate(() => navigator.maxTouchPoints > 0))) {
    const r = await card.boundingBox();
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  } else await card.click();
};
// What the device shows after a press: the camera screen, the PIN form in a dialog, or still the picker.
const seen = (page) => page.evaluate(() => {
  const dlg = document.querySelector("dialog[open]");
  return {
    camera: window.__ppv ? window.__ppv.state.mode : null,
    pinForm: !!dlg?.querySelector('form[data-form="pin"] input[type="password"]'),
    err: dlg?.querySelector(".err-text")?.textContent.trim() || "",
    picker: document.querySelectorAll(".role-card").length,
    pressed: document.querySelectorAll(".role-card.pressed").length,
    pin: localStorage.getItem("pp-pin"),
    role: localStorage.getItem("pp-role"),
  };
}).catch((e) => ({ error: String(e.message || e) }));
// Wait for one of the outcomes (camera opened, PIN form, error text) instead of a fixed time.
const settle = (page, what) => page.waitForFunction((w) => {
  const dlg = document.querySelector("dialog[open]");
  if (w === "camera") return window.__ppv && window.__ppv.state.mode === "intro";
  if (w === "ask") return (window.__ppv && window.__ppv.state.mode === "intro") || !!dlg?.querySelector('form[data-form="pin"]');
  if (w === "err") return !!dlg?.querySelector(".err-text")?.textContent.trim();
  if (w === "picker") return !dlg && document.querySelectorAll(".role-card").length === 3;
  return false;
}, what, { timeout: 20000 }).catch(() => {});
const typePin = async (page, value) => {
  const field = page.locator('dialog[open] form[data-form="pin"] input[type="password"]');
  await field.fill(value);
  await page.locator('dialog[open] form[data-form="pin"] [type="submit"]').click();
};

// No tournament yet: a bare tournament app on an empty data folder. Camera opens like 심판 opens its setup.
async function emptyTournament() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-campin-empty-"));
  const p = port + 5;
  const srv = spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(p), DATA_DIR: dir }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${p}/api/state`)).ok) break; } catch {} await Bun.sleep(100); }
  return { origin: `http://127.0.0.1:${p}`, stop: () => { srv.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

try {
  for (const [name, view] of Object.entries(VIEWS)) {
    // 1. A device without the PIN presses 카메라: the referee's PIN form, not the camera.
    let d = await device(view);
    await toPicker(d.page);
    await d.page.screenshot({ path: `${out}/${name}-1-picker.png` });
    await press(d.page, "camera");
    await settle(d.page, "ask");
    let s = await seen(d.page);
    await d.page.screenshot({ path: `${out}/${name}-2-pin.png` });
    check(`${name}: no PIN on this device -> 카메라 asks for the tournament PIN`, s.pinForm && !s.camera, s);

    // 2. A wrong PIN: the server's answer under the field, still out of the camera, nothing saved.
    if (s.pinForm) {
      await typePin(d.page, wrong);
      await settle(d.page, "err");
      s = await seen(d.page);
      await d.page.screenshot({ path: `${out}/${name}-3-wrong.png` });
      check(`${name}: a wrong PIN is refused and the camera stays closed`, s.pinForm && !!s.err && !s.camera && !s.pin, s);

      // 3. 취소: back on the picker, every card unpainted, the device keeps its old mode.
      await d.page.locator("dialog[open]").getByRole("button", { name: "취소" }).click();
      await settle(d.page, "picker");
      s = await seen(d.page);
      check(`${name}: 취소 leaves the device on the picker, nothing pressed, mode not switched to camera`, !s.pinForm && s.picker === 3 && s.pressed === 0 && !s.camera && s.role !== "camera" && !s.pin, s);

      // 4. The right PIN: the camera opens and the device remembers the PIN (pp-pin, same as 심판).
      await press(d.page, "camera");
      await settle(d.page, "ask");
      await typePin(d.page, app.pin);
      await settle(d.page, "camera");
      s = await seen(d.page);
      // The camera screen takes that same stored PIN: linked to the tournament (scores) and PC 저장 on,
      // with no second PIN field to fill.
      const linked = () => document.body.innerText.includes("대회 연결됨") && document.body.innerText.includes("PC 저장: 켜짐");
      await d.page.waitForFunction(linked, null, { timeout: 20000 }).catch(() => {});
      const cam = await d.page.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
        const t = document.body.innerText;
        return { connected: t.includes("대회 연결됨"), waitingApproval: t.includes("심판 승인 대기"), saveOn: t.includes("PC 저장: 켜짐"), pinFields: [...document.querySelectorAll("input")].filter((i) => vis(i) && /PIN/.test(i.placeholder + (i.getAttribute("aria-label") || ""))).length };
      });
      await d.page.screenshot({ path: `${out}/${name}-4-camera.png` });
      check(`${name}: the right PIN opens the camera and is remembered on the device`, s.camera === "intro" && s.pin === app.pin && s.role === "camera", s);
      check(`${name}: the camera uses that PIN at once: tournament linked, PC 저장 on, no second PIN field`, cam.connected && !cam.waitingApproval && cam.saveOn && cam.pinFields === 0, cam);
    } else {
      // Before the fix the camera was already open: kept as the before picture.
      await d.page.screenshot({ path: `${out}/${name}-4-camera.png` });
    }
    check(`${name}: no page errors (new device)`, d.errors.length === 0, d.errors);
    await d.ctx.close();

    // 5. A device that holds the PIN goes straight in, no question.
    d = await device(view, { pin: app.pin });
    await toPicker(d.page);
    await d.page.evaluate(() => new MutationObserver(() => { if (document.querySelector("dialog[open]")) sessionStorage.setItem("qa-asked", "1"); }).observe(document.body, { subtree: true, attributes: true, childList: true }));
    await press(d.page, "camera");
    await settle(d.page, "camera");
    s = await seen(d.page);
    const asked = await d.page.evaluate(() => sessionStorage.getItem("qa-asked"));
    check(`${name}: a device that remembers the PIN opens the camera without asking`, s.camera === "intro" && !asked, { ...s, asked });
    await d.ctx.close();

    // 6. 이 기기에서 PIN 지우기 (설정), then 카메라 again: asked again.
    d = await device(view, { pin: app.pin, role: "referee" });
    await d.page.goto(app.origin + "/", { waitUntil: "load" });
    await d.page.locator("nav.nav button", { hasText: "설정" }).click();
    await d.page.locator('[data-act="logout"]').click();
    const cleared = await d.page.evaluate(() => localStorage.getItem("pp-pin"));
    await toPicker(d.page);
    await press(d.page, "camera");
    await settle(d.page, "ask");
    s = await seen(d.page);
    check(`${name}: after 이 기기에서 PIN 지우기 카메라 asks again`, cleared === null && s.pinForm && !s.camera, { cleared, ...s });
    await d.ctx.close();

    // 7. 심판 is unchanged: picking it asks nothing; the PIN goes in on 설정 as before and enables scoring.
    d = await device(view);
    await toPicker(d.page);
    await press(d.page, "referee");
    await d.page.waitForSelector('[data-act="pin"], .tv-score', { timeout: 15000 }).catch(() => {});
    s = await seen(d.page);
    const note = await d.page.locator('[data-act="pin"]').count();
    let chip = null;
    if (note) {
      await d.page.locator('[data-act="pin"]').first().click();
      await d.page.locator("#pin-input").fill(app.pin);
      await d.page.locator('[data-form="pin"] [type="submit"]').first().click();
      await d.page.waitForFunction(() => document.querySelector(".chip.on"), null, { timeout: 10000 }).catch(() => {});
      chip = await d.page.evaluate(() => document.querySelector(".chip")?.textContent.trim() || null);
    }
    check(`${name}: 심판 asks nothing on the picker, its PIN on 설정 enables scoring as before`, !s.pinForm && s.role === "referee" && note > 0 && chip === "기록 가능", { pinForm: s.pinForm, role: s.role, note, chip });
    check(`${name}: no page errors (referee)`, d.errors.length === 0, d.errors);
    await d.ctx.close();

    // 8. 관전 needs no PIN.
    d = await device(view);
    await toPicker(d.page);
    await press(d.page, "viewer");
    await d.page.waitForSelector(".pscore, .tv-score", { timeout: 15000 }).catch(() => {});
    s = await seen(d.page);
    const board = await d.page.locator(".pscore, .tv-score").count();
    check(`${name}: 관전 opens without a PIN`, board > 0 && !s.pinForm, { board, pinForm: s.pinForm });
    await d.ctx.close();
  }

  // 9. No tournament yet (no PIN exists): 카메라 does not ask, like 심판 goes to its setup without one.
  const empty = await emptyTournament();
  try {
    const d = await device(DEVICES.phone, { origin: empty.origin });
    await toPicker(d.page, empty.origin);
    await press(d.page, "camera");
    await d.page.waitForURL(/\/vision\//, { timeout: 10000 }).catch(() => {});
    const url = d.page.url();
    const s = await seen(d.page);
    check("p393: no tournament yet -> 카메라 opens without asking (as 심판 opens setup)", /\/vision\//.test(url) && !s.pinForm, { url, pinForm: s.pinForm });
    await d.ctx.close();
  } finally {
    empty.stop();
  }
} finally {
  await browser.close();
  await app.stop?.();
}
console.log(`CAMERA_PIN_DONE engine=${engine} pass=${passes} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
