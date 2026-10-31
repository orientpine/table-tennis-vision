// Every screen of the one app, every role, four device shapes (WebKit): capture it and measure what
// a person would notice differs: font, colours, button shape, border, icon style, a visible way
// back, the role and screen name on screen, and touch targets. Writes one table a reviewer can read.
//   bun qa/theme-audit.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --tag=before|after --out=<dir>
//     [--devices=phone,land,pad,tv] [--port=8940]
import { chromium, devices, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const tag = args.tag || "after";
const out = args.out || `evidence/r8/${tag}`;
mkdirSync(out, { recursive: true });
const corners = [{ x: 355, y: 634 }, { x: 557, y: 519 }, { x: 1339, y: 535 }, { x: 1486, y: 659 }];
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-audit-"));
const P = Number(args.port || 8940);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };
const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], { cwd: args.vision, env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(join(tmp, "tour"), "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") }, stdio: ["ignore", "ignore", "inherit"] }),
];
const cleanup = () => { for (const p of procs) p.kill(); };
const up = async (port, path) => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server ${port} did not start`);
};
await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);

const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/__qa/cam.webm") return new Response(Bun.file(args.clip), { headers: { "content-type": "video/webm" } });
    if (req.headers.get("upgrade") === "websocket") return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("no", { status: 400 });
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(`http://127.0.0.1:${target(url.pathname)}${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
  websocket: {
    open(ws) {
      const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
      ws.data.back = back;
      ws.data.queue = [];
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => ws.send(e.data);
      back.onclose = () => ws.close();
    },
    message(ws, m) { ws.data.back.readyState === 1 ? ws.data.back.send(m) : ws.data.queue.push(m); },
    close(ws) { ws.data.back?.close(); },
  },
});
const origin = `http://127.0.0.1:${ports.proxy}`;
const api = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return res.json();
};

// One finished tournament in the archive, then a live one: blue took game 1, game 2 is at 7:5.
const first = await api("/api/tournament", { name: "지난 대회", players: ["가", "나", "다", "라"], format: "double", bestOf: 3 });
const created = await api("/api/tournament", { name: "탁구장 시험", players: ["김블루", "박레드", "셋째", "넷째"], format: "double", bestOf: 3 }, { "x-pin": first.pin });
const pin = created.pin;
let pinNow = pin;
const matchId = created.state.derived.matches.find((m) => m.status === "ready").id;
const seq = [...Array(11).fill(0).flatMap((_, i) => (i < 7 ? [0, 1] : [0])), ...[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0]];
let n = 0;
for (const side of seq) await api("/api/action", { type: "point", matchId, side, seq: n++ }, { "x-pin": pin });
const form = new FormData();
form.set("record", JSON.stringify({ id: Date.now(), durationMs: 4200, shots: 5, bounces: [] }));
form.set("video", new Blob([readFileSync(args.clip)], { type: "video/webm" }), "rally.webm");
const uploaded = await (await fetch(`${origin}/vision/api/rallies`, { method: "POST", headers: { "x-ppv-key": readFileSync(join(tmp, "upload-key"), "utf8").trim() }, body: form })).json();
await api("/api/action", { type: "clip", matchId, index: n - 1, url: `/vision/${uploaded.share}` }, { "x-pin": pin });

const fakeCamera = (src) => {
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage__video { visibility: visible !important; }";
    document.head.append(st);
  });
  const t = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  if (!t) return; // http on a long hostname is not a secure context: no camera API there
  t.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    const c = document.createElement("canvas");
    c.width = 960; c.height = 540;
    const g = c.getContext("2d");
    const draw = () => g.drawImage(v, 0, 0, c.width, c.height);
    draw();
    setInterval(draw, 1000 / 30);
    return c.captureStream(30);
  };
};

// What a person would notice, read from the rendered page.
const measure = (page) => page.evaluate(() => {
  const rendered0 = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden]"); };
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && !e.closest("[hidden]");
  };
  const count = (arr) => { const m = {}; for (const x of arr) m[x] = (m[x] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(" "); };
  const textEls = [...document.querySelectorAll("body *")].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(e));
  const fonts = textEls.map((e) => getComputedStyle(e).fontFamily.split(",")[0].replace(/"/g, "").trim());
  // a file input sits inside its label button; the label is the target a finger hits
  const controls = [...document.querySelectorAll("button, a[href], input, select, label.btn, [role=button]")].filter((e) => vis(e) && !(e.matches("input") && e.closest("label.btn")));
  const ctl = controls.map((e) => getComputedStyle(e));
  const small = controls.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((e) => (e.getAttribute("aria-label") || e.textContent || e.className || e.tagName).trim().slice(0, 16));
  const back = [...document.querySelectorAll("[data-back]")].filter(vis)[0];
  // a score number must sit inside its own pane (a growing side panel once squeezed it to a sliver)
  const scoreOut = [...document.querySelectorAll(".tv-score, .pscore, .ref-score")].filter(vis).filter((e) => {
    const r = e.getBoundingClientRect();
    const pane = e.closest(".tv-side, .pane, .ref-half").getBoundingClientRect();
    return r.top < pane.top - 1 || r.bottom > pane.bottom + 1 || r.left < pane.left - 1 || r.right > pane.right + 1;
  }).length;
  // Text that does not fit its control: clipped, touching the frame (under 2 px inside it), or
  // wrapped onto a second line. Only one-line controls; cards and score panes are multi-line by design.
  const fit = [];
  const oneLine = [...document.querySelectorAll(".btn, .chip, .mchip, .seg-btn, .seg__btn, .nav button, .roles button, .ref-btn, .tv-role, .mode, .back, .upchip")].filter((c) => vis(c) && !c.matches(".chip--perf"));
  for (const c of oneLine) {
    const s = getComputedStyle(c);
    const r = c.getBoundingClientRect();
    const inner = { l: r.left + parseFloat(s.borderLeftWidth), r: r.right - parseFloat(s.borderRightWidth), t: r.top + parseFloat(s.borderTopWidth), b: r.bottom - parseFloat(s.borderBottomWidth) };
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let wrapped = false;
    let worst = Infinity;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest("[hidden]") || getComputedStyle(n.parentElement).display === "none") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const lines = new Set();
      for (const q of range.getClientRects()) {
        if (!q.width) continue;
        lines.add(Math.round(q.top / 4));
        worst = Math.min(worst, q.left - inner.l, inner.r - q.right);
      }
      if (lines.size > 1) wrapped = true;
    }
    const label = (c.getAttribute("aria-label") || c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (worst < 2) fit.push(`${label}: ${worst < 0 ? "잘림" : "테두리에 붙음"} ${Math.round(worst)}px`);
    if (wrapped) fit.push(`${label}: 두 줄`);
    if (c.scrollWidth > c.clientWidth + 1 && s.overflow !== "visible") fit.push(`${label}: 넘침`);
    // the whole control cut off by a clipping parent: the 393 px settings sheet once let a 3-option row
    // stretch it, so 큰 화면(TV), 공 더 잡기, 열쇠 저장 and the close X ran past its edge (2026-10-31)
    for (let p = c.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === "visible") continue;
      // a one-row strip that scrolls sideways on purpose (tournament .chips) is not a cut
      if (ps.display.includes("flex") && !ps.flexDirection.startsWith("column") && ps.flexWrap === "nowrap") continue;
      const pr = p.getBoundingClientRect();
      const pl = pr.left + parseFloat(ps.borderLeftWidth), pRight = pr.right - parseFloat(ps.borderRightWidth);
      const cut = Math.max(r.right - pRight, pl - r.left);
      if (cut > 1) { fit.push(`${label}: 바깥에 잘림 ${Math.round(cut)}px`); break; }
    }
  }
  // Two things nobody meant to touch: controls, plain boxes and block text closer than 8 px (target 12).
  // The whole page counts, not just the first screenful; things in different layers (a sticky bar over
  // scrolled content, a sheet) are not neighbours. Screens listed as CAMERA_LIVE stay with their own lane.
  const items = [...document.querySelectorAll("button, a[href], input, select, textarea, label.btn, .url, .pinbig, .card > *, .group > *, .screen__inner > *, .sheet__body > *, .sheet__foot > *, .popover > *, dialog > *")]
    .filter((e) => rendered0(e) && !e.closest(".start, .replay-full, canvas") && !(e.matches("input") && e.closest("label.btn")) && !(e.matches("button") && e.closest(".hcard-main, .mcard")) && !e.matches(".hcard-main *, .mcard *"));
  const layer = (e) => { for (let p = e; p; p = p.parentElement) { const q = getComputedStyle(p).position; if (q === "fixed" || q === "sticky" || q === "absolute" || p.tagName === "DIALOG") return p; } return document.body; };
  const box = items.map((e) => ({ e, r: e.getBoundingClientRect(), l: layer(e) }));
  const gaps = [];
  const gapsCam = [];
  const CAM = ".bar, .strip, .stage, .hud, .calibbar, .pointbar, .fix-panel";
  const nameOfEl = (e) => (e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.textContent || e.className || e.tagName).toString().trim().replace(/\s+/g, " ").slice(0, 18);
  for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++) {
    const a = box[i], b = box[j];
    if (a.l !== b.l || a.e.contains(b.e) || b.e.contains(a.e)) continue;
    const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    const gapY = Math.max(a.r.top, b.r.top) - Math.min(a.r.bottom, b.r.bottom), gapX = Math.max(a.r.left, b.r.left) - Math.min(a.r.right, b.r.right);
    const g = ox > 4 && gapY >= -0.5 ? gapY : oy > 4 && gapX >= -0.5 ? gapX : null;
    if (g !== null && g < 7.5) (a.e.closest(CAM) && b.e.closest(CAM) ? gapsCam : gaps).push(`${nameOfEl(a.e)} ↔ ${nameOfEl(b.e)}: ${Math.round(g)}px`);
  }
  const backBox = back && back.getBoundingClientRect();
  const allText = document.body.innerText;
  const rendered = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[hidden]");
  };
  // iOS zooms the page when a field under 16 px takes focus, and it stays zoomed (owner capture 2026-10-31).
  const inputSmall = [...document.querySelectorAll("input, select, textarea")].filter((e) => rendered(e) && e.type !== "file" && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${e.id || e.placeholder || e.tagName} ${getComputedStyle(e).fontSize}`);
  // iOS zooms on a double tap wherever touch-action is plain auto (owner Q407): every element is manipulation or stricter.
  const touchAuto = [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).touchAction === "auto").map(nameOfEl);
  const buttons = [...document.querySelectorAll("button, a[href], [role=button]")].filter(rendered);
  const names = new Map();
  for (const b of buttons) {
    const name = (b.innerText || b.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (name) names.set(name, (names.get(name) || 0) + 1);
  }
  const duplicateLabels = [...names].filter(([, count]) => count > 1).map(([label, count]) => ({ label, count }));
  const oldTerms = ["관람", "선수 교체", "선수 바꾸기", "대회 앱"];
  const accessibleNames = [...document.querySelectorAll("[aria-label], [aria-labelledby], img[alt], [title]")].filter(rendered).map((e) => [
    e.getAttribute("aria-label"), e.getAttribute("alt"), e.getAttribute("title"),
    ...(e.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent),
  ].filter(Boolean).join(" ")).join("\n");
  const oldNames = oldTerms.filter((term) => allText.includes(term) || accessibleNames.includes(term));
  const deadEndBack = [...document.querySelectorAll("[data-back]")].filter((e) => rendered(e) && !e.disabled && !e.getAttribute("data-back-destination")).length;
  const writes = '[data-act="hist-fav"],[data-act="hist-del"],[data-act="rename-save"],[data-act="setup-edit"],[data-act="setup-new"],[data-act="setup-submit"],[data-act="camera-approve"],[data-act="camera-revoke"],[data-act="first-server"],[data-act="undo"],[data-draft],[data-rename],[data-act="point"]:not(:disabled)';
  const viewerStoredPinWrites = document.body.dataset.role === "viewer" && localStorage.getItem("pp-pin")
    ? [...document.querySelectorAll(writes)].filter(rendered).length : 0;
  return {
    deadEndBack, duplicateLabels, oldNames, viewerStoredPinWrites,
    bg: getComputedStyle(document.body).backgroundColor,
    fonts: count(fonts),
    radius: count(ctl.map((s) => s.borderTopLeftRadius)),
    border: count(ctl.map((s) => `${s.borderTopWidth} ${s.borderTopStyle}`)),
    shadow: count(ctl.map((s) => (s.boxShadow === "none" ? "none" : "hard"))),
    gradients: [...document.querySelectorAll("body *")].filter((e) => vis(e) && /gradient/.test(getComputedStyle(e).backgroundImage)).length,
    icons: count([...document.querySelectorAll("svg")].filter(vis).map((s) => `${getComputedStyle(s).strokeLinecap}/${s.getAttribute("stroke-width") || getComputedStyle(s).strokeWidth}`)),
    back: backBox ? { x: Math.round(backBox.left), y: Math.round(backBox.top), w: Math.round(backBox.width), h: Math.round(backBox.height) } : null,
    roleShown: /카메라|심판|관람|관전/.test(allText),
    screen: [...document.querySelectorAll("[data-screen-name]")].filter(vis)[0]?.textContent.trim() || null,
    fit,
    gaps: [...new Set(gaps)],
    gapsCam: [...new Set(gapsCam)],
    inputSmall,
    touchAuto,
    scale: visualViewport.scale,
    scoreOut,
    small,
    controls: controls.length,
    overflowX: document.documentElement.scrollWidth > innerWidth,
  };
});

const iphone = devices["iPhone 15"];
const DEVICES = {
  phone: { ...iphone, viewport: { width: 393, height: 852 } },
  p360: { ...iphone, viewport: { width: 360, height: 640 } },
  p402: { ...iphone, viewport: { width: 402, height: 874 } },
  land: { ...iphone, viewport: { width: 852, height: 393 } },
  pad: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tv: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};
// WPE WebKit cannot decode woff2, so only --engine=chromium measures text in the real pixel font.
// The owner's address is far longer than 127.0.0.1; Chromium can resolve the same length to this proxy.
const longHost = "pc-0a0.tailnet-00.example";
const browser = args.engine === "chromium" ? await chromium.launch({ args: [`--host-resolver-rules=MAP ${longHost} 127.0.0.1`] }) : await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const rows = [];
const errors = [];
const open = async (dev, role, withPin, query = "") => {
  const ctx = await browser.newContext(DEVICES[dev]);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${origin}/__qa/cam.webm`);
  await ctx.addInitScript(([r, p]) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    if (r) localStorage.setItem("pp-role", r);
    if (p) localStorage.setItem("pp-pin", p);
    localStorage.setItem("pp-sound", "0");
  }, [role, withPin ? pinNow : null]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${dev}/${role}: ${e.message}`));
  // camera needs a secure context, and only 127.0.0.1 is one over plain http
  await page.goto((args.engine === "chromium" && role !== "camera" ? `http://${longHost}:${ports.proxy}` : origin) + "/" + query, { waitUntil: "load" });
  return { ctx, page };
};
const shot = async (page, dev, role, screen) => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.querySelectorAll("video[data-clip-video]")].every((v) => v.readyState >= 1 || v.error), null, { timeout: 15000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const name = `${dev}-${role}-${screen}`;
  await page.screenshot({ path: `${out}/${name}.png` });
  const m = await measure(page);
  rows.push({ device: dev, role, shotName: screen, ...m });
  if (m.deadEndBack || m.oldNames.length || m.viewerStoredPinWrites) errors.push(`${name}: deadEndBack=${m.deadEndBack} oldNames=${m.oldNames.join(",")} viewerStoredPinWrites=${m.viewerStoredPinWrites}`);
  if (m.duplicateLabels.length) console.log("DUPLICATE_CANDIDATES", name, JSON.stringify(m.duplicateLabels));
  console.log("SHOT", name, m.back ? "back" : "NOBACK", m.fonts);
};
const tab = (page, label) => page.locator("nav.nav button", { hasText: label }).click();

try {
  for (const dev of args.only === "owner" ? [] : (args.devices || "phone,land,pad,tv").split(",")) {
    { // start screen
      const { ctx, page } = await open(dev, null, false, "?start");
      await page.waitForSelector(".start-go");
      await shot(page, dev, "none", "시작화면");
      await ctx.close();
    }
    { // role picker
      const { ctx, page } = await open(dev, null, false, "?role");
      await page.waitForSelector(".role-card");
      await shot(page, dev, "none", "역할고르기");
      await ctx.close();
    }
    { // viewer
      const { ctx, page } = await open(dev, "viewer", false);
      await page.waitForSelector(".tv-score, .pscore");
      await shot(page, dev, "viewer", "경기");
      if (await page.locator("nav.nav").count()) {
        for (const t of ["대진", "순위", "기록", "설정"]) { await tab(page, t); await shot(page, dev, "viewer", t); }
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await open(dev, "viewer", true);
      await page.waitForSelector(".tv-score, .pscore");
      await shot(page, dev, "viewer-pin", "경기");
      if (await page.locator("nav.nav").count()) {
        for (const t of ["대진", "기록", "설정"]) { await tab(page, t); await shot(page, dev, "viewer-pin", t); }
        await tab(page, "기록");
        await page.locator('[data-act="hist-open"]').first().click();
        await page.locator(".hist-bar").waitFor({ state: "attached", timeout: 10000 });
        await shot(page, dev, "viewer-pin", "기록상세");
      }
      await ctx.close();
    }
    { // referee
      const { ctx, page } = await open(dev, "referee", true);
      await page.waitForSelector(".pscore");
      await shot(page, dev, "referee", "경기");
      for (const t of ["대진", "순위", "기록", "설정"]) { await tab(page, t); await shot(page, dev, "referee", t); }
      page.on("dialog", (d) => d.accept());
      await page.locator('[data-act="setup-new"]').click();
      const own = page.locator('dialog [data-ask="1"]');
      if (await own.count()) await own.click();
      await shot(page, dev, "referee", "새대회");
      await page.locator('[data-back]').click();
      await tab(page, "경기");
      await page.locator('[data-act="ref-enter"]').first().click();
      await page.waitForSelector(".ref");
      await shot(page, dev, "referee", "심판모드");
      await ctx.close();
    }
    { // camera without the tournament PIN: the start screen carries the PC-save PIN box
      const { ctx, page } = await open(dev, "camera", false);
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await shot(page, dev, "camera", "시작화면-PIN없음");
      await ctx.close();
    }
    { // camera
      const { ctx, page } = await open(dev, "camera", true);
      await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
      await shot(page, dev, "camera", "시작화면");
      await page.getByRole("button", { name: /카메라 시작/ }).click();
      await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
      const s = await page.evaluate(() => ({ mode: window.__ppv.state.mode, w: window.__ppv.state.video?.width, h: window.__ppv.state.video?.height }));
      if (s.mode === "calibrating") {
        await shot(page, dev, "camera", "보정");
        for (const c of corners) {
          const pt = await page.evaluate(([x, y]) => {
            const v = document.querySelector("video");
            const r = v.getBoundingClientRect();
            const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
            return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
          }, [c.x * (s.w / 1920), c.y * (s.h / 1080)]);
          await page.mouse.click(pt.x, pt.y);
        }
        await page.getByRole("button", { name: /확인/ }).click();
        await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
      }
      await shot(page, dev, "camera", "촬영중");
      await page.getByRole("button", { name: /^설정/ }).click();
      await shot(page, dev, "camera", "설정");
      await ctx.close();
    }
  }
  // The owner's capture: referee with a stored PIN on a tournament that has not started yet, so the
  // settings screen also carries 시드·방식 변경 and the rename fields.
  const fresh = await api("/api/tournament", { name: "시작 전 대회", players: ["3", "박레드", "셋째", "넷째"], format: "double", bestOf: 3 }, { "x-pin": pin });
  pinNow = fresh.pin || pin;
  for (const dev of (args.devices || "phone,land,pad,tv").split(",")) {
    const { ctx, page } = await open(dev, "referee", true);
    await page.waitForSelector("nav.nav button");
    await tab(page, "설정");
    await shot(page, dev, "referee-시작전", "설정");
    // the PIN field and PIN 저장 in the middle of the screen, as in the owner's capture
    await page.locator('[data-form="pin"]').evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${out}/${dev}-referee-시작전-기록권한.png` });
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  cleanup();
}

// The running camera screen and its calibration are pingpong-portrait-overlay's: listed, not counted here.
const CAMERA_LIVE = new Set(["촬영중", "보정"]);
const gapRows = rows.filter((r) => !CAMERA_LIVE.has(r.shotName));
const esc = (v) => String(v ?? "").replace(/\|/g, "/");
const lines = [
  `# theme audit (${tag})`, "",
  "| 기기 | 역할 | 화면 | 배경 | 글꼴 | 버튼 모서리 | 버튼 테두리 | 그림자 | 그라데이션 | 아이콘 | 왼쪽 위 뒤로 | 보이는 화면 이름 | 44px 미만 | 글자 안 맞음 | 8px 미만 간격 |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.device} | ${r.role} | ${r.shotName} | ${esc(r.bg)} | ${esc(r.fonts)} | ${esc(r.radius)} | ${esc(r.border)} | ${esc(r.shadow)} | ${r.gradients} | ${esc(r.icons)} | ${r.back ? `${r.back.w}×${r.back.h}@${r.back.x},${r.back.y}` : "없음"} | ${esc(r.screen || "없음")} | ${r.small.length}${r.small.length ? " " + esc(r.small.slice(0, 3).join(", ")) : ""} | ${(r.fit || []).length}${(r.fit || []).length ? " " + esc(r.fit.slice(0, 3).join(", ")) : ""} | ${r.gaps.length}${r.gaps.length ? " " + esc(r.gaps.slice(0, 3).join(", ")) : ""} |`),
];
writeFileSync(`${out}/audit.json`, JSON.stringify({ rows, errors }, null, 2));
writeFileSync(`${out}/audit.md`, lines.join("\n") + "\n");
console.log(`AUDIT_DONE rows=${rows.length} errors=${errors.length} noBack=${rows.filter((r) => !r.back && r.screen !== "모드 고르기" && r.shotName !== "시작화면").length} pickerBack=${rows.filter((r) => r.back && r.screen === "모드 고르기").length} noName=${rows.filter((r) => !r.screen).length} small=${rows.filter((r) => r.device !== "tv" && r.small.length).length} fit=${rows.reduce((a, r) => a + (r.fit || []).length, 0)} overflowX=${rows.filter((r) => r.overflowX).length} inputSmall=${rows.reduce((a, r) => a + r.inputSmall.length, 0)} touchAuto=${rows.reduce((a, r) => a + r.touchAuto.length, 0)} gaps=${gapRows.reduce((a, r) => a + r.gaps.length, 0)} gapsCamera=${rows.reduce((a, r) => a + r.gapsCam.length + (CAMERA_LIVE.has(r.shotName) ? r.gaps.length : 0), 0)} scoreOut=${rows.reduce((a, r) => a + (r.scoreOut || 0), 0)} deadEndBack=${rows.reduce((a, r) => a + r.deadEndBack, 0)} duplicateLabels=${rows.reduce((a, r) => a + r.duplicateLabels.length, 0)} oldNames=${rows.reduce((a, r) => a + r.oldNames.length, 0)} viewerStoredPinWrites=${rows.reduce((a, r) => a + r.viewerStoredPinWrites, 0)}`);
process.exit(errors.length ? 1 : 0);
