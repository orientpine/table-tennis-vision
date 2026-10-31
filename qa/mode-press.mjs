// The mode picker's buttons: on entry every mode button has the same plain frame (a remembered mode or
// a focus does not paint one in advance); while a finger, mouse or key holds one it takes the mode look
// the app already uses (frame in its mode colour, camera purple), the others stay; releasing opens that
// mode, sliding off first cancels; coming back (← or browser back) shows them all the same again;
// keyboard focus only thickens the frame in the same colour. Phone 393, phone 360 and TV.
//   bun qa/mode-press.mjs --engine=chromium|webkit --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9680]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const engine = args.engine || "chromium";
const out = `${args.out}/${engine}`;
mkdirSync(out, { recursive: true });
const VIEWS = {
  p393: DEVICES.phone,
  p360: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tv: DEVICES.tv,
};
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9680) });
const browser = engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${engine} ${name} ${JSON.stringify(detail)}`); if (!ok) fails.push(name); };

// Each card's paint, and its own mode colour (the colour its name is drawn in).
const cards = (page) => page.evaluate(() => [...document.querySelectorAll(".role-card")].map((c) => {
  const s = getComputedStyle(c);
  const r = c.getBoundingClientRect();
  return { role: c.dataset.role, bg: s.backgroundColor, border: s.borderTopColor, mode: getComputedStyle(c.querySelector("b")).color, outline: s.outlineStyle === "none" ? 0 : parseFloat(s.outlineWidth), outlineColor: s.outlineColor, cls: c.className, x: r.left + r.width / 2, y: r.top + r.height / 2, focus: document.activeElement === c };
}));
const same = (list) => list.length === 3 && list.every((c) => c.bg === list[0].bg && c.border === list[0].border && !/\b(on|pressed)\b/.test(c.cls));
const toPicker = async (page) => {
  await page.goto(app.origin + "/");
  await page.waitForSelector(".start-go");
  await page.locator(".start-go").click();
  await page.waitForSelector(".role-card");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
};
// Notes the card's colour the moment it gains the pressed class (a quick tap or Enter is over before a poll).
const watchPress = (page) => page.evaluate(() => {
  // Kept in sessionStorage: 카메라 leaves for /vision/ right after the press.
  sessionStorage.removeItem("qa-press");
  for (const c of document.querySelectorAll(".role-card")) new MutationObserver(() => { if (c.classList.contains("pressed") && !sessionStorage.getItem("qa-press")) sessionStorage.setItem("qa-press", JSON.stringify({ role: c.dataset.role, bg: getComputedStyle(c).borderTopColor })); }).observe(c, { attributes: true });
});
const readPress = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("qa-press") || "null"));

try {
  for (const [name, view] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext(view);
    // the owner's phone: camera was the last mode picked, and it holds the PIN (without it 카메라 asks for
    // the PIN first: qa/camera-pin.mjs).
    await ctx.addInitScript((pin) => { if (!sessionStorage.getItem("qa-seeded")) { localStorage.setItem("pp-role", "camera"); localStorage.setItem("pp-pin", pin); sessionStorage.setItem("qa-seeded", "1"); } }, app.pin);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await toPicker(page);
    const entry = await cards(page);
    await page.screenshot({ path: `${out}/${name}-1-entry.png` });
    check(`${name}: on entry every mode button is the same colour`, same(entry), entry.map(({ role, bg, border, cls }) => ({ role, bg, border, cls })));

    // Hold each one, then slide off and let go: its own mode colour while held, nothing opens.
    for (const card of entry) {
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.waitForTimeout(80);
      const held = await cards(page);
      if (card.role === "camera") await page.screenshot({ path: `${out}/${name}-2-press-camera.png` });
      const me = held.find((c) => c.role === card.role), others = held.filter((c) => c.role !== card.role);
      check(`${name}: holding ${card.role} paints its frame its mode colour, others stay`, me.border === me.mode && me.border !== entry[0].border && others.every((c) => c.border === entry[0].border && c.bg === entry[0].bg), { held: me.border, bg: me.bg, mode: me.mode, rest: entry[0].border, others: others.map((c) => c.border) });
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await page.waitForTimeout(250);
      const after = await cards(page);
      check(`${name}: sliding off ${card.role} and letting go leaves the picker unpainted`, after.length === 3 && same(after), after.map(({ role, bg, cls }) => ({ role, bg, cls })));
    }

    // Press and release on 관전: purple-family press seen, then the spectator screen opens.
    let list = await cards(page);
    let viewer = list.find((c) => c.role === "viewer");
    await watchPress(page);
    await page.mouse.move(viewer.x, viewer.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForSelector(".pscore, .tv-score", { timeout: 8000 }).catch(() => {});
    const opened = (await page.locator(".pscore, .tv-score").count()) > 0;
    const press = await readPress(page);
    check(`${name}: a click on 관전 shows the press, then the spectator screen opens`, opened && press?.role === "viewer" && press.bg === viewer.mode, { opened, press, mode: viewer.mode });

    // Back with ←: nothing painted.
    await page.locator('[data-act="back"]:visible').first().click();
    await page.waitForSelector(".role-card");
    await page.waitForTimeout(250);
    const back1 = await cards(page);
    await page.screenshot({ path: `${out}/${name}-3-back.png` });
    check(`${name}: back with ← every mode button is the same colour`, same(back1), back1.map(({ role, bg, border, cls }) => ({ role, bg, border, cls })));

    // A touch tap on 관전 (the pointer stays over the card), then browser back: no sticky :hover or press.
    if (view.hasTouch) {
      list = await cards(page);
      viewer = list.find((c) => c.role === "viewer");
      await watchPress(page);
      await page.touchscreen.tap(viewer.x, viewer.y);
      await page.waitForSelector(".pscore, .tv-score", { timeout: 8000 }).catch(() => {});
      const tapPress = await readPress(page);
      check(`${name}: a quick touch tap on 관전 is seen pressed, then opens`, (await page.locator(".pscore, .tv-score").count()) > 0 && tapPress?.bg === viewer.mode, { tapPress });
      await page.goBack();
      await page.waitForSelector(".role-card", { timeout: 8000 });
      await page.waitForTimeout(250);
      const back2 = await cards(page);
      await page.screenshot({ path: `${out}/${name}-4-after-tap-back.png` });
      check(`${name}: after a tap and browser back every mode button is the same colour (no sticky hover)`, same(back2), back2.map(({ role, bg, border, cls }) => ({ role, bg, border, cls })));
    }

    // Keyboard / remote: focus is an outline only; Enter shows the press, then opens.
    await page.locator(".role-card").first().focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(100);
    const foc = await cards(page);
    const f = foc.find((c) => c.focus);
    await page.screenshot({ path: `${out}/${name}-5-focus.png` });
    check(`${name}: keyboard focus only thickens the frame, same colour, no fill`, !!f && f.outline >= 2 && f.outlineColor === entry[0].border && same(foc), foc.map(({ role, bg, border, outline, outlineColor, focus }) => ({ role, bg, border, outline, outlineColor, focus })));
    if (f) {
      await watchPress(page);
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/vision\//, { timeout: 8000 }).catch(() => {});
      await page.waitForLoadState("load").catch(() => {});
      const kp = await readPress(page).catch((e) => ({ error: String(e) }));
      check(`${name}: Enter on ${f.role} shows its mode colour, then leaves the picker`, kp?.role === f.role && kp.bg === f.mode, { kp, mode: f.mode });
    }
    check(`${name}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop?.();
}
console.log(`MODE_PRESS_DONE engine=${engine} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
