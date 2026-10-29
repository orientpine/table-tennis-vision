// qa/ui-r2.mjs - real-app WebKit flow with layout, type-grid and LOCK assertions in four viewports.
//
//   bun qa/ui-r2.mjs --base=http://127.0.0.1:8802/vision/ --clip=data/videos/clip12_720p60.webm \
//     --corners='[{"x":356,"y":634},{"x":482,"y":520},{"x":1370,"y":532},{"x":1484,"y":660}]' \
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
// size. A portrait clip made by padding the 16:9 picture (see evidence/r2/ui/NOTES.md) is handled
// by centring the 16:9 content vertically.
import { devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const base = args.base || "http://127.0.0.1:8802/vision/";
const clip = args.clip || "data/videos/clip12_720p60.webm";
const corners = JSON.parse(args.corners || '[{"x":356,"y":634},{"x":482,"y":520},{"x":1370,"y":532},{"x":1484,"y":660}]');
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
    controls: controls.length, small, hOverflow: document.documentElement.scrollWidth > W, vOverflow: document.documentElement.scrollHeight > H,
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
  const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
    if (m.text().startsWith("ppv:")) console.log("PAGE", m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const steps = [];
  const asserts = { tap: [], overflow: [], cover: [], overlap: [], grid: [], lock: [], live: [] };
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
    asserts.overflow.push({ where, pass: !m.hOverflow && m.outside.length === 0, hOverflow: m.hOverflow, outside: m.outside });
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
    if (errCss > 1.5) throw new Error(`corner error ${err.toFixed(2)} video px = ${errCss.toFixed(2)} CSS px`);
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
    await page.locator(".popover").evaluate((el) => { el.scrollTop = 0; });
    const m = judge("settings", { ...top, ctlOutside: top.ctlOutside.filter((n) => end.ctlOutside.includes(n)), small: [...new Set([...top.small, ...end.small])] }, { cover: false });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".popover[hidden]", { state: "attached", timeout: 5000 });
    return m;
  });
  await step("swap-players", async () => {
    const before = await page.evaluate(() => window.__ppv.pipeline.players.swapped);
    await tapLoc(page.getByRole("button", { name: /선수 바꾸기/ }));
    const after = await page.evaluate(() => window.__ppv.pipeline.players.swapped);
    if (before === after) throw new Error("swap flag unchanged");
    return { before, after };
  });
  await step("stop", async () => {
    await tapLoc(page.getByRole("button", { name: /정지/ }).first(), { timeout: 5000 });
    await waitMode(["stopped"], 5000);
    return judge("stopped", await measure());
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
