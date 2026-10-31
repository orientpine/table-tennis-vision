// qa/ui-r2.mjs - real-app WebKit flow with layout, type-grid and LOCK assertions in four viewports.
//
//   bun qa/ui-r2.mjs --base=http://127.0.0.1:8802/vision/ --clip=data/videos/clip12_720p60.webm \
//     --corners='[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]' \
//     --vps=p852,p659,l393,tv --tag=after --out=evidence/r2/ui
//
// Flow per viewport (same as qa/ui-webkit.mjs, real app, real file chooser, values computed from
// the clip): intro -> open file -> 4-tap calibrate -> running HUD (3 samples) -> settings -> swap
// -> stop -> history. Every step measures the DOM and screenshots; the running samples also read
// window.__ppv.state (fps, rally, players, ball.lock).
//
// Assertions (per viewport, all recorded in <out>/<tag>-<vp>-report.json):
//   tap        every visible button / label / input is >= 44x44 CSS px
//   overflow   no horizontal overflow, no visible HUD element outside the viewport
//   cover      (portrait) the video's contained content box intersects no panel
//   overlap    no two HUD panels / bars overlap each other
//   grid       every rendered text font-size sits on its pixel font's integer grid (12/10/8 px em; >= 12 px)
//   lock       the LOCK box is drawn exactly when state.ball.lock is non-null (live invariant,
//              plus an isolated drawHud call with lock set / unset)
//   live       fps > 0 in the 3 s and 4.5 s running samples and the engine produced values (rally
//              time, trail or skeleton) from the clip; lockSeen records whether a LOCK was live
//
// Corners are given in the 1920x1080 frame of OpenTTGames test_2 and mapped onto the clip's real
// size. They are the corners read from 4x zoomed crops; the set used until 2026-10-29 was up to
// 75 px off at the far end, so the app's corner snap (calib-refine.js) correctly moved those taps
// ~47 px and the old "saved == tapped" assertion failed on the real table. A portrait clip made by padding the 16:9 picture (see evidence/r2/ui/NOTES.md) is handled
// by centring the 16:9 content vertically.
import { chromium, devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || "http://127.0.0.1:8802/vision/";
const clip = args.clip || "data/videos/clip12_720p60.webm";
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const out = args.out || "evidence/r2/ui";
const tag = args.tag || "after";
const vps = (args.vps || "p852,p659,l393,tv").split(",");
const requirePoses = args.poses !== "0";
mkdirSync(out, { recursive: true });

const iphone = devices["iPhone 15"];
const PRESETS = {
  p852: { ...iphone, viewport: { width: 393, height: 852 }, portrait: true },
  p659: { ...iphone, viewport: { width: 393, height: 659 }, portrait: true },
  l393: { ...iphone, viewport: { width: 852, height: 393 }, portrait: false },
  pad: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, portrait: true },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, portrait: false },
};

// Native pixel grid of each face = its em size: the bitmap is 11/9/7/14 px tall but the em is
// 12/10/8/15 px (unitsPerEm 1200/1000/800/1500 with 100 units per bitmap pixel). A size off this
// grid puts fractional device pixels under every bitmap pixel and smears the glyphs.
const FONT_GRID = [[/Galmuri14/i, 15], [/Galmuri11/i, 12], [/Galmuri9/i, 10], [/Galmuri7/i, 8]];

// ---------- in-page measurement (serialised into the page; keep it self-contained) ----------
function measurePage() {
  const vis = (el) => {
    if (!el || el.closest("[hidden]")) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const name = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
  const W = innerWidth, H = innerHeight;

  const controls = [...document.querySelectorAll("button, [role=button], input:not([type=file]), label")].filter(vis).map((el) => ({ name: name(el), ...rect(el) }));
  const small = controls.filter((c) => c.w < 44 || c.h < 44);

  const panelSel = { glance: ".glance", status: ".status", strip: ".strip", banner: ".banner", bottom: ".bottom", bar: ".bar", calibbar: ".calibbar", calibguide: ".calibbar__guide", calibactions: ".calibbar__actions", popover: ".popover", sheet: ".sheet" };
  const panels = {};
  for (const [k, sel] of Object.entries(panelSel)) {
    const el = document.querySelector(sel);
    if (el && vis(el)) panels[k] = rect(el);
  }
  // the calibbar is `display: contents` in landscape; judge its two parts instead of the shell
  if (panels.calibguide || panels.calibactions) delete panels.calibbar;
  if (panels.calibbar) { delete panels.calibguide; delete panels.calibactions; }

  const v = document.querySelector("video");
  let video = null;
  if (v && vis(v) && v.videoWidth && v.videoHeight) {
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    video = { x: Math.round((r.left + (r.width - w) / 2) * 10) / 10, y: Math.round((r.top + (r.height - h) / 2) * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10, element: rect(v), natural: { w: v.videoWidth, h: v.videoHeight } };
  }
  const hits = (a, b) => a && b && a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  const videoCover = video ? Object.entries(panels).filter(([k, p]) => !["popover", "sheet"].includes(k) && hits(video, p)).map(([k]) => k) : [];
  const keys = Object.keys(panels).filter((k) => !["popover", "sheet"].includes(k));
  const overlaps = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (hits(panels[keys[i]], panels[keys[j]])) overlaps.push(`${keys[i]}~${keys[j]}`);
  const outside = Object.entries(panels).filter(([, p]) => p.x < -0.5 || p.y < -0.5 || p.x + p.w > W + 0.5 || p.y + p.h > H + 0.5).map(([k]) => k);
  const ctlOutside = controls.filter((c) => c.x < -0.5 || c.y < -0.5 || c.x + c.w > W + 0.5 || c.y + c.h > H + 0.5).map((c) => c.name);
  // content wider than its own panel is cut off at the panel edge (court footer, long labels)
  const clipped = [...document.querySelectorAll(".panel, .strip")].filter(vis).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => String(el.className));

  // text: every visible element that owns a non-blank text node
  const fonts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (!vis(el)) continue;
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
    own = own.trim();
    if (!own) continue;
    const cs = getComputedStyle(el);
    const size = Math.round(parseFloat(cs.fontSize) * 1000) / 1000;
    const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    fonts.push({ text: own.replace(/\s+/g, " ").slice(0, 20), tag: el.tagName.toLowerCase(), cls: (el.className && String(el.className)).split(" ")[0] || "", size, family, weight: cs.fontWeight, korean: /[\uAC00-\uD7A3]/.test(own) });
  }
  const overlay = document.querySelector(".stage__overlay");
  const canvasFonts = overlay ? (overlay.dataset.fonts || "") : "";
  const canvasFamily = overlay ? (overlay.dataset.font || "") : "";
  const state = window.__ppv && window.__ppv.state;
  return {
    viewport: { w: W, h: H, dpr: devicePixelRatio, visual: window.visualViewport ? Math.round(window.visualViewport.height) : null },
    layout: document.querySelector(".app")?.getAttribute("data-layout"), fit: document.querySelector(".app")?.getAttribute("data-fit"), mode: state && state.mode,
    controls: controls.length, small, clipped, hOverflow: document.documentElement.scrollWidth > W, vOverflow: document.documentElement.scrollHeight > H,
    panels, video, videoCover, overlaps, outside, ctlOutside, fonts, canvasFonts, canvasFamily,
    lock: { state: !!(state && state.ball && state.ball.lock), drawn: overlay ? overlay.dataset.lock || "" : "" },
  };
}

function gridOf(family) {
  for (const [re, g] of FONT_GRID) if (re.test(family)) return g;
  return null;
}
function fontFindings(fonts) {
  const off = [], nonPixel = [], tooSmall = [];
  const seen = new Map();
  for (const f of fonts) {
    const g = gridOf(f.family);
    const key = `${f.family}|${f.size}|${f.weight}`;
    const n = f.size / (g || 1);
    const onGrid = g != null && Math.abs(n - Math.round(n)) < 1e-6;
    if (!seen.has(key)) seen.set(key, { family: f.family, size: f.size, weight: f.weight, grid: g, onGrid, count: 0, example: f.text });
    seen.get(key).count++;
    if (g == null) nonPixel.push(f); else if (!onGrid) off.push(f);
    if (f.size < 12) tooSmall.push(f);
  }
  return { sizes: [...seen.values()].sort((a, b) => a.size - b.size), offGrid: off.slice(0, 12), offGridCount: off.length, nonPixel: nonPixel.slice(0, 12), nonPixelCount: nonPixel.length, tooSmall: tooSmall.slice(0, 12), tooSmallCount: tooSmall.length };
}

async function runViewport(vp) {
  const preset = PRESETS[vp];
  if (!preset) throw new Error(`unknown viewport ${vp}`);
  const { portrait, ...ctxOpts } = preset;
  const hasTouch = !!ctxOpts.hasTouch;
  // --engine=chromium runs the same flow where WebKit cannot launch (this host has no
  // libavif.so.16 / libbacktrace.so.0); the Safari engine stays the default.
  const browser = args.engine === "chromium"
    ? await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
    : await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
    if (m.text().startsWith("ppv:")) console.log("PAGE", m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const steps = [];
  const asserts = { tap: [], overflow: [], cover: [], overlap: [], grid: [], lock: [], live: [], stand: [], ballColor: [] };
  const shot = (nm) => page.screenshot({ path: `${out}/${tag}-${vp}-${nm}.png` });
  const step = async (nm, fn) => {
    try {
      const detail = await fn();
      steps.push({ name: nm, pass: true, detail });
    } catch (err) {
      steps.push({ name: nm, pass: false, detail: String(err && err.stack || err).split("\n").slice(0, 3).join(" | ") });
    }
    await shot(`${String(steps.length).padStart(2, "0")}-${nm}`);
  };
  const st = () => page.evaluate(() => window.__ppv.state);
  const waitMode = (modes, timeout = 120000) => page.waitForFunction((m) => m.includes(window.__ppv?.state.mode), modes, { timeout });
  const measure = () => page.evaluate(measurePage);
  const tapAt = (x, y) => (hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  const tapLoc = (loc, opts) => (hasTouch ? loc.tap(opts) : loc.click(opts));
  // Every measurement feeds the per-viewport assertion ledger; `where` names the screen.
  const judge = (where, m, { cover = portrait, grid = true } = {}) => {
    const f = fontFindings(m.fonts);
    asserts.tap.push({ where, pass: m.small.length === 0 && m.ctlOutside.length === 0, small: m.small, outside: m.ctlOutside });
    asserts.overflow.push({ where, pass: !m.hOverflow && m.outside.length === 0 && m.clipped.length === 0, hOverflow: m.hOverflow, outside: m.outside, clipped: m.clipped });
    if (cover) asserts.cover.push({ where, pass: m.videoCover.length === 0, videoCover: m.videoCover, video: m.video && { x: m.video.x, y: m.video.y, w: m.video.w, h: m.video.h }, panels: m.panels });
    asserts.overlap.push({ where, pass: m.overlaps.length === 0, overlaps: m.overlaps });
    if (grid) asserts.grid.push({ where, pass: f.offGridCount === 0 && f.nonPixelCount === 0 && f.tooSmallCount === 0, ...f, canvasFonts: m.canvasFonts, canvasFamily: m.canvasFamily });
    return { ...m, fonts: undefined, fontSummary: f.sizes };
  };

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.fonts.status === "loaded" || document.fonts.check("11px Galmuri11"), null, { timeout: 10000 }).catch(() => {});
  await step("intro", async () => judge("intro", await measure(), { cover: false }));
  await step("open-file", async () => {
    const chooser = page.waitForEvent("filechooser");
    await tapLoc(page.locator(".screen--intro label.btn--file"));
    await (await chooser).setFiles(clip);
    await waitMode(["calibrating", "running", "error"]);
    const s = await st();
    if (s.mode === "error") throw new Error(JSON.stringify(s.error));
    return { mode: s.mode, video: s.video };
  });
  let k = 1, oy = 0;
  await step("calibrate-4-taps", async () => {
    const s0 = await st();
    if (s0.mode !== "calibrating") await tapLoc(page.getByRole("button", { name: /코트 보정/ }));
    await waitMode(["calibrating"], 10000);
    const { width: vw, height: vh } = (await st()).video;
    k = vw / 1920;
    oy = vh > vw ? (vh - 1080 * k) / 2 : 0; // padded portrait test clip: 16:9 picture centred vertically
    const before = judge("calibrating", await measure(), { cover: false });
    for (const c of corners) {
      const pt = await page.evaluate(([x, y]) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * s) / 2 + x * s, y: r.top + (r.height - v.videoHeight * s) / 2 + y * s };
      }, [c.x * k, c.y * k + oy]);
      await tapAt(pt.x, pt.y);
      await page.waitForTimeout(200);
    }
    await shot("03b-calibrate-4-placed");
    // The steps from here to Stop take longer than the whole 12 s clip, and the app stops itself at
    // a file's end, so Stop sometimes met a stopped app. Loop the test clip from the start for this
    // session (the app opens files with loop=false; end-of-file-stop below reopens it and tests the
    // self-stop on its own).
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) { v.currentTime = 0; v.loop = true; } });
    await tapLoc(page.getByRole("button", { name: /확인/ }), { timeout: 5000 });
    try {
      await waitMode(["running"], 10000);
    } catch (err) {
      const diag = await page.evaluate(() => {
        const v = document.querySelector("video");
        const s = window.__ppv.state;
        return { mode: s.mode, calibration: !!s.calibration, error: s.error, paused: v.paused, currentTime: v.currentTime, ended: v.ended, readyState: v.readyState, mediaError: v.error && v.error.code };
      });
      throw new Error(`not running after confirm: ${JSON.stringify(diag)}`);
    }
    const got = (await st()).calibration.corners;
    const err = Math.max(...got.map((g, i) => Math.hypot(g.x - corners[i].x * k, g.y - (corners[i].y * k + oy))));
    const videoPxPerCssPx = await page.evaluate(() => {
      const v = document.querySelector("video");
      const r = v.getBoundingClientRect();
      return 1 / Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    });
    const errCss = err / videoPxPerCssPx;
    // The fourth tap snaps the corners onto the table's white border, so the saved corners sit a
    // few px from the taps; more than 8 px (1080p scale) means a wrong snap, not a refinement.
    if (err > 8 * k) throw new Error(`corner error ${err.toFixed(2)} video px = ${errCss.toFixed(2)} CSS px`);
    return { maxCornerErrorVideoPx: Math.round(err * 100) / 100, maxCornerErrorCssPx: Math.round(errCss * 100) / 100, calibrating: before };
  });
  await step("running-hud", async () => {
    // three samples 1.5 s apart: the 12 s clip must still be playing for swap and stop afterwards
    const samples = [];
    let measured = null;
    for (const [i, at] of [1.5, 3, 4.5].entries()) {
      await page.waitForTimeout(1500);
      // one evaluate: state and the overlay's data-lock come from the same frame
      const m = await measure();
      const s = await st();
      const media = await page.evaluate(() => {
        const v = document.querySelector("video");
        return { paused: v.paused, readyState: v.readyState, currentTime: Math.round(v.currentTime * 100) / 100, error: v.error && v.error.code };
      });
      const lock = { state: m.lock.state, drawn: m.lock.drawn === "1" };
      // standing position: the court map shows a dot per player with a stand in state, the
      // overlay draws only stands that are in state (one on screen may be clipped off the picture)
      const standView = await page.evaluate(() => ({
        court: [...document.querySelectorAll(".court__svg .cm-stand")].map((c) => c.getAttribute("class")),
        drawn: document.querySelector(".stage__overlay").dataset.stands || "",
        dist: [...document.querySelectorAll(".court__dist")].map((d) => d.textContent),
        // read in the same task as the DOM: a separate evaluate can land on another frame
        stands: Object.fromEntries(["near", "far"].map((p) => { const st = window.__ppv.state.players[p].stand; return [p, st ? { behindM: Math.round(st.behindM * 100) / 100, sideM: Math.round(st.sideM * 100) / 100, stale: st.stale } : null]; })),
      }));
      const stState = standView.stands;
      const nState = ["near", "far"].filter((p) => stState[p]).length;
      const drawnSides = standView.drawn ? standView.drawn.split("|").map((x) => x.split(":")[0]) : [];
      asserts.stand.push({ where: `run-${at}s`, pass: standView.court.length === nState && drawnSides.every((p) => stState[p]), state: stState, court: standView.court, drawn: standView.drawn, dist: standView.dist });
      asserts.lock.push({ where: `run-${at}s`, pass: lock.state === lock.drawn, ...lock, lockValue: s.ball && s.ball.lock ? { side: s.ball.lock.side, speedKmh: s.ball.lock.speedKmh } : null });
      const hud = {
        rallyTimeMs: Math.round(s.rally.timeMs), shots: s.rally.shots, speedKmh: s.rally.speedKmh,
        bounces: s.bounces.map((b) => b.side), lastShot: s.lastShot && s.lastShot.label, tracking: s.tracking ?? null, calibrationIssue: s.calibrationIssue ?? null,
        near: { moveM: s.players.near.moveM, wristDeg: s.players.near.wristDeg ?? null, wristKmh: s.players.near.wristKmh, shotKmh: s.players.near.shotKmh },
        far: { moveM: s.players.far.moveM, wristDeg: s.players.far.wristDeg ?? null, wristKmh: s.players.far.wristKmh, shotKmh: s.players.far.shotKmh },
      };
      samples.push({ at, videoTime: media.currentTime, fps: s.perf.fps, shots: s.rally.shots, trail: s.ball.trail.length, poses: ["near", "far"].filter((p) => s.players[p].landmarks).length, media, hud });
      if (i === 1) measured = judge("running", m);
      await shot(`run-${i + 1}`);
    }
    // fps is a 1 s moving count that app.js only starts once running begins, so the first sample
    // (1.5 s in) may still read 0; the later two must not
    const livePass = samples.slice(1).every((x) => x.fps > 0) && samples.some((x) => x.trail > 0 || x.hud.rallyTimeMs > 0) && (!requirePoses || samples.some((x) => x.poses >= 1));
    const lockSeen = asserts.lock.some((l) => l.where.startsWith("run-") && l.state);
    // the clip shows both players' feet, so a stand must have been computed and drawn at least once
    if (requirePoses) asserts.stand.push({ where: "running-seen", pass: asserts.stand.some((x) => x.court.length > 0 && x.drawn) });
    asserts.live.push({ where: "running", pass: livePass, lockSeen, samples: samples.map((x) => ({ at: x.at, fps: x.fps, trail: x.trail, poses: x.poses, shots: x.shots, rallyTimeMs: x.hud.rallyTimeMs, tracking: x.hud.tracking })) });
    if (!livePass) throw new Error(`no live processing: ${JSON.stringify(samples)}`);
    return { samples, measured };
  });
  await step("settings", async () => {
    await tapLoc(page.getByRole("button", { name: /설정/ }).first(), { timeout: 5000 });
    await page.waitForSelector(".popover:not([hidden])", { timeout: 5000 });
    // The popover owns its scroll (a short landscape screen cannot show every field). A control
    // counts as off screen only if scrolling the popover to its end does not bring it in view.
    const top = await measure();
    await shot("05b-settings-open");
    await page.locator(".popover").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const end = await measure();
    await shot("05c-settings-scrolled");
    // A control in the middle of a long popover is off screen at both the top and the end; it
    // counts as unreachable only if scrolling it into view inside the popover still leaves it out.
    const both = top.ctlOutside.filter((n) => end.ctlOutside.includes(n));
    const unreachable = await page.evaluate((names) => {
      const pop = document.querySelector(".popover");
      const out = [];
      for (const nm of names) {
        const el = [...pop.querySelectorAll("button, input, label")].find((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) === nm);
        if (!el) { out.push(nm); continue; }
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push(nm);
      }
      return out;
    }, both);
    await page.locator(".popover").evaluate((el) => { el.scrollTop = 0; });
    const m = judge("settings", { ...top, ctlOutside: unreachable, small: [...new Set([...top.small, ...end.small])] }, { cover: false });
    // ball colour: 주황 switches the engine's detector, is saved, and 흰색 switches back
    const group = page.getByRole("group", { name: "공 색" });
    const color = () => page.evaluate(() => ({ state: window.__ppv.state.ballColor, detector: window.__ppv.pipeline?.detector?.color ?? null, saved: localStorage.getItem("ppv.ballColor") }));
    const startColor = await color();
    const orangeBtn = group.getByRole("button", { name: "주황" });
    await orangeBtn.scrollIntoViewIfNeeded();
    const box = await orangeBtn.boundingBox();
    await tapLoc(orangeBtn);
    const orange = { ...(await color()), pressed: await orangeBtn.getAttribute("aria-pressed") };
    await shot("05d-settings-orange");
    await tapLoc(group.getByRole("button", { name: "흰색" }));
    const white = await color();
    asserts.ballColor.push({
      where: "settings", startColor, orange, white, box,
      pass: startColor.state === "white" && orange.state === "orange" && orange.detector === "orange" && orange.saved === '"orange"' && orange.pressed === "true" && white.state === "white" && white.detector === "white" && box && box.width >= 44 && box.height >= 44,
    });
    await page.locator(".popover").evaluate((el) => { el.scrollTop = 0; });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".popover[hidden]", { state: "attached", timeout: 5000 });
    return m;
  });
  await step("swap-players", async () => {
    // since the sides merge (vision #44) red and blue stay at their ends: an unlinked swap trades the
    // players' own settings (racket hand, MOVE) between the ends and says so; tracking stays per end
    const read = () => page.evaluate(() => { const p = window.__ppv.pipeline.players; return { near: { hand: p.near.hand, moveM: p.near.moveM }, far: { hand: p.far.hand, moveM: p.far.moveM } }; });
    const before = await read();
    await tapLoc(page.getByRole("button", { name: /자리 교체/ }));
    const notice = await page.waitForFunction(() => { const t = document.querySelector(".toast.show"); return t && /자리 교체/.test(t.textContent) && t.textContent; }, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => null);
    const after = await read();
    const traded = after.near.hand === before.far.hand && after.far.hand === before.near.hand && after.near.moveM === before.far.moveM && after.far.moveM === before.near.moveM;
    if (!notice || !traded) throw new Error(`swap not seen: ${JSON.stringify({ notice, before, after })}`);
    return { before, after, notice };
  });
  await step("stop", async () => {
    // Stop is tapped on every run; the looping clip keeps the app running until then.
    const media = await page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, loop: v.loop, ended: v.ended }; });
    if (media.ended || (await st()).mode !== "running") throw new Error(`app not running before Stop: ${JSON.stringify(media)}`);
    await tapLoc(page.getByRole("button", { name: /정지/ }).first(), { timeout: 5000 });
    await waitMode(["stopped"], 5000);
    return { videoTimeAtStop: Math.round(media.t * 10) / 10, ...judge("stopped", await measure()) };
  });
  await step("history", async () => {
    await tapLoc(page.getByRole("button", { name: /기록/ }).first(), { timeout: 5000 });
    await page.waitForFunction(() => window.__ppv.state.showHistory, null, { timeout: 5000 });
    const m = judge("history", await measure(), { cover: false });
    return { rallies: (await st()).history.length, ...m };
  });
  // Isolated drawHud check: the live clip may never produce a lock before the engine lane merges,
  // so prove the code path with the module itself (not screen evidence; the live invariant above is).
  await step("hud-lock-unit", async () => {
    const r = await page.evaluate(async (href) => {
      const mod = await import(new URL("./js/hud.js", href).href);
      // mirror the app: backing store = CSS px x devicePixelRatio (3 on the phone presets, 1 on tv)
      const dpr = window.devicePixelRatio || 1;
      const c = document.createElement("canvas");
      c.width = 300 * dpr; c.height = 200 * dpr; c.style.width = "300px"; c.style.height = "200px";
      document.body.append(c);
      const ctx = c.getContext("2d");
      const id = (p) => ({ x: p.x / 3, y: p.y / 3 });
      const base = { mode: "running", layout: "phone", calibration: null, players: {}, ball: { trail: [], current: null, lock: null }, lastShot: null };
      const a = mod.drawHud(ctx, { ...base, ball: { trail: [], current: { x: 450, y: 300 }, lock: { x: 450, y: 300, id: 1, speedKmh: 27.4, side: "far" } } }, id);
      const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      const drawnAt = a && a.lock ? px(Math.round((a.lock.x + 2) * dpr), Math.round((a.lock.y + 2) * dpr)) : null;
      const b = mod.drawHud(ctx, { ...base, ball: { trail: [], current: { x: 450, y: 300 }, lock: null } }, id);
      let painted = 0;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) painted++;
      c.remove();
      return { withLock: a && a.lock, drawnAt, withoutLock: b && b.lock, paintedWithoutLock: painted };
    }, base);
    const pass = !!(r.withLock && r.drawnAt && r.drawnAt[3] > 0) && !r.withoutLock;
    asserts.lock.push({ where: "unit", pass, ...r });
    if (!pass) throw new Error(`lock unit: ${JSON.stringify(r)}`);
    return r;
  });
  await step("end-of-file-stop", async () => {
    // A file must stop the app by itself when it ends. Reopen the clip (the saved calibration is
    // restored, so it runs straight away), jump to 1.5 s before the end and wait for the stop.
    await page.locator('input[type="file"]').first().setInputFiles(clip);
    try {
      await waitMode(["running"], 30000);
    } catch (err) {
      const diag = await page.evaluate(() => {
        const v = document.querySelector("video");
        const s = window.__ppv.state;
        return { mode: s.mode, source: s.source, error: s.error, calibration: !!s.calibration, showHistory: s.showHistory, inputs: document.querySelectorAll('input[type="file"]').length, paused: v.paused, readyState: v.readyState, currentTime: v.currentTime, mediaError: v.error && v.error.code, src: (v.currentSrc || "").slice(0, 30) };
      });
      throw new Error(`reopened file not running: ${JSON.stringify(diag)}`);
    }
    await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = Math.max(0, v.duration - 1.5); });
    await waitMode(["stopped"], 10000);
    const ended = await page.evaluate(() => document.querySelector("video").ended);
    if (!ended) throw new Error("stopped, but the video did not reach its end");
    return { ended, mode: (await st()).mode };
  });
  await step("ball-color-persists", async () => {
    // the choice survives a reload and is the engine's colour from the first frame
    await page.evaluate(() => localStorage.setItem("ppv.ballColor", '"orange"'));
    await page.reload({ waitUntil: "networkidle" });
    const after = await page.evaluate(() => window.__ppv.state.ballColor);
    asserts.ballColor.push({ where: "reload", pass: after === "orange", after });
    if (after !== "orange") throw new Error(`after reload ballColor=${after}`);
    // the test clip has a white ball: with orange chosen the strip says "공 색이 흰색 같아요"
    await page.locator('input[type="file"]').first().setInputFiles(clip);
    // after a reload the pose model loads again (over the public URL that took over 30 s)
    await waitMode(["running"], 120000);
    const hint = await page.waitForFunction(() => {
      const c = [...document.querySelectorAll(".strip .chip, .stage__chips .chip")].find((n) => !n.closest("[hidden]") && /공 색이 흰색/.test(n.textContent));
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { text: c.textContent, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, lockedOrange: !!window.__ppv.state.ball.lock };
    }, null, { timeout: 9000 }).then((h) => h.jsonValue()).catch(() => null);
    const hintScreen = hint ? judge("orange-hint", await measure()) : null;
    await shot("11b-orange-on-white-hint");
    await page.evaluate(() => localStorage.setItem("ppv.ballColor", '"white"'));
    asserts.ballColor.push({ where: "hint", pass: !!(hint && hint.inView), hint });
    return { after, hint, overflow: hintScreen && { clipped: hintScreen.clipped, outside: hintScreen.outside } };
  });
  await browser.close();
  const summary = Object.fromEntries(Object.entries(asserts).map(([k, v]) => [k, v.length ? (v.every((x) => x.pass) ? "PASS" : "FAIL") : "N/A"]));
  const report = { base, clip, tag, vp, viewport: preset.viewport, portrait, steps, asserts, summary, consoleErrors };
  writeFileSync(`${out}/${tag}-${vp}-report.json`, JSON.stringify(report, null, 2));
  console.log(`UI_R2 ${tag} ${vp} ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")} | ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" ")} consoleErrors=${consoleErrors.length}`);
  for (const s of steps) if (!s.pass) console.log("FAIL", vp, s.name, s.detail);
  for (const [k, v] of Object.entries(asserts)) for (const x of v) if (!x.pass) console.log("ASSERT", vp, k, x.where, JSON.stringify(x).slice(0, 400));
  return report;
}

// A loaded host (another browser run, someone else's test suite) can stall the model load or the
// media element before the HUD ever shows; that is infrastructure, so such a run is retried once.
const infra = (report) => report.steps.some((s) => !s.pass && (s.name === "open-file" || s.name === "calibrate-4-taps"));
const all = {};
for (const vp of vps) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const report = await runViewport(vp);
      all[vp] = { ...report.summary, attempt };
      if (!infra(report)) break;
      console.log(`RETRY ${vp}: flow stalled before the HUD (attempt ${attempt})`);
    } catch (err) {
      all[vp] = { error: String(err && err.message || err), attempt };
      console.log("CRASH", vp, err && err.stack);
    }
  }
}
writeFileSync(`${out}/${tag}-summary.json`, JSON.stringify(all, null, 2));
console.log("SUMMARY", JSON.stringify(all));
