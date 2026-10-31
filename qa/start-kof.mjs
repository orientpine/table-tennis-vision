// The start screen's title entrance and rally, in Chromium with the real pixel font (this host's
// headless WebKit cannot decode woff2). Per viewport: the title's fit after the entrance (no text
// clipped, wrapped, or past the screen, outline included, no page scroll even while the letters are
// scaled up), entrance frames and the final frame (animations paused at fixed times), and the rally
// sampled every frame while the camera turns, from the canvas pixels (the opaque ball-yellow block) against the net line
// projected by the page's own camera: the ball's bottom must be above the net tape wherever it
// crosses, every crossing alternates courts, and players and ball stay inside the stage (the gap
// between title and button). Scene captures (serve, rally, smash, final) are drawn at fixed loop times
// through the canvas's draw hook. Phone: 4x CPU throttle keeps >= 40 drawn frames a second, and a
// hidden tab draws nothing. Reduced motion: no animation, one still picture of the smash.
//   bun qa/start-kof.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9640]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const VIEWS = {
  phone: DEVICES.phone,
  p360: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  land: DEVICES.land,
  pad: DEVICES.pad,
  tv: DEVICES.tv,
};
const ENTRANCE_MS = [0, 140, 300, 520];
// The title's own letters as a share of the screen width: the star of a phone and of a TV.
const TITLE_SHARE = { phone: [0.85, 0.92], p360: [0.85, 0.92], land: [0.3, 0.5], pad: [0.5, 0.92], tv: [0.45, 0.5] };
const MOMENTS = { serve: 0.86, rally: 2.55, smash: 5.0, final: 6.9 };
const ORBIT = [0, 90, 180, 270];
const FINAL_MS = 1000;
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9640) });
const browser = await chromium.launch();
const fails = [];
const results = {};
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); if (!ok) fails.push(name); };

// Hold the rally's animation loop on demand so a page screenshot shows the exact sampled frame.
const holdRaf = () => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__raf = raf;
  window.__held = [];
  window.requestAnimationFrame = (f) => raf((t) => (window.__hold ? window.__held.push(f) : f(t)));
};

const seek = (page, ms) => page.evaluate((ms) => {
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
}, ms);

const fit = (page) => page.evaluate(() => {
  const logo = document.querySelector(".start-logo");
  const lines = [...logo.querySelectorAll(".ln canvas")];
  const rows = lines.map((c) => {
    const r = c.getBoundingClientRect();
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let inked = 0, x0 = 1e9, x1 = -1;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i]) inked++;
      if (d[i - 3] === 9 && d[i - 2] === 10 && d[i - 1] === 36 && d[i]) { const x = ((i - 3) / 4) % c.width; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), inked, inkW: ((x1 - x0 + 1) / c.width) * r.width };
  });
  const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const stage = document.querySelector(".start-stage").getBoundingClientRect();
  const stageOverlaps = [".start-logo", ".start-press", ".start-go"].filter((s) => hit(stage, document.querySelector(s).getBoundingClientRect()));
  const parts = [...document.querySelectorAll(".start-rally, .start-press, .start-go")].map((e) => {
    const r = e.getBoundingClientRect();
    return { cls: e.className, outside: r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight, clipped: e.scrollWidth > e.clientWidth + 1 };
  });
  return {
    vw: innerWidth, vh: innerHeight,
    drawn: rows.length === 2 && rows.every((r) => r.inked > 2000),
    rows,
    titleOutside: rows.filter((r) => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight).length,
    titleWidthShare: Math.round((Math.max(...rows.map((r) => r.inkW)) / innerWidth) * 1000) / 1000,
    partsOutside: parts.filter((p) => p.outside).length,
    partsClipped: parts.filter((p) => p.clipped).length,
    stageOverlaps, stageH: Math.round(stage.height),
    scroll: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
    btnH: Math.round(document.querySelector(".start-go").getBoundingClientRect().height),
  };
});

// Every drawn frame: the ball's pixels on the canvas (an opaque ball-yellow block at least 2x2, so the
// 1 px smash spark in the same colour is not taken for it), the net tape projected by the page's camera
// for that frame, and the scene time from the canvas's hook.
const sampleRally = (page, ms) => page.evaluate(async (ms) => {
  const m = await import("/start.js");
  const c = document.querySelector(".start-rally");
  const g = c.getContext("2d", { willReadFrequently: true });
  const st = c.parentElement.querySelector(".start-stage").getBoundingClientRect(), box = c.getBoundingClientRect();
  const k = c.width / box.width, S = { x0: (st.left - box.left) * k, y0: (st.top - box.top) * k, x1: (st.right - box.left) * k, y1: (st.bottom - box.top) * k };
  const isBall = (d, i) => d[i] === 255 && d[i + 1] === 211 && d[i + 2] === 77;
  const frames = [];
  let last = -1;
  return new Promise((done) => {
    const t0 = performance.now();
    const step = () => {
      const s = c.rally.scene;
      if (s.frames !== last) {
        last = s.frames;
        const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height - 1; y++) for (let x = 0; x < W - 1; x++) {
          const i = (y * W + x) * 4;
          if (isBall(d, i) && isBall(d, i + 4) && isBall(d, i + W * 4) && isBall(d, i + W * 4 + 4)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
        }
        const [l, r] = m.netEnds(s.cam), w = m.ballAt(s.t, s.sc);
        let outside = 0;
        for (const who of ["near", "far"]) {
          const p = m.poseAt(who, s.t, s.sc), pts = [m.project(s.cam, p.x, p.y, 0), m.project(s.cam, p.x, p.y, 1.9 + p.jump)];
          if (m.inPlay(w)) pts.push(m.project(s.cam, w.x, w.y, w.z));
          for (const q of pts) if (q.x < S.x0 - 1 || q.x > S.x1 + 1 || q.y < S.y0 - 1 || q.y > S.y1 + 1) outside++;
        }
        frames.push({ t: s.t, scene: m.SCENES.indexOf(s.sc), end: s.sc.end, touch: s.sc.nodes.find((n) => n.net)?.t, deg: s.cam.deg, camY: s.cam.c.y, ball: x1 >= 0 ? { x0, y0, x1, y1 } : null, net: { lx: l.x, ly: l.y, rx: r.x, ry: r.y }, w, outside });
      }
      if (performance.now() - t0 < ms) window.__raf(step);
      else {
        const live = frames.filter((f) => f.t < f.end);
        // Seen from the side the net has no width on screen, so the pixel test needs the camera near an end
        // (from the side, the frame test holds the flight in table metres); a net-in touches on purpose.
        const through = live.filter((f) => {
          if (!f.ball || Math.abs(f.w.y) > 0.08 || Math.abs(Math.sin((f.deg * Math.PI) / 180)) > 0.26 || Math.abs(f.t - (f.touch ?? -9)) < 0.09) return false;
          const cx = (f.ball.x0 + f.ball.x1) / 2;
          if (cx < Math.min(f.net.lx, f.net.rx) || cx > Math.max(f.net.lx, f.net.rx)) return false;
          return f.ball.y1 + 1 > f.net.ly + ((cx - f.net.lx) * (f.net.ry - f.net.ly)) / (f.net.rx - f.net.lx);
        });
        let crossings = 0;
        const bounces = [];
        for (let i = 1; i < live.length; i++) {
          if (live[i].scene !== live[i - 1].scene) { bounces.push("|"); continue; }
          if (live[i - 1].w.y * live[i].w.y < 0) crossings++;
          const p = live[i - 1].w, q = live[i].w, n = live[i + 1]?.w;
          if (n && q.z < p.z && q.z <= n.z && Math.abs(q.x) <= 0.7625 && Math.abs(q.y) <= 1.37 && Math.abs(q.y) > 0.02) bounces.push(q.y < 0 ? "L" : "R");
        }
        // Near the net the ball is never behind a player, so there it must be on screen in every frame.
        const missing = live.filter((f) => !f.ball && Math.abs(f.w.y) < 0.5 && f.t > 0.4);
        done({ frames: frames.length, missingBall: missing.length, missingAt: missing.slice(0, 6).map((f) => ({ t: Math.round(f.t * 100) / 100, scene: f.scene, deg: Math.round(f.deg), y: Math.round(f.w.y * 100) / 100, z: Math.round(f.w.z * 100) / 100, camY: Math.round(f.camY * 10) / 10 })), through: through.length, crossings, bounces: bounces.join(""), outsideStage: frames.reduce((a, f) => a + f.outside, 0) });
      }
    };
    window.__raf(step);
  });
}, ms);

try {
  for (const [name, device] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext({ ...device, reducedMotion: "no-preference" });
    await ctx.addInitScript(holdRaf);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(app.origin + "/");
    await page.waitForSelector(".start-go");
    await page.evaluate(() => document.fonts.ready);
    const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.animationName === "start-slam").length);
    const scrollDuring = [];
    for (const ms of ENTRANCE_MS) {
      await seek(page, ms);
      scrollDuring.push(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1));
      await page.screenshot({ path: `${out}/${name}-entrance-${String(ms).padStart(4, "0")}ms.png` });
    }
    await seek(page, FINAL_MS);
    const m = await fit(page);
    await page.screenshot({ path: `${out}/${name}-final.png` });
    await seek(page, 1100 + 4000 * 0.12);
    await page.screenshot({ path: `${out}/${name}-shine.png` });
    await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
    const rally = await sampleRally(page, 9000);
    await page.evaluate(() => { window.__hold = true; });
    const stills = await page.evaluate(async () => (await import("/start.js")).SCENES.map((s) => s.still));
    for (const [scene, r] of Object.entries(MOMENTS)) {
      await page.evaluate((r) => document.querySelector(".start-rally").rally.draw(r, 0, 0), r);
      await page.screenshot({ path: `${out}/${name}-scene-${scene}.png` });
    }
    for (const [i, r] of stills.entries()) {
      await page.evaluate(([r, i]) => document.querySelector(".start-rally").rally.draw(r, i, 0), [r, i]);
      await page.screenshot({ path: `${out}/${name}-point${i + 1}-deciding.png` });
    }
    // The drop shot's deciding moment from the side as well: that is where the ball used to sit behind the
    // near player who lunges in.
    for (const deg of [90, 225]) {
      await page.evaluate(([r, deg]) => document.querySelector(".start-rally").rally.draw(r, 3, deg), [stills[3], deg]);
      await page.screenshot({ path: `${out}/${name}-point4-deciding-orbit-${deg}.png` });
    }
    for (const deg of ORBIT) {
      await page.evaluate(([r, deg]) => document.querySelector(".start-rally").rally.draw(r, 0, deg), [MOMENTS.rally, deg]);
      await page.screenshot({ path: `${out}/${name}-orbit-${deg}.png` });
    }
    await page.evaluate(() => { window.__hold = false; for (const f of window.__held.splice(0)) window.__raf(f); });
    // Three frames in a row mid-turn, and how many new views a second the camera gets.
    const steps = await page.evaluate(() => new Promise((done) => {
      const c = document.querySelector(".start-rally"), g = c.getContext("2d"), s0 = c.rally.scene;
      const shots = [], data = [], views = [s0.cam.deg], t0 = performance.now();
      const step = () => {
        const s = c.rally.scene, last = shots.length < 3 ? s.frames : -1;
        if (s.cam.deg !== views.at(-1)) views.push(s.cam.deg);
        if (shots.length < 3 && last !== window.__f) { window.__f = last; shots.push(c.toDataURL()); data.push(g.getImageData(0, 0, c.width, c.height).data); }
        if (performance.now() - t0 < 3000) { window.__raf(step); return; }
        const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n; };
        done({ shots, changed: [changed(data[0], data[1]), changed(data[1], data[2])], viewsPerS: Math.round((views.length - 1) / 3), stepDeg: Math.round(((views.at(-1) - views[0]) / Math.max(1, views.length - 1)) * 100) / 100, deg: Math.round(views.at(-1)) });
      };
      window.__raf(step);
    }));
    steps.shots.forEach((u, i) => writeFileSync(`${out}/${name}-orbit-step${i + 1}.png`, Buffer.from(u.split(",")[1], "base64")));
    delete steps.shots;
    await page.evaluate(() => { window.__hold = true; });
    results[name] = { anims, scrollDuring, fit: m, rally, steps, errors };
    check(`${name} orbit: the camera keeps moving`, steps.viewsPerS >= 5 && steps.deg > 0 && steps.changed.every((n) => n > 0), steps);
    check(`${name} title fit`, m.drawn && !m.titleOutside && m.titleWidthShare >= TITLE_SHARE[name][0] && m.titleWidthShare <= TITLE_SHARE[name][1] && !m.partsOutside && !m.partsClipped && !m.scroll && m.btnH >= 44 && !m.stageOverlaps.length && m.stageH >= 120 && !errors.length, m);
    check(`${name} no page scroll during the entrance`, !scrollDuring.some(Boolean), scrollDuring);
    check(`${name} entrance is animated`, anims > 0, { anims });
    check(`${name} rally: ball over the net, one bounce per crossing in the receiver court`, rally.frames >= 350 && rally.through === 0 && rally.missingBall === 0 && rally.outsideStage === 0 && rally.crossings >= 5 && rally.bounces.length >= rally.crossings && !/(LL|RR|N)/.test(rally.bounces), rally);
    await ctx.close();

    const rctx = await browser.newContext({ ...device, reducedMotion: "reduce" });
    const rpage = await rctx.newPage();
    await rpage.goto(app.origin + "/");
    await rpage.waitForSelector(".start-go");
    await rpage.evaluate(() => document.fonts.ready);
    const a = await rpage.screenshot({ path: `${out}/${name}-reduced.png` });
    const still = await rpage.evaluate(() => new Promise((r) => setTimeout(() => r(document.getAnimations().length), 1500)));
    const b = await rpage.screenshot();
    const rm = await fit(rpage);
    const stillT = await rpage.evaluate(async () => { const m = await import("/start.js"); const s = document.querySelector(".start-rally").rally.scene; return { t: s.t, frames: s.frames, deg: s.cam.deg, y: m.ballAt(s.t, s.sc).y }; });
    results[name].reduced = { animations: still, samePicture: a.equals(b), fit: rm, stillT };
    check(`${name} reduced motion: final look only, nothing moves`, still === 0 && a.equals(b) && stillT.frames === 1 && stillT.deg === 0 && Math.abs(stillT.y) < 0.2 && !rm.titleOutside && rm.drawn && !rm.scroll && !rm.stageOverlaps.length, results[name].reduced);
    await rctx.close();
  }
  // Coming back to the start screen within the same page load: no second slam.
  const ctx = await browser.newContext(VIEWS.phone);
  const page = await ctx.newPage();
  await page.goto(app.origin + "/");
  await page.locator(".start-go").click();
  await page.waitForSelector(".role-card");
  await page.goBack();
  await page.waitForSelector(".start-go");
  const calm = await page.evaluate(() => ({ calm: document.querySelector(".start").classList.contains("calm"), slam: document.getAnimations().filter((a) => a.animationName === "start-slam").length }));
  results.back = calm;
  check("back to the start screen in the same visit: no second slam", calm.calm && calm.slam === 0, calm);
  await ctx.close();

  // A phone at a quarter of this CPU: drawn frames per second over 4 s, and a hidden tab draws nothing.
  for (const [vname, device] of [["phone", VIEWS.phone], ["p360", VIEWS.p360]]) {
    const fctx = await browser.newContext({ ...device, reducedMotion: "no-preference" });
    const fpage = await fctx.newPage();
    const cdp = await fctx.newCDPSession(fpage);
    await fpage.goto(app.origin + "/");
    await fpage.waitForSelector(".start-go");
    await fpage.evaluate(() => document.fonts.ready);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const fps = await fpage.evaluate(() => new Promise((done) => {
      const s = () => document.querySelector(".start-rally").rally.scene;
      setTimeout(() => {
        const f0 = s().frames, t0 = performance.now();
        let worst = 0, prev = t0;
        const watch = () => { const n = performance.now(); worst = Math.max(worst, n - prev); prev = n; if (n - t0 < 4000) requestAnimationFrame(watch); else done({ fps: Math.round(((s().frames - f0) / (n - t0)) * 10000) / 10, worstGapMs: Math.round(worst) }); };
        requestAnimationFrame(watch);
      }, 1500);
    }));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    results[`${vname}-cpu4x`] = fps;
    check(`${vname} 4x CPU throttle: at least 40 drawn frames a second`, fps.fps >= 40, fps);
    const hidden = await fpage.evaluate(() => new Promise((done) => {
      const s = () => document.querySelector(".start-rally").rally.scene;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      const f0 = s().frames;
      setTimeout(() => {
        const drawnHidden = s().frames - f0;
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        const f1 = s().frames;
        setTimeout(() => done({ drawnHidden, drawnAfter: s().frames - f1 }), 600);
      }, 1200);
    }));
    results[`${vname}-hidden`] = hidden;
    check(`${vname} hidden tab: no drawing, resumes when shown`, hidden.drawnHidden === 0 && hidden.drawnAfter > 5, hidden);
    await fctx.close();
  }
} finally {
  writeFileSync(`${out}/start-kof.json`, JSON.stringify(results, null, 2));
  await browser.close().catch(() => {});
  await app.stop();
}
console.log(`START_KOF_DONE fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
