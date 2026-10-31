// Is the camera screen one picture with panels floating on it, in portrait and landscape?
// Chromium (the real Galmuri font), isolated servers, a phone notch and home bar simulated with
// the app's own --safe-* tokens. Per screen, with the camera running:
//   picture   - share of the screen the video picture covers (portrait: 9:16 camera, >= 95 %)
//   over      - every panel sits on the picture, not in a band of its own (portrait)
//   visible   - share of the picture no panel covers (reported before/after; landscape >= 80 %)
//   table     - points inside the calibrated table quad covered by a panel (0)
//   targets   - buttons and chips on the camera screen under 44 px (0), anything outside the safe area (0)
//   line      - the table outline is drawn where the stored corners say (each edge midpoint inked)
// and while calibrating: no panel covers the picture (portrait) or a tap spot (landscape), and
// the stored corners land exactly under the corner markers the owner saw (after any snap).
//   bun qa/overlay-layout.mjs --vision=<checkout> --tournament=<checkout> --clip=<16:9 webm> --clip-tall=<9:16 webm> --tag=before|after --out=<dir> [--port=9870]
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.PPV_CHROMIUM ? { executablePath: process.env.PPV_CHROMIUM } : {});
const phone = (w, h) => ({ ...devices["iPhone 15"], viewport: { width: w, height: h } });
const pad = (w, h) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// iPhone 15 safe areas (portrait: status bar + home bar; landscape: notch sides + home bar)
const SAFE_P = { t: 47, r: 0, b: 34, l: 0 }, SAFE_L = { t: 0, r: 47, b: 21, l: 47 }, SAFE_PAD = { t: 24, r: 0, b: 20, l: 0 };
const SCREENS = [
  { name: "p393", device: phone(393, 852), tall: true, portrait: true, safe: SAFE_P },
  { name: "p360", device: phone(360, 780), tall: true, portrait: true, safe: SAFE_P },
  { name: "pad-p", device: pad(768, 1024), tall: true, portrait: true, safe: SAFE_PAD },
  { name: "land", device: phone(852, 393), tall: false, portrait: false, safe: SAFE_L },
  { name: "pad-l", device: pad(1024, 768), tall: false, portrait: false, safe: SAFE_PAD },
];
// tap targets in video px of a 1920x1080 frame (the harness corners), scaled to the source
const CORNERS = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];
const TALL_CORNERS = [{ x: 20, y: 590 }, { x: 70, y: 470 }, { x: 470, y: 470 }, { x: 520, y: 590 }]; // 540x960 frame, table band

const rows = [];
const fails = [];
const check = (screen, name, ok, detail) => { if (!ok) { fails.push(`${screen} ${name}`); console.log(`FAIL ${screen} ${name} ${JSON.stringify(detail)}`); } };

// geometry of the shown picture and every visible panel, in CSS px
const measure = () => {
  const v = document.querySelector(".stage__video");
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  const fit = getComputedStyle(v).objectFit;
  const s = fit === "cover" ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
  const pw = vw * s, ph = vh * s;
  const px = r.left + (r.width - pw) / 2, py = r.top + (r.height - ph) / 2;
  // what is visible of the picture: its box clipped to the element and the screen
  const x0 = Math.max(px, r.left, 0), y0 = Math.max(py, r.top, 0), x1 = Math.min(px + pw, r.right, innerWidth), y1 = Math.min(py + ph, r.bottom, innerHeight);
  const pic = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  const shown = (n) => {
    if (!n || n.closest("[hidden]")) return false;
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const b = n.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const rect = (n) => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const sel = [".strip > *", ".glance", ".banner", ".players", ".court", ".dock", ".bar > *", ".stage__chips > *", ".stage__fit", ".calibbar__guide", ".calibbar__actions > *", ".pointbar", ".fix", ".toast.show"];
  const panels = [];
  for (const q of sel) for (const n of document.querySelectorAll(q)) if (shown(n)) panels.push({ q, cls: String(n.className).slice(0, 40), ...rect(n) });
  // big blocks (for "is it on the picture"): the containers, not each chip
  const blocks = [".strip", ".glance", ".bottom", ".dock", ".bar"].map((q) => document.querySelector(q)).filter(shown).map((n) => ({ q: "." + n.className.split(" ")[0], ...rect(n) }));
  const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const toastBox = panels.find((b) => b.q === ".toast.show") || null;
  const toastHits = toastBox ? panels.filter((b) => b !== toastBox && b.x < toastBox.x + toastBox.w && toastBox.x < b.x + b.w && b.y < toastBox.y + toastBox.h && toastBox.y < b.y + b.h).map((b) => b.cls) : null;
  const covered = (p) => panels.some((b) => inside(p, b));
  let tot = 0, vis = 0;
  for (let i = 0; i < 60; i++) for (let j = 0; j < 100; j++) {
    const p = { x: pic.x + ((i + 0.5) / 60) * pic.w, y: pic.y + ((j + 0.5) / 100) * pic.h };
    tot++; if (!covered(p)) vis++;
  }
  const toScreen = (q) => ({ x: px + q.x * s, y: py + q.y * s });
  const corners = window.__ppv?.state.calibration?.corners || null;
  let table = null, line = null;
  if (corners) {
    const c = corners.map(toScreen);
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    let n = 0, hit = 0;
    const hits = [];
    for (let i = 1; i < 16; i++) for (let j = 1; j < 8; j++) {
      // corners: near-left, far-left, far-right, near-right
      const p = lerp(lerp(c[0], c[3], i / 16), lerp(c[1], c[2], i / 16), j / 8);
      if (!inside(p, pic)) continue;
      n++; if (covered(p)) { hit++; if (hits.length < 3) hits.push({ p: [Math.round(p.x), Math.round(p.y)], by: panels.find((b) => inside(p, b))?.cls }); }
    }
    table = { points: n, covered: hit, hits };
    // the outline is inked at each edge midpoint on the overlay canvas (a 7x7 neighbourhood)
    const cv = document.querySelector(".stage__overlay");
    const cr = cv.getBoundingClientRect();
    const g = cv.getContext("2d");
    const k = cv.width / cr.width;
    line = [0, 1, 2, 3].map((e) => {
      const m = lerp(c[e], c[(e + 1) % 4], 0.5);
      if (!inside(m, pic) || covered(m)) return null;
      // 9 CSS px square: wider than a dash gap of the outline
      const n = Math.round(9 * k);
      const d = g.getImageData(Math.round((m.x - cr.left) * k) - (n >> 1), Math.round((m.y - cr.top) * k) - (n >> 1), n, n).data;
      let a = 0; for (let i = 3; i < d.length; i += 4) a = Math.max(a, d[i]);
      return a;
    });
  }
  const targets = [...document.querySelectorAll(".app button, .app a.chip, .app label.btn, .app .chip--role")].filter((n) => shown(n) && !n.closest(".screen, .popover, .sheet, .leave"))
    .map((n) => ({ cls: String(n.className).slice(0, 40), t: n.textContent.trim().slice(0, 12), ...rect(n) })).filter((b) => Math.min(b.w, b.h) < 44 - 0.5);
  const cs = getComputedStyle(document.querySelector(".app"));
  const safe = ["t", "r", "b", "l"].map((k) => parseFloat(cs.getPropertyValue(`--safe-${k}`)) || 0);
  const unsafe = panels.filter((b) => b.y < safe[0] - 0.5 || b.x + b.w > innerWidth - safe[1] + 0.5 || b.y + b.h > innerHeight - safe[2] + 0.5 || b.x < safe[3] - 0.5).map((b) => b.cls);
  return {
    fit: document.querySelector(".app").dataset.fit, layout: document.querySelector(".app").dataset.layout, mode: window.__ppv?.state.mode, objectFit: fit,
    pic: { w: Math.round(pic.w), h: Math.round(pic.h) }, picturePct: Math.round((pic.w * pic.h * 1000) / (innerWidth * innerHeight)) / 10,
    visiblePct: Math.round((vis * 1000) / tot) / 10,
    over: blocks.map((b) => ({ q: b.q, on: inside({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, pic) })),
    table, line, targets, unsafe, toast: toastBox, toastHits,
    panelsOnPicture: panels.filter((b) => b.x < pic.x + pic.w && pic.x < b.x + b.w && b.y < pic.y + pic.h && pic.y < b.y + b.h).map((b) => b.cls),
    stored: corners,
  };
};

async function tapCorners(page, pts) {
  for (const c of pts) {
    const p = await page.evaluate(([x, y]) => {
      const v = document.querySelector(".stage__video");
      const r = v.getBoundingClientRect();
      const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
    }, [c.x, c.y]);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(250);
  }
}

for (const tall of [true, false]) {
  const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: tall ? args["clip-tall"] : args.clip, port: Number(args.port || 9870) + (tall ? 0 : 30) });
  try {
    for (const sc of SCREENS.filter((s) => s.tall === tall)) {
      const ctx = await browser.newContext(sc.device);
      await ctx.addInitScript(() => { if (location.origin !== "null") { sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "camera"); } });
      await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
      await ctx.addInitScript((safe) => {
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = `:root { --safe-t: ${safe.t}px; --safe-r: ${safe.r}px; --safe-b: ${safe.b}px; --safe-l: ${safe.l}px; }`;
          document.head.append(st);
        });
      }, sc.safe);
      const page = await ctx.newPage();
      await page.goto(app.origin + "/");
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole("button", { name: /카메라 시작/ }).click();
      await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
      const s = await page.evaluate(() => ({ mode: window.__ppv.state.mode, w: window.__ppv.state.video?.width, h: window.__ppv.state.video?.height }));
      check(sc.name, "camera", s.mode === "calibrating", s);
      await page.waitForTimeout(600);
      const want = (tall ? TALL_CORNERS.map((c) => ({ x: (c.x * s.w) / 540, y: (c.y * s.h) / 960 })) : CORNERS.map((c) => ({ x: (c.x * s.w) / 1920, y: (c.y * s.h) / 1080 })));
      const cal = await page.evaluate(measure);
      await page.screenshot({ path: `${out}/${sc.name}-보정.png` });
      const tapCover = await page.evaluate((pts) => {
        const v = document.querySelector(".stage__video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return pts.map((c) => {
          const x = r.left + (r.width - v.videoWidth * k) / 2 + c.x * k, y = r.top + (r.height - v.videoHeight * k) / 2 + c.y * k;
          const e = document.elementFromPoint(x, y);
          return e && !e.closest(".stage") ? String(e.className).slice(0, 30) : null;
        }).filter(Boolean);
      }, want);
      await tapCorners(page, want);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/${sc.name}-보정-네점.png` });
      // where the owner sees the four corners now (after the snap), and the picture geometry then
      const seen = await page.evaluate(() => {
        const v = document.querySelector(".stage__video");
        const r = v.getBoundingClientRect();
        return {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height }, vw: v.videoWidth, vh: v.videoHeight,
          markers: [...document.querySelectorAll(".calib__pt")].map((b) => { const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }),
        };
      });
      await page.getByRole("button", { name: /^확인/ }).click();
      await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
      await page.waitForTimeout(2500);
      // players + court start open on every visit (owner 2026-10-31); measured as arrived, then folded
      // by the chip for the picture and table checks below
      const openOnArrival = await page.evaluate(() => document.querySelector(".dock")?.getAttribute("aria-expanded") === "true");
      const arrived = await page.evaluate(measure);
      await page.screenshot({ path: `${out}/${sc.name}-촬영.png` });
      if (openOnArrival) { await page.locator(".dock:visible").click(); await page.waitForTimeout(400); }
      const run = await page.evaluate(measure);
      await page.screenshot({ path: `${out}/${sc.name}-촬영-접음.png` });
      // stored corners (video px) put back on the calibration screen vs the markers shown there, CSS px
      const k = Math.min(seen.rect.width / seen.vw, seen.rect.height / seen.vh);
      const back = (c) => ({ x: seen.rect.left + (seen.rect.width - seen.vw * k) / 2 + c.x * k, y: seen.rect.top + (seen.rect.height - seen.vh * k) / 2 + c.y * k });
      const err = run.stored && seen.markers.length === 4 ? Math.max(...run.stored.map((c, i) => { const p = back(c); return Math.hypot(p.x - seen.markers[i].x, p.y - seen.markers[i].y); })) : null;
      const row = { screen: sc.name, source: tall ? "9:16" : "16:9", calib: { panelsOnPicture: cal.panelsOnPicture, picture: cal.pic, picturePct: cal.picturePct, tapCover }, cornerErrPx: err == null ? null : Math.round(err * 10) / 10, ...run };
      delete row.stored;
      row.arrived = { open: openOnArrival, visiblePct: arrived.visiblePct, table: arrived.table, unsafe: arrived.unsafe.length, targets: arrived.targets.length };
      console.log(`ARRIVED ${sc.name} open=${openOnArrival} visible=${arrived.visiblePct}% table=${arrived.table?.covered}/${arrived.table?.points}`);
      check(sc.name, "players·court open on arrival", openOnArrival, null);
      check(sc.name, "arrived (open): inside safe area", arrived.unsafe.length === 0, arrived.unsafe);
      rows.push(row);
      console.log(`ROW ${sc.name} fit=${run.fit}/${run.objectFit} picture=${run.picturePct}% visible=${run.visiblePct}% table=${run.table?.covered}/${run.table?.points} line=${JSON.stringify(run.line)} small=${run.targets.length} unsafe=${run.unsafe.length} calibCover=${cal.panelsOnPicture.length} cornerErr=${row.cornerErrPx}`);
      if (sc.portrait) {
        check(sc.name, "picture>=95%", run.picturePct >= 95, run.picturePct);
        check(sc.name, "panels on the picture", run.over.length >= 3 && run.over.every((o) => o.on), run.over);
      } else {
        check(sc.name, "visible>=80%", run.visiblePct >= 80, run.visiblePct);
      }
      check(sc.name, "table covered 0", run.table && run.table.points > 0 && run.table.covered === 0, run.table);
      check(sc.name, "outline drawn at the corners", run.line && run.line.every((a) => a === null || a > 0) && run.line.some((a) => a > 0), run.line);
      check(sc.name, "targets >= 44", run.targets.length === 0, run.targets);
      check(sc.name, "inside safe area", run.unsafe.length === 0, run.unsafe);
      if (sc.portrait) check(sc.name, "calibration: nothing over the picture", cal.panelsOnPicture.length === 0, cal.panelsOnPicture);
      check(sc.name, "calibration: tap spots uncovered", tapCover.length === 0, tapCover);
      check(sc.name, "stored corners = markers shown", err != null && err <= 1.5, err);
      // the fit switch is still there in portrait and still switches
      if (sc.portrait) {
        const fitBtn = page.locator(".stage__fit:visible");
        const has = await fitBtn.count();
        check(sc.name, "fit switch visible", has === 1, has);
        if (has) {
          const before = await page.evaluate(() => document.querySelector(".stage").dataset.videoFit);
          await fitBtn.click();
          await page.waitForTimeout(400);
          const after = await page.evaluate(() => document.querySelector(".stage").dataset.videoFit);
          check(sc.name, "fit switch switches", before !== after, { before, after });
          await page.screenshot({ path: `${out}/${sc.name}-맞춤.png` });
          await fitBtn.click();
          await page.waitForTimeout(300);
        }
      }
      // players + court map opened from the dock: still off the table
      const dock = page.locator(".dock:visible");
      if (await dock.count()) {
        // open again between points
        await page.waitForFunction(() => !window.__ppv.state.rally?.active, null, { timeout: 30000 }).catch(() => {});
        let open = null;
        for (let tries = 0; tries < 4 && !open; tries++) {
          if (await dock.getAttribute("aria-expanded") !== "true") await dock.click();
          await page.waitForTimeout(500);
          const m = await page.evaluate(measure);
          if (await dock.getAttribute("aria-expanded") === "true") open = m;
          else await page.waitForFunction(() => !window.__ppv.state.rally?.active, null, { timeout: 30000 }).catch(() => {});
        }
        check(sc.name, "opened panels measured open", !!open, null);
        open = open || await page.evaluate(measure);
        await page.screenshot({ path: `${out}/${sc.name}-펼침.png` });
        row.open = { visiblePct: open.visiblePct, table: open.table, unsafe: open.unsafe, targets: open.targets };
        console.log(`OPEN ${sc.name} visible=${open.visiblePct}% table=${open.table?.covered}/${open.table?.points}`);
        // open may cover part of the table; that is recorded, not failed (owner chose open)
        check(sc.name, "opened panels: inside safe area", open.unsafe.length === 0, open.unsafe);
        // a rally starts while they are open: the app's own rally flag goes off, then on (held for the
        // check, so a busy host that detects no rally in time cannot decide it); the panels stay open
        const trace = await page.evaluate(async () => {
          const st = window.__ppv.state;
          const real = st.rally;
          let fake = { ...(real || {}), active: false };
          Object.defineProperty(st, "rally", { configurable: true, get: () => fake, set: () => {} });
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const isOpen = () => document.querySelector(".dock").getAttribute("aria-expanded") === "true";
          if (!isOpen()) document.querySelector(".dock").click();
          await wait(400);
          const openBefore = isOpen();
          fake = { ...fake, active: true };
          const t0 = performance.now();
          let foldedAfterMs = null;
          while (performance.now() - t0 < 3000) { if (!isOpen()) { foldedAfterMs = Math.round(performance.now() - t0); break; } await wait(20); }
          delete st.rally;
          st.rally = real;
          return { openBefore, foldedAfterMs };
        });
        const kept = trace.openBefore && trace.foldedAfterMs == null;
        row.open.staysOnRally = kept;
        row.open.trace = trace;
        console.log(`FOLD ${sc.name} stays-open-on-rally=${kept} ${JSON.stringify(trace)}`);
        check(sc.name, "opened panels stay open when a rally starts", kept, trace);
        if (await dock.getAttribute("aria-expanded") === "true") { await dock.click(); await page.waitForTimeout(300); }
      }
      // a notice (자리 교체 here; 엔드 교체 uses the same one) covers no panel, button or table
      await page.getByRole("button", { name: /자리 교체/ }).click();
      await page.waitForTimeout(400);
      const nt = await page.evaluate(measure);
      await page.screenshot({ path: `${out}/${sc.name}-알림.png` });
      row.notice = { box: nt.toast, hits: nt.toastHits, table: nt.table };
      console.log(`NOTICE ${sc.name} shown=${!!nt.toast} hits=${JSON.stringify(nt.toastHits)} table=${nt.table?.covered}/${nt.table?.points}`);
      check(sc.name, "notice clear of panels, buttons and table", nt.toast && nt.toastHits.length === 0 && nt.table && nt.table.covered === 0, row.notice);
      await page.getByRole("button", { name: /자리 교체/ }).click();
      // the notice leaves after 3 s by itself
      const gone = await page.waitForFunction(() => !document.querySelector(".toast.show"), null, { timeout: 5000 }).then(() => true, () => false);
      check(sc.name, "notice leaves by itself", gone, null);
      // opened panels: settings and history over the running picture
      await page.getByRole("button", { name: "설정" }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${sc.name}-설정.png` });
      await page.getByRole("button", { name: "설정 닫기" }).first().click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "기록" }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${sc.name}-기록.png` });
      await ctx.close();
    }
  } finally {
    await app.stop();
  }
}
await browser.close();
writeFileSync(`${out}/overlay-layout.json`, JSON.stringify(rows, null, 2));
const md = ["| 화면 | 소스 | 배치 | 영상이 덮는 화면 % | 패널 안 가린 영상 % | 탁구대 가림 | 보정 중 영상 위 패널 | 모서리 오차 px | 펼침: 안 가린 영상 % / 탁구대 가림 / 랠리 때 접힘 |", "|---|---|---|---|---|---|---|---|---|"];
for (const r of rows) md.push(`| ${r.screen} | ${r.source} | ${r.layout}/${r.fit}/${r.objectFit} | ${r.picturePct} | ${r.visiblePct} | ${r.table ? `${r.table.covered}/${r.table.points}` : "-"} | ${r.calib.panelsOnPicture.length} | ${r.cornerErrPx} | ${r.open ? `${r.open.visiblePct} / ${r.open.table?.covered}/${r.open.table?.points} / ${r.open.foldsOnRally ? "예" : "아니오"}` : "-"} |`);
writeFileSync(`${out}/overlay-layout.md`, md.join("\n") + "\n");
console.log(`OVERLAY_LAYOUT ${args.tag} rows=${rows.length} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
