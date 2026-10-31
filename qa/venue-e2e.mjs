// The owner's venue scenario end to end, measured: taps and seconds per step, what works, where it sticks.
// Both real servers (tournament app at "/", vision at "/vision/") run behind one small proxy, so
// it is one origin with WebSocket, as on the Funnel host. The phone is WebKit (Safari engine) at
// iPhone 15 size with a fake camera (a test clip drawn into a canvas stream); the TV is Chromium
// at 1920x1080. Speech is recorded per device (window.__said); headless browsers have no audio.
//   --flow=before   today's flow: vision settings -> tournament PIN; TV just watches
//   --flow=after    one app: the phone (already holding the PIN) taps 카메라, the TV taps 관람
//   --extras        after only: reload resume, a PIN-less camera asks for the PIN (no referee
//                   approval, camera tokens refused), PIN lockout untouched, camera / server cut-off and auto reconnect,
//                   two live matches -> the camera asks which one
//   bun qa/venue-e2e.mjs --flow=after --vision=<checkout> --tournament=<checkout> --clip=<webm>
//     [--corners='<json, 1920x1080>'] [--out=evidence/r6/after] [--phone-engine=webkit|chromium]
import { chromium, devices, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const flow = args.flow || "after";
const out = args.out || `evidence/r6/${flow}`;
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-venue-"));
const P = Number(args.port || 8880);
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
const tvBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const iphone = devices["iPhone 15"];
const phoneCtx = async (preset = {}) => {
  const ctx = await phoneBrowser.newContext(engine === webkit ? { ...iphone } : { viewport: iphone.viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
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
let tv = null;
const report = { flow, steps, taps, errors, said: {} };
try {
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "탁구장 시험", players: ["블루선수", "레드선수", "셋째", "넷째"], format: "double", bestOf: 3 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId, note: "오너 폰에서 대회를 만들어 PIN이 이 폰에 저장된 상태로 시작(측정 대상 아님)" };
  }, { device: "setup" });
  const key = readFileSync(join(tmp, "upload-key"), "utf8").trim();
  // Already set up before the venue (one-time link from an earlier day): PC save key, and the
  // tournament app on this phone holds the PIN because the owner created the tournament on it. Auto entry
  // "모든 포인트" is a test setting so every judged point is entered (not counted as a tap).
  const phonePreset = { "pp-pin": pin, "ppv.uploadKey": JSON.stringify(key), "ppv.tourMode": JSON.stringify("all") };

  const cphone = await phoneCtx(phonePreset);
  phone = await cphone.newPage();
  watch(phone, "phone");
  const ctv = await tvBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctv.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctv.addInitScript(recordSpeech);
  tv = await ctv.newPage();
  watch(tv, "tv");

  const startCameraAndCalibrate = async () => {
    await tap("phone", phone.getByRole("button", { name: /카메라 시작/ }));
    await phone.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
    const s = await phone.evaluate(() => window.__ppv.state);
    if (s.mode === "error") throw new Error(JSON.stringify(s.error));
    if (s.mode === "calibrating") {
      for (const c of corners) {
        const pt = await phone.evaluate(([x, y]) => {
          const v = document.querySelector("video");
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
    const speech = await phone.evaluate(() => ({ said: window.__said, wrapped: /__said/.test(String(window.speechSynthesis && window.speechSynthesis.speak)), voice: localStorage.getItem("ppv.tourVoice") }));
    return { video: s.video, mode: await phone.evaluate(() => window.__ppv.state.mode), speech };
  };

  if (flow === "before") {
    await step("phone-open-vision-start", async () => {
      await phone.goto(origin + "/vision/", { waitUntil: "networkidle" });
      return await startCameraAndCalibrate();
    }, { shoot: () => phone });
    await step("phone-settings-pin-link", async () => {
      await tap("phone", phone.getByRole("button", { name: /설정/ }).first());
      await tap("phone", phone.locator("input[name=tournament-pin]"));
      await phone.locator("input[name=tournament-pin]").pressSequentially(pin);
      taps.phone += pin.length;
      await tap("phone", phone.getByRole("button", { name: /^연결$/ }));
      await phone.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 10000 });
      await tap("phone", phone.locator(".popover button[aria-label='설정 닫기']"));
      return { matchId: await phone.evaluate(() => window.__ppv.state.tour.matchId), keystrokes: pin.length };
    }, { shoot: () => phone });
    await step("tv-open-watch", async () => {
      await tv.goto(origin + "/", { waitUntil: "networkidle" });
      const askLink = await tv.getByText(/연동할까요|비전 앱이 켜져/).count();
      const soundToggle = await tv.getByRole("button", { name: /소리/ }).count();
      return { askLink, soundToggle, note: "TV는 보기만: 연동 물음 없음, 소리 켜기 없음" };
    }, { device: "tv", shoot: () => tv });
  } else {
    await step("phone-open-root-role-camera", async () => {
      await phone.goto(origin + "/", { waitUntil: "networkidle" });
      const picker = await phone.locator(".role-ask").isVisible();
      await phone.screenshot({ path: `${out}/phone-root-role-picker.png` });
      await tap("phone", phone.locator("nav.roles [data-role=camera]"));
      await phone.waitForFunction(() => !!window.__ppv, null, { timeout: 15000 });
      // Playwright's WPE build skips init scripts (fake camera, speech recorder) after a page-led
      // navigation; open the same URL once more so they apply. Test rig only, not a tap.
      const injected = () => phone.evaluate(() => String(navigator.mediaDevices.getUserMedia).includes("captureStream"));
      const before = await injected();
      let reopens = 0;
      while (!(await injected()) && reopens < 3) {
        reopens++;
        await phone.goto(origin + "/vision/", { waitUntil: "load" });
      }
      const raw = await phone.evaluate(() => ({ gum: String(navigator.mediaDevices && navigator.mediaDevices.getUserMedia).slice(0, 160), said: typeof window.__said, url: location.href }));
      const address = new URL(phone.url()).pathname;
      if (address !== "/") throw new Error(`camera screen shows ${address}, not the one address`);
      return { pickerShownDespitePin: picker, address, testRig: { injectedAfterNav: before, reopens, injected: await injected(), raw } };
    }, { shoot: () => phone });
    await step("phone-auto-link-no-question", async () => {
      await phone.waitForFunction(() => window.__ppv?.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 15000 });
      return { tour: await phone.evaluate(() => ({ approval: window.__ppv.state.tour.approval, ws: window.__ppv.state.tour.ws, matchId: window.__ppv.state.tour.matchId })) };
    }, { shoot: () => phone });
    await step("phone-start-calibrate", startCameraAndCalibrate, { shoot: () => phone });
    await step("tv-open-role-viewer", async () => {
      await tv.goto(origin + "/", { waitUntil: "networkidle" });
      const picker = await tv.locator(".role-ask").isVisible();
      await tap("tv", tv.locator("nav.roles [data-role=viewer]"));
      await tv.waitForSelector("[data-sound=on]", { timeout: 10000 });
      await tv.waitForSelector("[data-camera=linked]", { timeout: 15000 });
      return { picker, camera: (await tv.locator("[data-camera]").first().innerText()).trim(), sound: (await tv.locator("[data-sound]").innerText()).trim() };
    }, { device: "tv", shoot: () => tv });
  }

  const phoneState = () => phone.evaluate(() => ({ pending: window.__ppv.state.tour.pending, barHidden: document.querySelector(".pointbar")?.hidden, cancelHidden: document.querySelector(".pointbar__cancel")?.hidden, mode: window.__ppv.state.mode, fps: window.__ppv.state.perf.fps, rally: window.__ppv.state.rally, tour: { connected: window.__ppv.state.tour.connected, matchId: window.__ppv.state.tour.matchId, error: window.__ppv.state.tour.error, ws: window.__ppv.state.tour.ws }, said: window.__said }));
  await step("first-point-cancel-in-3s", async () => {
    const pending = await phone.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const t0 = Date.now();
          const tick = () => {
            if (Date.now() - t0 > 300000) return reject(new Error("no point in 300 s"));
            const p = window.__ppv.state.tour.pending;
            const btn = document.querySelector(".pointbar__cancel");
            if (p && !p.choice && btn && !btn.hidden) {
              const snap = JSON.parse(JSON.stringify(p));
              btn.click();
              return resolve(snap);
            }
            setTimeout(tick, 50);
          };
          tick();
        }),
    ).catch(async (err) => { throw new Error(`${err.message} ${JSON.stringify(await phoneState())} errors=${JSON.stringify(errors.slice(-6))}`); });
    taps.phone++;
    await waitFor("undo", async () => (await match()).points.length === pending.seq - 1, 8000);
    await Bun.sleep(1500);
    return { pending: { seq: pending.seq, side: pending.side, score: pending.score, reason: pending.reason }, phoneSaid: await said(phone), tvSaid: await said(tv) };
  }, { shoot: () => phone });

  await step("next-point-score-sound-clip", async () => {
    await phone.waitForFunction(() => window.__ppv.state.tour.pending && !window.__ppv.state.tour.pending.choice, null, { timeout: 400000, polling: 100 });
    await waitFor("point entered", async () => (await match()).points.length >= 1, 8000);
    await Bun.sleep(2500);
    const phoneSaid = await said(phone);
    const tvSaid = await said(tv);
    const tvScore = await tv.evaluate(() => [...document.querySelectorAll(".pscore")].map((e) => e.textContent.trim()));
    let clip = null;
    try {
      const m = await waitFor("clip attached", async () => {
        const x = await match();
        return x.clips && x.clips[0] ? x : null;
      }, 90000);
      clip = m.clips[0];
      await tv.waitForSelector("video[data-clip-video]", { timeout: 15000 });
    } catch (err) {
      clip = `none: ${err.message}`;
    }
    const callout = /사이드 \d+/;
    const where = { phone: phoneSaid.filter((t) => callout.test(t)), tv: tvSaid.filter((t) => callout.test(t)) };
    const recorder = await phone.evaluate(() => window.__ppv.state.save);
    const detail = { tvScore, where, clip, recorder, phoneSaid, tvSaid };
    if (flow === "after" && (!where.tv.length || where.phone.length)) throw new Error(`call-out should be on the TV only: ${JSON.stringify(where)}`);
    if (flow === "before" && !where.phone.length) throw new Error(`no call-out on the phone: ${JSON.stringify(where)}`);
    return detail;
  }, { device: "tv", shoot: () => tv });
  await tv.screenshot({ path: `${out}/tv-final.png` });
  await phone.screenshot({ path: `${out}/phone-final.png` });

  if (flow === "after" && "extras" in args) {
    await step("reload-both-resume-no-question", async () => {
      const before = (await match()).points.length;
      await phone.reload({ waitUntil: "networkidle" });
      await tv.reload({ waitUntil: "networkidle" });
      const phoneRole = new URL(phone.url()).pathname;
      await phone.waitForFunction(() => window.__ppv?.state.tour.connected && window.__ppv.state.tour.ws === "online", null, { timeout: 15000 });
      await tv.waitForSelector("[data-camera]", { timeout: 15000 });
      const tvSound = await tv.locator("[data-sound]").getAttribute("data-sound");
      const asks = await tv.locator(".role-ask").count();
      await tap("tv", tv.locator("main"));
      await tv.waitForSelector("[data-sound=on]", { timeout: 10000 });
      return { phoneRole, before, tvSoundAfterReload: tvSound, asks, note: "브라우저 규칙: 새로 연 TV는 한 번 눌러야 소리가 남(그 전엔 폰이 대신 말함)" };
    }, { device: "tv", shoot: () => tv });

    await step("camera-cut-shown-both-reconnect", async () => {
      await fetch(origin + "/__qa/cut?who=camera&ms=6000");
      const t0 = Date.now();
      await phone.waitForFunction(() => window.__ppv.state.tour.ws === "offline", null, { timeout: 15000 });
      const phoneShown = (Date.now() - t0) / 1000;
      await tv.waitForSelector("[data-camera=offline]", { timeout: 20000 });
      const tvShown = (Date.now() - t0) / 1000;
      const phoneChip = await phone.locator(".strip .chip--role").first().innerText();
      await phone.screenshot({ path: `${out}/cut-phone.png` });
      await tv.screenshot({ path: `${out}/cut-tv.png` });
      await phone.waitForFunction(() => window.__ppv.state.tour.ws === "online", null, { timeout: 30000 });
      await tv.waitForSelector("[data-camera=linked]", { timeout: 30000 });
      const back = (Date.now() - t0) / 1000;
      return { phoneShown, tvShown, phoneChip, backAfter: back };
    }, { shoot: () => tv });

    await step("server-cut-tv-reconnects", async () => {
      await fetch(origin + "/__qa/cut?who=all&ms=4000");
      const t0 = Date.now();
      await tv.waitForSelector(".dot.offline", { timeout: 10000 });
      await tv.waitForSelector(".dot.online", { timeout: 30000 });
      await tv.waitForSelector("[data-sound=on]", { timeout: 15000 });
      return { tvBackAfter: (Date.now() - t0) / 1000 };
    }, { device: "tv", shoot: () => tv });

    const padCtx = await tvBrowser.newContext({ viewport: { width: 1024, height: 768 } });
    await padCtx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
    const pad = await padCtx.newPage();
    watch(pad, "pad");
    let phone2 = null;
    await step("pinless-camera-asks-pin", async () => {
      // owner decision 2026-10-31: no referee approval; a camera without the PIN writes nothing until it types it
      const c2 = await phoneCtx({ "pp-role": "camera" });
      phone2 = await c2.newPage();
      await phone2.goto(origin + "/vision/", { waitUntil: "load" });
      await phone2.waitForFunction(() => window.__ppv?.state.tour.ws === "online", null, { timeout: 15000 });
      const waitingText = await phone2.locator(".screen__role .chip--role").innerText();
      const pinField = await phone2.locator('.screen--intro input[name="intro-pin"]').isVisible();
      await pad.addInitScript((p) => { localStorage.setItem("pp-pin", p); localStorage.setItem("pp-role", "referee"); }, pin);
      await pad.goto(origin + "/", { waitUntil: "load" });
      await pad.waitForSelector("[data-camera]", { timeout: 15000 });
      await pad.screenshot({ path: `${out}/pad-camera-pin.png` });
      const approveButtons = (await pad.locator("[data-act=camera-approve]").count()) + (await tv.locator("[data-act=camera-approve]").count());
      await phone2.screenshot({ path: `${out}/phone2-needs-pin.png` });
      await phone2.locator('.screen--intro input[name="intro-pin"]').fill(pin);
      await tap("phone", phone2.locator(".screen--intro .screen__pin button"));
      await phone2.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.approval === "pin", null, { timeout: 15000 });
      await phone2.screenshot({ path: `${out}/phone2-pin.png` });
      const kept = await phone2.evaluate(() => localStorage.getItem("pp-pin"));
      if (!/PIN을 넣어야 점수가 기록돼요/.test(waitingText) || !pinField || approveButtons !== 0 || kept !== pin) throw new Error(JSON.stringify({ waitingText, pinField, approveButtons, kept: kept === pin }));
      return { waitingText, pinField, approveButtons, ppPinSaved: true };
    }, { device: "phone", shoot: () => phone2 });

    await step("camera-pin-only-and-pin-rules", async () => {
      const tk = { "x-vision-token": "x".repeat(43) };
      const r = {};
      r.rename = (await api("/api/action", { type: "rename", index: 2, name: "해킹" }, tk)).status;
      r.setup = (await api("/api/action", { type: "setup", players: ["a", "b", "c"], format: "double", bestOf: 3 }, tk)).status;
      r.firstServer = (await api("/api/action", { type: "firstServer", matchId: "m2", side: 1 }, tk)).status;
      r.newTournament = (await api("/api/tournament", { name: "x", players: ["a", "b", "c"] }, tk)).status;
      r.approveWithPin = (await api("/api/vision/approve", { id: "a".repeat(64) }, { "x-pin": pin })).status;
      r.claim = (await api("/api/vision/claim", { secret: "a".repeat(43) })).status;
      r.pointWithToken = (await api("/api/action", { type: "point", matchId: "m2", side: 0, seq: 0 }, tk)).status;
      r.undoWithToken = (await api("/api/action", { type: "undo", matchId: "m2", seq: 0 }, tk)).status;
      const ip = { "x-forwarded-for": "198.51.100.99" };
      r.wrongPin = [];
      for (let i = 0; i < 6; i++) r.wrongPin.push((await api("/api/pin/verify", { pin: "0000" === pin ? "1111" : "0000" }, ip)).status);
      r.rightPinWhileLocked = (await api("/api/pin/verify", { pin }, ip)).status;
      const names = (await state()).tournament.players;
      const ok = [r.rename, r.setup, r.firstServer, r.newTournament, r.approveWithPin, r.claim, r.pointWithToken, r.undoWithToken].every((s) => s === 403)
        && r.wrongPin.slice(0, 5).every((s) => s === 403) && r.wrongPin[5] === 429 && r.rightPinWhileLocked === 429 && !names.includes("해킹");
      if (!ok) throw new Error(JSON.stringify(r));
      return r;
    }, { device: "api" });

    await step("old-camera-link-one-address", async () => {
      const c4 = await phoneCtx({});
      const old = await c4.newPage();
      await old.goto(origin + "/vision/", { waitUntil: "load" });
      await old.waitForFunction(() => !!window.__ppv, null, { timeout: 15000 });
      const r = { address: new URL(old.url()).pathname, role: await old.evaluate(() => localStorage.getItem("pp-role")), cameraScreen: await old.getByRole("button", { name: /카메라 시작/ }).isVisible() };
      await old.reload({ waitUntil: "load" });
      await old.waitForFunction(() => !!window.__ppv, null, { timeout: 15000 });
      r.afterReload = new URL(old.url()).pathname;
      r.cameraAfterReload = await old.getByRole("button", { name: /카메라 시작/ }).isVisible();
      await old.screenshot({ path: `${out}/old-camera-link.png` });
      await c4.close();
      if (r.address !== "/" || r.role !== "camera" || !r.cameraScreen || r.afterReload !== "/" || !r.cameraAfterReload) throw new Error(JSON.stringify(r));
      return r;
    }, { device: "phone2" });

    await step("two-live-matches-camera-asks", async () => {
      for (const id of ["m1", "m2"]) {
        const m = await match(id);
        if (m.points.length === 0) await api("/api/action", { type: "point", matchId: id, side: 0, seq: 0 }, { "x-pin": pin });
      }
      const c3 = await phoneCtx({ "pp-pin": pin });
      const phone3 = await c3.newPage();
      await phone3.goto(origin + "/vision/", { waitUntil: "load" });
      await phone3.waitForFunction(() => window.__ppv?.state.tour.connected && window.__ppv.state.tour.needPick, null, { timeout: 15000 });
      const ask = await phone3.locator(".screen__role .chip--role").innerText();
      await phone3.screenshot({ path: `${out}/phone3-which-match.png` });
      await c3.close();
      return { ask, live: ["m1", "m2"] };
    }, { device: "phone2" });
    await phone2?.context().close();
  }
} finally {
  report.said.phone = phone ? await said(phone).catch(() => null) : null;
  report.said.tv = tv ? await said(tv).catch(() => null) : null;
  report.tournament = await state().then((s) => ({ rev: s.rev, points: s.derived.matches.map((m) => [m.id, m.points.length, Object.keys(m.clips).length]) })).catch(() => null);
  report.totals = { taps: Object.values(taps).reduce((a, b) => a + b, 0), seconds: Math.round(steps.reduce((a, s) => a + s.seconds, 0)) };
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  await phoneBrowser.close().catch(() => {});
  await tvBrowser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
}
console.log(`VENUE_E2E flow=${flow} ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")} taps=${report.totals.taps}`);
process.exit(steps.every((s) => s.pass) ? 0 : 1);
