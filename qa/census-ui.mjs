// bun qa/census-ui.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --port=9660 --out=<dir>
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const app = await startOneApp({ ...args, port: Number(args.port || 9660) });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const failures = [];
let checks = 0;
const check = (name, ok, detail) => {
  checks++;
  if (!ok) failures.push({ name, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`);
};
const writes = '[data-act="hist-fav"],[data-act="hist-del"],[data-act="rename-save"],[data-act="setup-edit"],[data-act="setup-new"],[data-act="setup-submit"],[data-act="camera-approve"],[data-act="camera-revoke"],[data-draft],[data-rename],[data-act="point"]:not(:disabled)';

async function open(role, withPin, device = "phone", cameras = []) {
  const ctx = await browser.newContext(DEVICES[device]);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(({ role, pin, cameras }) => {
    localStorage.setItem("pp-role", role);
    localStorage.setItem("pp-tab", "match");
    if (pin) localStorage.setItem("pp-pin", pin);
    window.WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      constructor() {
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: "presence", cameras, speaker: null }) });
        });
      }
      send() {}
      close() { this.readyState = 3; }
    };
  }, { role, pin: withPin ? app.pin : null, cameras });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push({ name: "pageerror", detail: e.message }));
  return { ctx, page };
}
const writeCount = (page) => page.locator(writes).evaluateAll((els) => els.filter((e) => e.getClientRects().length && !e.closest("[hidden]")).length);

try {
  for (const cameras of [
    [{ id: "waiting", online: true, linked: false, approved: false }],
    [{ id: "approved", online: true, linked: true, approved: true, mode: "running" }],
  ]) {
    const { ctx, page } = await open("viewer", true, "phone", cameras);
    await page.goto(app.origin);
    await page.waitForSelector(".pscore");
    check("viewer-pin-match", await writeCount(page) === 0);
    for (const tab of ["settings", "history"]) {
      await page.locator(`[data-act="tab"][data-tab="${tab}"]`).click();
      if (tab === "history") await page.waitForSelector('[data-act="hist-open"]');
      check(`viewer-pin-${tab}`, await writeCount(page) === 0);
    }
    await page.locator('[data-act="hist-open"]').first().click();
    await page.locator(".hist-bar").waitFor({ state: "attached", timeout: 10000 });
    check("viewer-pin-history-detail", await writeCount(page) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open("viewer", true);
    const state = { ...(await app.api("/api/state")), tournament: null, derived: null };
    await page.route("**/api/state", (r) => r.fulfill({ json: state }));
    await page.goto(app.origin);
    await page.waitForSelector(".roles");
    check("viewer-empty-no-setup", await writeCount(page) === 0);
    await page.locator('.roles [data-role="referee"]').click();
    check("referee-empty-can-create", await page.locator('[data-act="setup-submit"]').isVisible());
    await ctx.close();
  }
  {
    const { ctx, page } = await open("referee", true);
    await page.goto(app.origin);
    await page.waitForSelector(".pscore");
    await page.locator('[data-tab="settings"]').click();
    await page.locator('[data-act="setup-new"]').click();
    await page.locator('[data-ask="1"]').click();
    await page.waitForSelector('[data-draft="name"]');
    await page.locator('.roles [data-role="viewer"]').click();
    check("viewer-switch-closes-setup", await writeCount(page) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open("referee", false);
    await page.goto(app.origin);
    await page.waitForSelector(".pscore");
    const rev = (await app.api("/api/state")).rev;
    await page.locator('.pane[data-side="0"]').click();
    check("score-without-pin-focuses-settings", await page.locator("#pin-input").evaluate((e) => document.activeElement === e));
    check("score-without-pin-does-not-write", (await app.api("/api/state")).rev === rev);
    check("header-permission-is-status", await page.locator(".top > .chip").evaluate((e) => e.tagName === "SPAN" && e.tabIndex < 0));
    await page.locator("#pin-input").fill(app.pin);
    await page.locator("#pin-input").press("Enter");
    await page.waitForFunction((pin) => localStorage.getItem("pp-pin") === pin && document.activeElement?.id !== "pin-input", app.pin, { timeout: 10000 });
    check("settings-pin-enables-referee-controls", await page.locator('[data-act="setup-new"]').isVisible());
    check("settings-pin-never-opens-modal", await page.locator("dialog[open]").count() === 0);
    await ctx.close();
  }
  for (const device of Object.keys(DEVICES)) {
    const ctx = await browser.newContext(DEVICES[device]);
    await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
    const page = await ctx.newPage();
    await page.goto(app.origin + "/vision/");
    await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
    await page.evaluate(async () => {
      const { createUI } = await import("/vision/js/ui.js");
      const base = structuredClone(window.__ppv.state);
      document.getElementById("app").hidden = true;
      const root = document.createElement("div");
      document.getElementById("app").after(root);
      const calls = [];
      const state = { ...base, mode: "stopped", source: "file", video: { width: 960, height: 540 },
        save: { keySet: true, check: "ok", supported: true },
        tour: { ...base.tour, connected: true, ws: "online", matches: [], match: null, fix: { can: true, busy: false,
          target: { id: "fixture", no: 1, status: "live", names: ["A", "B"], log: [0, 1], score: { current: { a: 1, b: 1 }, won: [0, 0] } } } } };
      const ui = createUI(root, {
        onStartCamera: () => calls.push("camera"),
        onRetrySave: () => calls.push("retry"),
        onLeave: () => calls.push("leave"),
        onCloseHistory: () => { state.showHistory = false; ui.render(state); },
        onCalibrationCancel: () => { state.mode = "stopped"; ui.render(state); },
      });
      window.__census = { ui, state, calls, root };
      ui.render(state);
    });
    const fact = (fn) => page.evaluate(fn);
    check(`${device}-mode-status-only`, await fact(() => [...window.__census.root.querySelectorAll(".chip--role")].every((e) => e.tagName === "SPAN" && e.tabIndex < 0)));
    await page.locator("#app + div .bar button").first().click();
    check(`${device}-file-stop-starts-camera`, await fact(() => window.__census.calls.includes("camera")));
    for (const [save, kind] of [
      [{ keySet: true, check: "ok", supported: false }, "bad"],
      [{ keySet: true, check: "rejected", supported: true }, "bad"],
      [{ keySet: true, check: "unknown", supported: true }, "bad"],
      [{ keySet: true, check: null, supported: true }, "wait"],
      [{ keySet: true, check: "ok", supported: true }, "on"],
      [{ keySet: false, supported: true, keyError: "fixture" }, "off"],
    ]) {
      await page.evaluate((save) => { const c = window.__census; c.state.save = save; c.ui.render(c.state); }, save);
      check(`${device}-save-${save.check || kind}`, await page.locator("#app + div .screen__save").getAttribute("data-save-kind") === kind);
    }
    await page.evaluate(() => { const c = window.__census; c.state.mode = "intro"; c.ui.render(c.state); });
    await page.locator("#app + div .screen__privacy button[type=button]").click();
    check(`${device}-stored-pin-retry`, await fact(() => window.__census.calls.includes("retry")));
    await page.evaluate(() => { const c = window.__census; c.state.mode = "stopped"; c.ui.render(c.state); });
    await page.locator("#app + div .chip--fix").click();
    await page.evaluate(() => { const c = window.__census; c.ui.render(c.state); });
    check(`${device}-fix-opener-disabled`, await page.locator("#app + div .chip--fix").isDisabled());
    await page.evaluate(() => document.fonts.ready);
    check(`${device}-fix-controls-fit`, await page.locator("#app + div .fix__row button").evaluateAll((buttons) => buttons.every((button) => {
      const box = button.getBoundingClientRect();
      const range = document.createRange();
      const text = button.querySelector("span:not(.icon)") || button;
      range.selectNodeContents(text);
      return [...range.getClientRects()].every((r) => r.left >= box.left + 2 && r.right <= box.right - 2);
    })));
    await page.screenshot({ path: `${out}/${device}-fix.png` });
    await page.locator("#app + div .strip [data-back]").click();
    await page.evaluate(() => { const c = window.__census; c.ui.render(c.state); });
    check(`${device}-fix-back-closes`, await page.locator("#app + div .fix").isHidden());
    await page.locator("#app + div .bar button").last().click();
    check(`${device}-settings-opener-disabled`, await page.locator("#app + div .bar button").last().isDisabled());
    await page.locator("#app + div .strip [data-back]").click();
    await page.evaluate(() => { const c = window.__census; c.state.showHistory = true; c.ui.render(c.state); });
    check(`${device}-history-opener-disabled`, await page.locator("#app + div .bar button").nth(3).isDisabled());
    check(`${device}-history-one-x`, await page.locator("#app + div .sheet__head button").count() === 1 && await page.locator("#app + div .sheet__foot button").count() === 3);
    await page.locator("#app + div .strip [data-back]").click();
    await page.evaluate(() => { const c = window.__census; c.state.mode = "loading"; c.state.leaving = true; c.ui.render(c.state); });
    check(`${device}-finishing-back-disabled`, await page.locator("#app + div .screen--loading [data-back]").isDisabled());
    await ctx.close();
  }
} finally {
  await browser.close();
  await app.stop();
}
writeFileSync(`${out}/census-ui.json`, JSON.stringify({ checks, failures }, null, 2));
console.log(`CENSUS_UI_DONE checks=${checks} failures=${failures.length}`);
process.exit(failures.length ? 1 : 0);
