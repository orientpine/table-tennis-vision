// The owner's one-phone scene, measured: one tripod phone is the camera, it holds the tournament PIN, and a
// wrong point has to be fixed by hand on that same phone while the camera keeps filming.
// Both real servers (tournament app at "/", vision at "/vision/") run behind one small proxy (one
// origin with WebSocket, as on the Funnel host); isolated data in a temp dir. The phone is WebKit
// (Safari engine) at iPhone 15 size (393x852) with a fake camera (a looping test clip drawn into a
// canvas stream). A sampler reads the camera screen every 200 ms: "filming" = the camera screen is
// up, running, its camera track is live and the video clock moves.
//   --flow=before   today: on the camera screen tap the role chip -> 심판 -> fix on the referee
//                   screen -> role 카메라 -> back on the camera screen (start / calibrate if asked)
//   --flow=after    the camera screen's own 점수 고치기 panel (PIN device only)
//   --flow=panel    the open panel's layout on one viewport (--vp=p852|p659|l393|tv): 44 px
//                   controls, inside the screen, no overlap with bar / strip / pointbar, camera filming
//   bun qa/one-phone-e2e.mjs --flow=before|after --vision=<checkout> --tournament=<checkout>
//     --clip=<webm> [--out=evidence/r7/<flow>]
import { chromium, devices, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const flow = args.flow || "before";
const out = args.out || `evidence/r7/${flow}`;
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-venue-"));
const P = Number(args.port || 8890);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };

const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(join(tmp, "tour"), "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") },
    stdio: ["ignore", "ignore", "inherit"],
  }),
];
const up = async (port, path) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server ${port} did not start`);
};
try {
  await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);
} catch (err) {
  for (const p of procs) p.kill();
  throw err;
}

// Proxy with two test switches: /__qa/cam.webm (the fake camera's clip) and /__qa/cut?who=camera|all&ms=N
// (close those WebSockets and refuse new ones for N ms, to see both apps show it and reconnect).
const sockets = new Set();
const blocked = { camera: 0, all: 0 };
// The camera is the phone: the only iPhone user agent here (WebKit sends no Referer on a WebSocket).
const isCamera = (ws) => /iPhone/.test(ws.data.ua || "");
const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
const proxy = Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/__qa/cam.webm") return new Response(Bun.file(args.clip), { headers: { "content-type": "video/webm" } });
    if (url.pathname === "/__qa/cut") {
      const who = url.searchParams.get("who") === "all" ? "all" : "camera";
      blocked[who] = Date.now() + Number(url.searchParams.get("ms") || 5000);
      for (const ws of sockets) if (who === "all" || isCamera(ws)) ws.close();
      return new Response("cut");
    }
    if (req.headers.get("upgrade") === "websocket") {
      const ua = req.headers.get("user-agent") || "";
      const cam = /iPhone/.test(ua);
      if (Date.now() < blocked.all || (cam && Date.now() < blocked.camera)) return new Response("cut", { status: 503 });
      return server.upgrade(req, { data: { path: url.pathname + url.search, ua } }) ? undefined : new Response("no", { status: 400 });
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(`http://127.0.0.1:${target(url.pathname)}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
      ws.data.back = back;
      ws.data.queue = [];
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => ws.send(e.data);
      back.onclose = () => ws.close();
    },
    message(ws, m) {
      if (ws.data.back.readyState === 1) ws.data.back.send(m);
      else ws.data.queue.push(m);
    },
    close(ws) {
      sockets.delete(ws);
      ws.data.back?.close();
    },
  },
});
const origin = `http://127.0.0.1:${ports.proxy}`;
const api = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ---------- measurement ----------
const steps = [];
const taps = { phone: 0, tv: 0, pad: 0, phone2: 0 };
let current = null;
const shots = {};
const step = async (name, fn, { device = "phone", shoot = () => null } = {}) => {
  const t0 = Date.now();
  const tapsBefore = { ...taps };
  current = name;
  let rec;
  try {
    rec = { name, pass: true, detail: await fn() };
  } catch (err) {
    rec = { name, pass: false, detail: String(err.message || err).split("\n")[0] };
  }
  rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
  rec.taps = Object.fromEntries(Object.entries(taps).map(([k, v]) => [k, v - tapsBefore[k]]).filter(([, v]) => v));
  steps.push(rec);
  const p = shoot();
  if (p) await p.screenshot({ path: `${out}/${String(steps.length).padStart(2, "0")}-${name}.png` }).catch(() => {});
  console.log(`STEP ${name} ${rec.pass ? "PASS" : "FAIL"} ${rec.seconds}s taps=${JSON.stringify(rec.taps)}${rec.pass ? "" : " " + rec.detail}`);
  return rec.pass;
};
const tap = async (who, locator) => {
  await locator.click();
  taps[who]++;
};
const waitFor = async (what, fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

const recordSpeech = () => {
  window.__said = [];
  // WPE WebKit has no speech engine: a stand-in that only records what the app asks to say.
  if (typeof window.SpeechSynthesisUtterance === "undefined") window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  if (!window.speechSynthesis) Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {}, getVoices: () => [] } });
  // On the prototype: WPE hands out a fresh speechSynthesis object later, dropping an own-property patch.
  const proto = window.SpeechSynthesis ? window.SpeechSynthesis.prototype : Object.getPrototypeOf(window.speechSynthesis);
  const speak = proto.speak;
  proto.speak = function (u) {
    window.__said.push(u.text);
    try { speak.call(this, u); } catch {}
  };
};
// WPE WebKit (the test Safari engine) does not start a MediaStream in a visibility:hidden video,
// and the app keeps its video hidden under the intro screen; iPhone Safari plays it. Test-only style.
const fakeCamera = (src) => {
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage__video { visibility: visible !important; }";
    document.head.append(st);
  });
  // On the prototype, as with speech: WPE can drop an own-property patch on navigator.mediaDevices.
  const target = window.MediaDevices ? window.MediaDevices.prototype : navigator.mediaDevices;
  target.getUserMedia = async () => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    document.documentElement.append(v);
    await v.play();
    const c = document.createElement("canvas");
    c.width = 960;
    c.height = 540;
    const g = c.getContext("2d");
    const draw = () => g.drawImage(v, 0, 0, c.width, c.height);
    draw();
    setInterval(draw, 1000 / 30);
    return c.captureStream(30);
  };
};
const said = (p) => p.evaluate(() => (window.__said || []).filter((t) => t.trim()));

let pin = null;
let matchId = null;
const state = async () => (await api("/api/state")).body;
const match = async (id = matchId) => (await state()).derived.matches.find((m) => m.id === id);

const engine = args["phone-engine"] === "chromium" ? chromium : webkit;
const phoneBrowser = await engine.launch(engine === webkit && process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const iphone = devices["iPhone 15"];
const phoneCtx = async (preset = {}) => {
  const VPS = { p852: { width: 393, height: 852 }, p659: { width: 375, height: 659 }, l393: { width: 852, height: 393 }, tv: { width: 1920, height: 1080 } };
  const vp = VPS[args.vp] || iphone.viewport;
  const base = args.vp === "tv" ? { viewport: vp } : { ...iphone, viewport: vp };
  const ctx = await phoneBrowser.newContext(engine === webkit ? base : { viewport: vp, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(recordSpeech);
  await ctx.addInitScript(fakeCamera, `${origin}/__qa/cam.webm`);
  await ctx.addInitScript((kv) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, preset);
  return ctx;
};
const errors = [];
const watch = (p, who) => p.on("console", (m) => m.type() === "error" && errors.push(`${who}: ${m.text()}`));


let phone = null;
const report = { flow, steps, taps, errors, said: {} };
const H = (body) => api("/api/action", body, { "x-pin": pin });
const log = async () => (await match()).points.slice();
// harness setup (not taps): make the match log exactly `want`, retrying when the camera writes first
const seed = async (want) => {
  for (let tries = 0; tries < 40; tries++) {
    let cur = await log();
    let ok = true;
    while (cur.length && (cur.length > want.length || cur.some((p, i) => i < want.length && want[i] !== p))) {
      const r = await H({ type: "undo", matchId, seq: cur.length });
      if (r.status !== 200) { ok = false; break; }
      cur = await log();
    }
    while (ok && cur.length < want.length) {
      const r = await H({ type: "point", matchId, side: want[cur.length], seq: cur.length });
      if (r.status !== 200) { ok = false; break; }
      cur = await log();
    }
    if (ok && JSON.stringify(cur) === JSON.stringify(want)) return cur;
    await Bun.sleep(150);
  }
  throw new Error(`could not seed ${JSON.stringify(want)}`);
};
// the fake camera's clip: paused while people stop to fix the score (no new rally), the stream stays live
const clip = (play) => phone.evaluate((on) => { const v = [...document.querySelectorAll("video")].find((x) => x.src.includes("/__qa/cam.webm")); if (v) on ? v.play() : v.pause(); return !!v; }, play).catch(() => false);

// ---------- camera sampler ----------
const samples = [];
let sampling = true;
const sampler = (async () => {
  let lastT = null;
  while (sampling) {
    const at = Date.now();
    let s;
    if (!phone) { await Bun.sleep(200); continue; }
    try {
      s = await phone.evaluate(() => {
        const v = document.querySelector(".stage__video");
        const tr = v && v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
        return { path: location.pathname, app: !!window.__ppv, mode: window.__ppv ? window.__ppv.state.mode : null, t: v ? v.currentTime : null, track: tr ? tr.readyState : null, fps: window.__ppv ? Math.round(window.__ppv.state.perf.fps || 0) : 0 };
      });
    } catch (err) {
      s = { nav: String(err.message || err).slice(0, 60) };
    }
    s.at = at;
    s.filming = !!(s.app && s.mode === "running" && s.track === "live" && s.t !== null && lastT !== null && s.t > lastT);
    lastT = s.app && s.track === "live" ? s.t : null;
    samples.push(s);
    await Bun.sleep(200);
  }
})();
// longest stretch without filming inside [t0, t1], in seconds, and the share of samples filming
const filming = (t0, t1) => {
  const w = samples.filter((s) => s.at >= t0 && s.at <= t1);
  let gap = 0, start = null, last = t0;
  for (const s of w) {
    if (!s.filming && start === null) start = last;
    if (s.filming && start !== null) { gap = Math.max(gap, s.at - start); start = null; }
    last = s.at;
  }
  if (start !== null) gap = Math.max(gap, t1 - start);
  return { samples: w.length, filmingShare: w.length ? Math.round((w.filter((s) => s.filming).length / w.length) * 100) / 100 : 0, longestGapS: Math.round(gap / 100) / 10, paths: [...new Set(w.map((s) => s.path || "(navigating)"))], modes: [...new Set(w.map((s) => s.mode))] };
};
const waitFilming = (what, ms = 60000) => waitFor(what, async () => samples.length && samples[samples.length - 1].filming, ms);
// the referee screen shows the server's score (it taps with the seq it shows, so it must be current)
const synced = async () => {
  // the referee screen drops a second point tap inside 400 ms (MIN_TAP_GAP_MS, a double-tap guard);
  // a person's taps are further apart, so keep that gap here too
  await phone.waitForTimeout(450);
  const m = await match();
  const v = [m.score.current.a, m.score.current.b];
  await phone.waitForFunction((v) => [0, 1].every((k) => { const b = document.querySelector(`.pane[data-side='${k}']`); return b && !b.disabled && b.getAttribute("aria-label").includes(`(현재 ${v[k]})`); }), v, { timeout: 10000 });
};

try {
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "폰 1대 시험", players: ["블루선수", "레드선수", "셋째", "넷째"], format: "double", bestOf: 3 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId, note: "오너 폰에서 대회를 만들어 PIN이 이 폰에 있고, 이 폰은 이미 카메라 역할(측정 대상 아님)" };
  }, { device: "setup" });
  const key = readFileSync(join(tmp, "upload-key"), "utf8").trim();
  const phonePreset = { "pp-pin": pin, "pp-role": "camera", "ppv.uploadKey": JSON.stringify(key), "ppv.tourMode": JSON.stringify("all") };
  const cphone = await phoneCtx(phonePreset);
  phone = await cphone.newPage();
  watch(phone, "phone");

  const startCameraAndCalibrate = async () => {
    await tap("phone", phone.getByRole("button", { name: /카메라 시작/ }));
    await phone.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
    const s = await phone.evaluate(() => window.__ppv.state);
    if (s.mode === "error") throw new Error(JSON.stringify(s.error));
    let calibrated = false;
    if (s.mode === "calibrating") {
      calibrated = true;
      for (const c of corners) {
        const pt = await phone.evaluate(([x, y]) => {
          const v = document.querySelector("video.stage__video") || document.querySelector("video");
          const r = v.getBoundingClientRect();
          const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
          return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
        }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
        await phone.mouse.click(pt.x, pt.y);
        taps.phone++;
        await phone.waitForTimeout(300);
      }
      await tap("phone", phone.getByRole("button", { name: /확인/ }));
      await phone.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 20000 });
    }
    return { calibrated, video: s.video };
  };
  // Playwright's WPE build can skip init scripts after a page-led navigation; open the same URL
  // once more so the fake camera applies. Test rig only, not a tap (recorded as reopens).
  const ensureRig = async () => {
    await phone.waitForFunction(() => !!window.__ppv, null, { timeout: 20000 });
    let reopens = 0;
    while (!(await phone.evaluate(() => String(navigator.mediaDevices.getUserMedia).includes("captureStream"))) && reopens < 3) {
      reopens++;
      await phone.goto(origin + "/vision/", { waitUntil: "load" });
      await phone.waitForFunction(() => !!window.__ppv, null, { timeout: 20000 });
    }
    return reopens;
  };
  const shotPhone = (name) => phone.screenshot({ path: `${out}/${name}.png` }).catch(() => {});

  // ---- C (before): what the referee screen can fix, on this phone, before the camera runs ----
  if (flow === "before") {
    await step("referee-screen-fix-depth", async () => {
      await phone.goto(origin + "/?role", { waitUntil: "load" });
      await tap("phone", phone.locator("[data-act=role][data-role=referee]").first());
      await phone.waitForSelector(".pane[data-side='0']:not([disabled])", { timeout: 15000 });
      const res = {};
      // (1) the point two back went to the wrong side: blue 2 back should have been red
      await seed([0, 1, 0, 1]);
      await phone.reload({ waitUntil: "load" });
      await phone.waitForSelector(".pane[data-side='0']:not([disabled])", { timeout: 15000 });
      let t = taps.phone, t0 = Date.now();
      for (let i = 0; i < 2; i++) {
        const n = (await log()).length;
        await synced();
        await tap("phone", phone.locator("[data-act=undo]").first());
        await waitFor("undo", async () => (await log()).length === n - 1, 8000);
      }
      for (const side of [1, 1]) {
        const n = (await log()).length;
        await synced();
        await tap("phone", phone.locator(`.pane[data-side='${side}']`).first());
        await waitFor("point", async () => (await log()).length === n + 1, 8000);
      }
      res.twoBack = { from: [0, 1, 0, 1], to: await log(), want: [0, 1, 1, 1], taps: taps.phone - t, seconds: (Date.now() - t0) / 1000 };
      await shotPhone("referee-two-back-fixed");
      // (2) a game ended by a wrong point (blue 11:9 should be 10:10)
      const tenNine = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
      await seed([...tenNine, 0]);
      await phone.reload({ waitUntil: "load" });
      await phone.waitForSelector(".pane[data-side='0']:not([disabled])", { timeout: 15000 });
      const notice = await phone.locator(".ref-notice, .banner.game").count();
      t = taps.phone; t0 = Date.now();
      let n = (await log()).length;
      await synced();
      await tap("phone", phone.locator("[data-act=undo]").first());
      await waitFor("undo", async () => (await log()).length === n - 1, 8000);
      n = (await log()).length;
      await synced();
      await tap("phone", phone.locator(".pane[data-side='1']").first());
      await waitFor("point", async () => (await log()).length === n + 1, 8000);
      const m = await match();
      res.gameFix = { gameBannerShown: notice, score: m.score.current, games: m.score.games.length, taps: taps.phone - t, seconds: (Date.now() - t0) / 1000 };
      // (3) how far back: undo one at a time down to the first point of the match
      const all = (await log()).length;
      let undone = 0;
      for (; undone < all; undone++) {
        const k = (await log()).length;
        const r = await H({ type: "undo", matchId, seq: k });
        if (r.status !== 200) break;
      }
      res.depth = { points: all, undoneOneByOne: undone, note: "되돌리기는 마지막 점수부터 하나씩, 경기 첫 점수까지. 가운데 한 점만 고치는 버튼은 없음" };
      if (JSON.stringify(res.twoBack.to) !== JSON.stringify(res.twoBack.want)) throw new Error(`two back: ${JSON.stringify(res.twoBack)}`);
      if (m.score.current.a !== 10 || m.score.current.b !== 10 || m.score.games.length !== 0) throw new Error(`game fix: ${JSON.stringify(res.gameFix)}`);
      return res;
    }, { shoot: () => phone });
    await seed([]);
    // setup, not measured: this phone goes back to being the camera (the owner's phone already is)
    await phone.evaluate(() => localStorage.setItem("pp-role", "camera"));
  }

  await step("phone-open-camera-start", async () => {
    await phone.goto(origin + "/", { waitUntil: "load" });
    const reopens = await ensureRig();
    await phone.waitForFunction(() => window.__ppv?.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 20000 });
    const cal = await startCameraAndCalibrate();
    await waitFilming("filming");
    return { address: new URL(phone.url()).pathname, reopens, ...cal, note: "처음 한 번: 시작 + 모서리 4 + 확인 (비교 대상 아님)" };
  }, { shoot: () => phone });
  for (const k of Object.keys(taps)) taps[k] = 0;

  if (flow === "panel") {
    await step(`panel-layout-${args.vp || "p852"}`, async () => {
      await clip(false);
      await seed([0, 1, 0]);
      await phone.waitForFunction(() => (((window.__ppv.state.tour.fix || {}).target || {}).log || []).length >= 3, null, { timeout: 8000 });
      if (!(await phone.locator(".fix:visible").count())) await tap("phone", phone.locator(".chip--fix"));
      await phone.waitForSelector(".fix:not([hidden]) .fix__recent button", { timeout: 8000 });
      await clip(true);
      const t0 = Date.now();
      await waitFilming("filming with the panel open", 15000);
      const m = await phone.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
        const vw = innerWidth, vh = innerHeight;
        const panel = document.querySelector(".fix");
        const P = r(panel);
        const hit = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
        const out = { vw, vh, panel: P, small: [], outside: [], overlaps: [], clipped: [] };
        if (P.x < 0 || P.y < 0 || P.r > vw + 0.5 || P.b > vh + 0.5) out.outside.push("panel");
        for (const el of panel.querySelectorAll("button")) {
          const b = r(el);
          if (b.w < 44 || b.h < 44) out.small.push([el.className, Math.round(b.w), Math.round(b.h)]);
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.clipped.push(el.className);
        }
        // +1 / 되돌리기 labels stay on one line (a wrapped "되돌/리기" is not an overflow)
        out.wrapped = [];
        for (const el of panel.querySelectorAll(".fix__row button")) {
          const tops = new Set();
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            if (!n.textContent.trim()) continue;
            const rg = document.createRange();
            rg.selectNodeContents(n);
            for (const rc of rg.getClientRects()) tops.add(Math.round(rc.top));
          }
          if (tops.size > 1) out.wrapped.push(el.className);
        }
        for (const sel of [".bar", ".strip", ".pointbar", ".glance"]) {
          const e = document.querySelector(sel);
          if (e && !e.hidden && getComputedStyle(e).display !== "none" && hit(P, r(e))) out.overlaps.push(sel);
        }
        const chip = r(document.querySelector(".chip--fix"));
        out.chip = chip;
        if (chip.w < 1 || chip.r > vw || chip.b > vh) out.outside.push("chip");
        const strip = document.querySelector(".strip");
        out.stripOverflow = strip.scrollWidth > strip.clientWidth + 1;
        const v = document.querySelector(".stage__video");
        out.videoVisible = (() => { const b = r(v); return b.w > 0 && b.h > 0; })();
        out.fit = document.querySelector(".app").dataset.fit;
        return out;
      });
      await shotPhone(`panel-${args.vp || "p852"}`);
      const fails = [];
      if (m.small.length) fails.push(`small ${JSON.stringify(m.small)}`);
      if (m.outside.length) fails.push(`outside ${m.outside}`);
      if (m.overlaps.length) fails.push(`overlaps ${m.overlaps}`);
      if (m.clipped.length) fails.push(`clipped ${m.clipped}`);
      if (m.wrapped.length) fails.push(`wrapped ${m.wrapped}`);
      if (m.stripOverflow) fails.push("strip overflow");
      const cam = filming(t0, Date.now());
      if (!cam.filmingShare) fails.push("camera not filming");
      if (fails.length) throw new Error(fails.join("; "));
      return { ...m, camera: cam };
    }, { shoot: () => phone });
  } else {
  // ---- A: an auto point, then [취소] inside the 3 s ----
  await step("auto-point-cancel-in-3s", async () => {
    const got = await phone.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const t0 = Date.now();
          let seenAt = null;
          const tick = () => {
            if (Date.now() - t0 > 300000) return reject(new Error("no point in 300 s"));
            const p = window.__ppv.state.tour.pending;
            const btn = document.querySelector(".pointbar__cancel");
            if (p && !p.choice && btn && !btn.hidden) {
              seenAt = seenAt || Date.now();
              // a person reads it first: tap about 1.5 s after the bar shows
              if (Date.now() - seenAt >= 1500) {
                const snap = JSON.parse(JSON.stringify(p));
                const label = btn.textContent;
                btn.click();
                return resolve({ snap, label, shownForMs: Date.now() - seenAt, windowMs: p.until - seenAt });
              }
            }
            setTimeout(tick, 50);
          };
          tick();
        }),
    );
    taps.phone++;
    const t0 = Date.now();
    await waitFor("undo", async () => (await match()).points.length === got.snap.seq - 1, 8000);
    const undoMs = Date.now() - t0;
    await shotPhone("auto-point-cancelled");
    return { side: got.snap.side, reason: got.snap.reason, score: got.snap.score, cancelLabel: got.label, tappedAfterMs: got.shownForMs, cancelWindowMs: got.windowMs, undoLandedMs: undoMs };
  }, { shoot: () => phone });

  // ---- B: the last point went to the wrong side; fix it on this phone and keep filming ----
  if (flow === "before") {
    await step("fix-last-point-via-referee-role", async () => {
      const L0 = await seed([0, 1, 0]);
      const want = [0, 1, 1];
      const t0 = Date.now();
      const tp = taps.phone;
      await tap("phone", phone.locator(".strip [data-back]").first());
      await phone.getByRole("button", { name: "멈추고 나가기" }).click();
      await phone.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
      await phone.waitForSelector("[data-act=role][data-role=referee]", { timeout: 15000 });
      await shotPhone("before-role-picker");
      await tap("phone", phone.locator("[data-act=role][data-role=referee]").first());
      await phone.waitForSelector(".pane[data-side='0']:not([disabled])", { timeout: 15000 });
      await shotPhone("before-referee-screen");
      let n = (await log()).length;
      await synced();
      await tap("phone", phone.locator("[data-act=undo]").first());
      await waitFor("undo", async () => (await log()).length === n - 1, 8000);
      n = (await log()).length;
      await synced();
      await tap("phone", phone.locator(".pane[data-side='1']").first());
      await waitFor("point", async () => (await log()).length === n + 1, 8000);
      const fixedAt = Date.now();
      const fixed = await log();
      await tap("phone", phone.locator("nav.roles [data-role=camera]").first());
      const reopens = await ensureRig();
      const back = await phone.evaluate(() => window.__ppv.state.mode);
      const needStart = back !== "running";
      await shotPhone("before-back-on-camera");
      let cal = { calibrated: false };
      if (needStart) cal = await startCameraAndCalibrate();
      await waitFilming("filming again");
      const t1 = Date.now();
      return {
        from: L0, to: fixed, want, fixedOk: JSON.stringify(fixed.slice(0, 3)) === JSON.stringify(want),
        tapsToFix: taps.phone - tp - 1 - (needStart ? 1 : 0) - (cal.calibrated ? 5 : 0) , tapsTotal: taps.phone - tp,
        secondsToFix: (fixedAt - t0) / 1000, secondsUntilFilmingAgain: (t1 - t0) / 1000,
        modeOnReturn: back, needCameraStart: needStart, needCalibration: cal.calibrated, rigReopens: reopens,
        camera: filming(t0, t1),
      };
    }, { shoot: () => phone });
  } else {
    await step("fix-last-point-on-camera-screen", async () => {
      await clip(false);
      const L0 = await seed([0, 1, 0]);
      const want = [0, 1, 1];
      await phone.waitForFunction(() => JSON.stringify((((window.__ppv.state.tour.fix || {}).target || {}).log || []).slice(0, 3)) === "[0,1,0]", null, { timeout: 8000 });
      const t0 = Date.now();
      const tp = taps.phone;
      await tap("phone", phone.locator(".chip--fix"));
      await phone.waitForSelector(".fix:not([hidden]) .fix__recent button[data-index='2']", { timeout: 8000 });
      await shotPhone("after-fix-panel-open");
      // the point that went wrong is index 2 (a rally still running when people stopped can end
      // and add one more auto point after it; that one is not the one being fixed)
      await tap("phone", phone.locator(".fix__recent button[data-index='2']"));
      await waitFor("flip", async () => JSON.stringify((await log()).slice(0, 3)) === JSON.stringify(want), 10000);
      const t1 = Date.now();
      await shotPhone("after-fix-last-flipped");
      return { from: L0, to: await log(), want, tapsToFix: taps.phone - tp, secondsToFix: (t1 - t0) / 1000, mode: await phone.evaluate(() => window.__ppv.state.mode), camera: filming(t0, t1 + 400) };
    }, { shoot: () => phone });
    await step("fix-two-back-and-game-on-camera-screen", async () => {
      const res = {};
      await seed([0, 1, 0, 1]);
      await phone.waitForFunction(() => JSON.stringify(((window.__ppv.state.tour.fix || {}).target || {}).log) === "[0,1,0,1]", null, { timeout: 8000 });
      let t0 = Date.now(), tp = taps.phone;
      const open = await phone.locator(".fix:not([hidden])").count();
      if (!open) await tap("phone", phone.locator(".chip--fix"));
      await phone.waitForSelector(".fix__recent button[data-index='2']", { timeout: 8000 });
      await tap("phone", phone.locator(".fix__recent button[data-index='2']"));
      await waitFor("flip 2 back", async () => JSON.stringify((await log()).slice(0, 4)) === "[0,1,1,1]", 10000);
      res.twoBack = { from: [0, 1, 0, 1], to: await log(), want: [0, 1, 1, 1], panelWasOpen: !!open, taps: taps.phone - tp, seconds: (Date.now() - t0) / 1000 };
      await shotPhone("after-two-back-fixed");
      const tenNine = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
      await seed([...tenNine, 0]);
      await phone.waitForFunction(() => (((window.__ppv.state.tour.fix || {}).target || {}).log || []).length === 20, null, { timeout: 8000 });
      t0 = Date.now(); tp = taps.phone;
      await phone.waitForSelector(".fix__recent button[data-index='19']", { timeout: 8000 });
      await tap("phone", phone.locator(".fix__recent button[data-index='19']"));
      await waitFor("game fix", async () => { const m = await match(); return m.score.current.a === 10 && m.score.current.b === 10 && m.score.games.length === 0; }, 10000);
      res.gameFix = { score: (await match()).score.current, taps: taps.phone - tp, seconds: (Date.now() - t0) / 1000 };
      await shotPhone("after-game-fixed");
      // +1 and 되돌리기 on their own
      const n = (await log()).length;
      await tap("phone", phone.locator(".fix__plus[data-side='0']"));
      await waitFor("+1", async () => (await log()).length === n + 1, 8000);
      await tap("phone", phone.locator(".fix__undo"));
      await waitFor("undo", async () => (await log()).length === n, 8000);
      res.plusUndo = "ok";
      res.camera = filming(t0, Date.now());
      return res;
    }, { shoot: () => phone });
  }

  await step("camera-keeps-judging-after-fix", async () => {
    await clip(true);
    const n = (await log()).length;
    await waitFor("next auto point", async () => (await log()).length > n, 240000);
    return { before: n, after: (await log()).length, mode: await phone.evaluate(() => window.__ppv.state.mode) };
  }, { shoot: () => phone });

  }
  if (flow === "after") {
    await step("pinless-camera-has-no-fix-panel", async () => {
      // the PIN phone shows the chip; the same camera without the PIN writes nothing at all, so no chip
      // (a second fake-camera WebKit page crashes this host's WPE build, so the PIN on this page is
      // taken away, then put back)
      const withPin = await phone.locator(".chip--fix:visible").count();
      if (!(await phone.locator(".fix:visible").count())) await tap("phone", phone.locator(".chip--fix"));
      await phone.waitForSelector(".fix:not([hidden])", { timeout: 5000 });
      const r = await phone.evaluate(async () => {
        const t = window.__ppv.venue.tour;
        const pin = t.pin;
        t.pin = null;
        t.onChange();
        await new Promise((res) => setTimeout(res, 600));
        const out = { connected: window.__ppv.state.tour.connected, approval: window.__ppv.state.tour.approval, chip: !!document.querySelector(".chip--fix:not([hidden])"), panel: !!document.querySelector(".fix:not([hidden])"), fixResult: await t.fix("plus", 0) };
        t.pin = pin;
        t.onChange();
        return out;
      });
      await shotPhone("pinless-camera-no-chip");
      if (!withPin) throw new Error("PIN phone has no fix chip");
      if (r.connected || r.approval !== null || r.chip || r.panel || r.fixResult !== null) throw new Error(JSON.stringify(r));
      return { withPin, pinless: r };
    });
  }
} finally {
  sampling = false;
  await sampler.catch(() => {});
  if (phone) report.said.phone = await said(phone).catch(() => null);
  report.tournament = await state().then((s) => ({ rev: s.rev, points: s.derived.matches.map((m) => [m.id, m.points.length]) })).catch(() => null);
  report.totals = { taps: Object.values(taps).reduce((a, b) => a + b, 0) };
  report.samples = samples.length;
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${out}/samples.json`, JSON.stringify(samples));
  await phoneBrowser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
}
console.log(`ONE_PHONE_E2E flow=${flow} ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")}`);
process.exit(steps.every((s) => s.pass) ? 0 : 1);
