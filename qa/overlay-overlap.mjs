// Do the labels on the video overlap? The real drawHud runs in the real page at each screen and
// source, with real stage size and fit, over a sweep of ball, shot and player positions. Every label
// box it draws is recorded from the canvas calls; any two touching boxes count as one overlap, and so
// does a box touching a button over the picture (채움, chips) or the LOCK bracket on the ball. A box
// counts with its drop shadow (t.px to the right and below). A notice (자리 교체 here; 엔드 교체 is the
// same element) is shown first: it may touch no label, button, panel or the calibrated table.
//   bun qa/overlay-overlap.mjs --vision=<checkout> --tournament=<checkout> --clip=<16:9> --clip-tall=<9:16> --tag=before|after --out=<dir> [--port=9860] [--engine=chromium]
import { chromium, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, fakeCamera, startCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
// --engine=chromium measures the labels in the real pixel font (this host's headless WebKit cannot decode woff2)
const browser = args.engine === "chromium" ? await chromium.launch() : await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const rows = [];

const sweep = () => import("/vision/js/hud.js").then(({ drawHud }) => {
  const real = document.querySelector(".stage__overlay");
  const stage = real.parentElement;
  const sr = stage.getBoundingClientRect();
  const video = document.querySelector(".stage__video");
  const vw = video.videoWidth, vh = video.videoHeight;
  const cover = stage.getAttribute("data-video-fit") === "cover";
  const s = (cover ? Math.max : Math.min)(sr.width / vw, sr.height / vh);
  const ox = (sr.width - vw * s) / 2, oy = (sr.height - vh * s) / 2;
  const toScreen = (p) => ({ x: ox + p.x * s, y: oy + p.y * s });
  const c = document.createElement("canvas");
  c.className = real.className;
  c.style.visibility = "hidden";
  stage.append(c);
  const dpr = window.devicePixelRatio || 1;
  c.width = sr.width * dpr; c.height = sr.height * dpr;
  const ctx = c.getContext("2d");
  const boxes = [];
  const fill = ctx.fillRect.bind(ctx);
  // joint lines and dots drawn after a label box, inside it, cover its text (the lead, 2026-10-30)
  let linesOver = 0, lineWorst = null;
  const overText = (x, y) => boxes.some((b, k) => k % 2 === 1 && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
  ctx.fillRect = (x, y, w, h) => {
    if (w >= 24 && h >= 12) boxes.push({ x, y, w, h });
    else if (w > 1 && h > 1 && w < 24 && h < 12 && overText(x + w / 2, y + h / 2)) { linesOver++; lineWorst = lineWorst || { dot: [x, y, w, h] }; }
    fill(x, y, w, h);
  };
  let path = [];
  const bp = ctx.beginPath.bind(ctx), mt = ctx.moveTo.bind(ctx), lt = ctx.lineTo.bind(ctx), st = ctx.stroke.bind(ctx);
  ctx.beginPath = () => { path = []; bp(); };
  ctx.moveTo = (x, y) => { path.push(null, [x, y]); mt(x, y); };
  ctx.lineTo = (x, y) => { path.push([x, y]); lt(x, y); };
  ctx.stroke = () => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (!a || !b) continue;
      for (let k = 0; k <= 10; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / 10, y = a[1] + ((b[1] - a[1]) * k) / 10;
        if (overText(x, y)) { linesOver++; lineWorst = lineWorst || { line: [a, b] }; k = 11; i = path.length; }
      }
    }
    st();
  };
  // the same limits ui.js gives drawHud: under the top rows, above what floats on the bottom edge
  const shown = (n) => n && !n.closest("[hidden]") && n.offsetParent !== null && n.getBoundingClientRect().height > 0;
  const top = Math.max(4, ...[".strip", ".glance", ".peek", ".banner", ".stage__chips", ".toast.show"].map((q) => document.querySelector(q)).filter(shown)
    .map((n) => n.getBoundingClientRect().bottom - sr.top).filter((b) => b > 0 && b < sr.height).map((b) => b + 4));
  const bottom = Math.min(sr.height, ...[".dock", ".bottom", ".bar", ".fix"].map((q) => document.querySelector(q)).filter(shown)
    .map((n) => n.getBoundingClientRect().top - sr.top).filter((y) => y > sr.height / 2)) - 4;
  const avoid = [".players", ".court", ".bar", ".stage__fit", ".dock", ".pointbar"].map((q) => document.querySelector(q)).filter((n) => n && !n.closest("[hidden]") && document.documentElement.dataset).map((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
  }).filter((r) => r.w > 0 && r.x < sr.width && r.y < sr.height && r.x + r.w > 0 && r.y + r.h > 0);
  const body = (cx, y0, y1) => Array.from({ length: 33 }, (_, i) => ({ x: cx * vw + (i % 2 ? 4 : -4), y: (y0 + ((y1 - y0) * i) / 32) * vh, v: 1 }));
  const shapes = [[0.15, 0.35, 0.9, 0.85, 0.25, 0.6], [0.4, 0.3, 0.8, 0.6, 0.25, 0.6], [0.3, 0.4, 0.95, 0.75, 0.15, 0.5]];
  // buttons and chips over the picture: no label may touch one
  const buttons = [...document.querySelectorAll("button, a[href]")].filter((n) => !n.closest("[hidden]") && n.offsetParent !== null).map((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, button: (n.textContent || n.getAttribute("aria-label") || "").trim().slice(0, 12) };
  }).filter((r) => r.w > 0 && r.x < sr.width && r.y < sr.height && r.x + r.w > 0 && r.y + r.h > 0 && !(r.x <= 0 && r.y <= 0 && r.w >= sr.width && r.h >= sr.height));
  const cs = getComputedStyle(c);
  const px = parseInt(cs.getPropertyValue("--px"), 10) || 2;
  const reach = (parseInt(cs.getPropertyValue("--fs-hud-label"), 10) || 12) + 1;
  // the notice against every panel and button on screen and the calibrated table quad
  const toastEl = document.querySelector(".toast.show");
  const tr = toastEl ? toastEl.getBoundingClientRect() : null;
  const notice = tr ? { x: tr.left - sr.left, y: tr.top - sr.top, w: tr.width + px, h: tr.height + px, button: "알림" } : null;
  const hit = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  const noticeHits = [];
  if (notice) {
    const ui = [".strip > *", ".glance", ".peek > *", ".banner", ".dock", ".players", ".court", ".bar > *", ".fix", ".pointbar"]
      .flatMap((q) => [...document.querySelectorAll(q)]).filter(shown).map((n) => { const r = n.getBoundingClientRect(); return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, cls: String(n.className).slice(0, 30) }; });
    for (const q of ui) if (hit(notice, q)) noticeHits.push(q.cls);
    const corners = window.__ppv?.state.calibration?.corners;
    if (corners) {
      const c4 = corners.map(toScreen);
      const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      for (let i = 0; i <= 16; i++) for (let j = 0; j <= 8; j++) {
        const p = lerp(lerp(c4[0], c4[3], i / 16), lerp(c4[1], c4[2], i / 16), j / 8);
        if (p.x >= notice.x && p.x <= notice.x + notice.w && p.y >= notice.y && p.y <= notice.y + notice.h) { noticeHits.push("table"); i = 99; break; }
      }
    }
  }
  let frames = 0, overlaps = noticeHits.length, worst = noticeHits.length ? { notice, noticeHits } : null;
  for (const [nx, ny0, ny1, fx, fy0, fy1] of shapes) for (let i = 0; i < 9; i++) for (let j = 0; j < 5; j++) for (const lockSide of ["near", "far"]) for (const shotSide of ["near", "far"]) {
    const lockPt = { x: ((i + 0.5) / 9) * vw, y: ((j + 0.5) / 5) * vh };
    const state = {
      players: {
        near: { label: "블루 · 김블루", end: 0, landmarks: body(nx, ny0, ny1), stand: { img: { x: nx * vw, y: ny1 * vh }, behindM: 1.2 } },
        far: { label: "레드 · 넷째", end: 1, landmarks: body(fx, fy0, fy1), stand: { img: { x: fx * vw, y: fy1 * vh }, behindM: 0.6 } },
      },
      ball: { lock: { ...lockPt, side: lockSide, speedKmh: 40 } },
      lastShot: { side: shotSide, label: "포핸드 서브 ~40km" },
    };
    boxes.length = 0;
    drawHud(ctx, state, toScreen, { top, bottom, avoid });
    const panels = boxes.filter((_, k) => k % 2 === 1).map((b) => ({ x: b.x, y: b.y, w: b.w + px, h: b.h + px }));
    const lp = toScreen(lockPt);
    const fixed = [...buttons, ...(notice ? [notice] : []), { x: Math.round(lp.x) - reach, y: Math.round(lp.y) - reach, w: reach * 2 + 1, h: reach * 2 + 1, bracket: true }];
    frames++;
    const pairs = [];
    for (let a = 0; a < panels.length; a++) {
      for (let b = a + 1; b < panels.length; b++) pairs.push([panels[a], panels[b]]);
      for (const f of fixed) pairs.push([panels[a], f]);
    }
    for (const [p, q] of pairs) {
      if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) {
        overlaps++;
        worst = worst || { lockSide, shotSide, lockPt, p, q, with: q.button ?? (q.bracket ? "LOCK bracket" : "label") };
      }
    }
  }
  overlaps += linesOver;
  if (linesOver && !worst) worst = { with: "관절선", ...lineWorst };
  c.remove();
  // recorded, not a failure: with players + court open (the default) how many of the table's 17x9
  // sample points sit under them
  const panelsOpen = document.querySelector(".dock")?.getAttribute("aria-expanded") === "true";
  let tableUnderPanels = null;
  const tc = window.__ppv?.state.calibration?.corners;
  if (tc) {
    const pb = [".players", ".court", ".dock"].flatMap((q) => [...document.querySelectorAll(q)]).filter(shown).map((n) => { const r = n.getBoundingClientRect(); return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height }; });
    const c4 = tc.map(toScreen);
    const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    tableUnderPanels = 0;
    for (let i = 0; i <= 16; i++) for (let j = 0; j <= 8; j++) {
      const p = lerp(lerp(c4[0], c4[3], i / 16), lerp(c4[1], c4[2], i / 16), j / 8);
      if (pb.some((q) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h)) tableUnderPanels++;
    }
  }
  return { panelsOpen, tableUnderPanels, linesOver, stage: [Math.round(sr.width), Math.round(sr.height)], fit: cover ? "cover" : "contain", frames, overlaps, worst, notice: notice ? [Math.round(notice.x), Math.round(notice.y), Math.round(notice.w), Math.round(notice.h)] : null, noticeHits };
});

for (const [source, clip, port] of [["16:9", args.clip, Number(args.port || 9860)], ["9:16", args["clip-tall"], Number(args.port || 9860) + 30]]) {
  const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip, port });
  try {
    for (const [name, device] of Object.entries({ ...DEVICES, p360: { ...DEVICES.phone, viewport: { width: 360, height: 780 } } })) {
      const ctx = await browser.newContext(device);
      await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
      await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
      await ctx.addInitScript(() => localStorage.setItem("pp-role", "camera"));
      const page = await ctx.newPage();
      await page.goto(app.origin + "/");
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await startCamera(page);
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: /자리 교체/ }).click();
      await page.waitForSelector(".toast.show", { timeout: 3000 }).catch(() => {});
      const r = await page.evaluate(sweep);
      if (!r.notice) { r.overlaps++; r.worst = r.worst || "notice did not show"; }
      // the notice clears by itself (3 s) before a sheet opens, so a toast over a sheet is not counted as a cover
      await page.waitForSelector(".toast.show", { state: "hidden", timeout: 6000 }).catch(() => {});
      // an open settings popover / history sheet must win every point it covers: live chips and the fit
      // button once painted over the open settings (2026-10-31)
      const panelCover = (sel) => page.evaluate((sel) => {
        const p = [...document.querySelectorAll(sel)].find((e) => e.offsetWidth && !e.closest("[hidden]"));
        if (!p) return { found: false, covered: 0, samples: 0, by: [] };
        const b = p.getBoundingClientRect();
        let covered = 0, samples = 0;
        const by = new Set();
        for (let y = b.top + 4; y < b.bottom - 4; y += 8) for (let x = b.left + 4; x < b.right - 4; x += 8) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          samples++;
          const e = document.elementFromPoint(x, y);
          if (e && !p.contains(e)) { covered++; by.add(String(e.className || e.tagName).slice(0, 40)); }
        }
        return { found: true, covered, samples, by: [...by].slice(0, 6) };
      }, sel);
      await page.getByRole("button", { name: /^설정/ }).first().click();
      await page.waitForTimeout(500);
      const settings = await panelCover(".popover");
      await page.getByRole("button", { name: /^설정/ }).first().click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "기록", exact: true }).first().click();
      await page.waitForTimeout(500);
      const history = await panelCover(".sheet");
      r.panels = { settings, history };
      r.overlaps += settings.covered + history.covered + (settings.found ? 0 : 1) + (history.found ? 0 : 1);
      await page.getByRole("button", { name: "기록 닫기" }).first().click().catch(() => {});
      await page.waitForTimeout(300);
      // the 3 s cancel bar after an automatic point, the "누가 땄나요" choice and the let/fault questions:
      // pinned to the screen top it once covered the back button, the role chips and the record strip
      // (lead, 2026-10-31). It must cover none of the top rows, and nothing may cover it.
      const barCheck = (tag) => page.evaluate(() => {
        const bar = document.querySelector(".pointbar");
        if (!bar || bar.hidden || !bar.offsetWidth) return { shown: false, barCovered: 0, topCovered: 0, by: [] };
        const b = bar.getBoundingClientRect();
        let barCovered = 0, topCovered = 0;
        const by = new Set();
        for (let y = b.top + 3; y < b.bottom - 3; y += 6) for (let x = b.left + 3; x < b.right - 3; x += 6) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const e = document.elementFromPoint(x, y);
          if (e && !bar.contains(e)) { barCovered++; by.add("over bar: " + String(e.className || e.tagName).slice(0, 30)); }
        }
        const tops = [...document.querySelectorAll(".strip > *, .glance, .peek .chip, .stage__fit")].filter((n) => n.offsetWidth && !n.closest("[hidden]") && getComputedStyle(n).visibility !== "hidden");
        for (const n of tops) {
          const r = n.getBoundingClientRect();
          for (let y = r.top + 2; y < r.bottom - 2; y += 5) for (let x = r.left + 2; x < r.right - 2; x += 5) {
            const e = document.elementFromPoint(x, y);
            if (e && bar.contains(e)) { topCovered++; by.add("bar over: " + String(n.className || n.tagName).slice(0, 30)); }
          }
        }
        return { shown: true, barCovered, topCovered, by: [...by].slice(0, 6), barTop: Math.round(b.top) };
      });
      const pendingStates = {
        cancel: { side: 0, end: 0, name: "김블루", reason: "못 받음", score: [5, 3], gameEnded: false, suspect: null },
        choice: { choice: true, reason: "두 번 튀", suspect: null },
        ask: { side: 1, end: 1, name: "박레드", reason: "서브 넷에 닿음", score: [5, 4], gameEnded: false, suspect: { let: true, fault: true } },
      };
      r.cancelBar = {};
      for (const [tag, p] of Object.entries(pendingStates)) {
        await page.evaluate((p) => { const t = window.__ppv.venue.tour; t.pending = { ...p, until: Date.now() + 60000, cancelled: false }; window.__ppv.state.tour = t.view(); }, p);
        await page.waitForTimeout(400);
        const c = await barCheck(tag);
        r.cancelBar[tag] = c;
        r.overlaps += c.barCovered + c.topCovered + (c.shown ? 0 : 1);
        if (out && (name === "phone" || name === "p360") && source === "9:16") await page.screenshot({ path: `${out}/cancelbar-${name}-${tag}.png` });
      }
      await page.evaluate(() => { const t = window.__ppv.venue.tour; t.pending = null; window.__ppv.state.tour = t.view(); });
      // the same labels with players + court folded by the chip (open is the default, measured above);
      // label overlaps count in both states, table points under the panels are recorded only
      const dockBtn = page.locator(".dock:visible");
      r.dock = await dockBtn.count();
      if (r.dock) {
        if (await dockBtn.getAttribute("aria-expanded") === "true") await dockBtn.click();
        // with the 누가 땄나요 bar up (an unsure point can arrive any time): labels keep off it too
        await page.evaluate((p) => { const t = window.__ppv.venue.tour; t.pending = { ...p, until: Date.now() + 60000, cancelled: false }; window.__ppv.state.tour = t.view(); }, pendingStates.choice);
        await page.waitForTimeout(400);
        const f = await page.evaluate(sweep);
        await page.evaluate(() => { const t = window.__ppv.venue.tour; t.pending = null; window.__ppv.state.tour = t.view(); });
        r.folded = { panelsOpen: f.panelsOpen, overlaps: f.overlaps, linesOver: f.linesOver, tableUnderPanels: f.tableUnderPanels, worst: f.worst };
        r.overlaps += f.overlaps + (f.panelsOpen ? 1 : 0);
        if (out && (name === "phone" || name === "land")) await page.screenshot({ path: `${out}/panels-folded-${name}-${source.replace(":", "x")}.png` });
        await dockBtn.click();
        await page.waitForTimeout(400);
        r.reopened = await dockBtn.getAttribute("aria-expanded") === "true";
        if (!r.reopened) r.overlaps++;
      } else { r.overlaps++; r.worst = r.worst || "no 선수·코트 chip"; }
      rows.push({ screen: name, source, ...r });
      console.log(`OVERLAP ${name} ${source} ${r.fit} stage=${r.stage} frames=${r.frames} overlaps=${r.overlaps} linesOverText=${r.linesOver} panelsOpen=${r.panelsOpen} tableUnderPanels=${r.tableUnderPanels}/153 folded=${JSON.stringify(r.folded && { overlaps: r.folded.overlaps, tableUnderPanels: r.folded.tableUnderPanels })} reopened=${r.reopened} notice=${JSON.stringify(r.notice)} noticeHits=${JSON.stringify(r.noticeHits)} settingsCovered=${settings.found ? settings.covered + "/" + settings.samples : "not-open"} [${settings.by}] historyCovered=${history.found ? history.covered + "/" + history.samples : "not-open"} [${history.by}] cancelBar=${JSON.stringify(r.cancelBar)}`);
      await ctx.close();
    }
  } finally {
    await app.stop();
  }
}
await browser.close();
const total = rows.reduce((a, r) => a + r.overlaps, 0);
writeFileSync(`${out}/overlay-overlap.json`, JSON.stringify(rows, null, 2));
console.log(`OVERLAP_DONE ${args.tag} rows=${rows.length} overlaps=${total}`);
process.exit(total ? 1 : 0);
