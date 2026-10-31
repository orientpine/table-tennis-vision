// The owner's red / blue ends, measured on the real screens (Chromium, real Galmuri font): the table's two
// ends keep their colour, the players move. A camera phone (393x852), a referee phone and a TV viewer
// (1920x1080) watch one isolated tournament behind one origin (as on the Funnel host).
//   S1 not linked: the camera calls the ends "블루 사이드" / "레드 사이드", no 나 / 상대 anywhere
//   S2 linked: "블루 · 김블루" / "레드 · 넷째" (the players of the match, by the end they stand at)
//   S3 자리 교체: names trade ends; each end keeps its colour and place
//   S4 after a game, and at 5 in the deciding game, the ends change by themselves with "엔드 교체"
//   every step: camera, referee and TV agree on who stands at which end, and the card colour is the
//   camera's colour of that end
//   bun qa/sides-e2e.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --tag=before|after
//     [--out=evidence/sides/<tag>] [--port=9900]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const tag = args.tag || "after";
const out = args.out || `evidence/sides/${tag}`;
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners || '[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]');
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-sides-"));
const P = Number(args.port || 9900);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };

const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(tmp, "tour", "tournament.json"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") },
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

const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
const proxy = Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/__qa/cam.webm") return new Response(Bun.file(args.clip), { headers: { "content-type": "video/webm" } });
    if (req.headers.get("upgrade") === "websocket") return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("no", { status: 400 });
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
      ws.data.back?.close();
    },
  },
});
const origin = `http://127.0.0.1:${ports.proxy}`;
const api = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const steps = [];
const step = async (name, fn) => {
  let rec;
  try {
    rec = { name, pass: true, detail: await fn() };
  } catch (err) {
    rec = { name, pass: false, detail: String(err.message || err).split("\n")[0] };
  }
  steps.push(rec);
  console.log(`STEP ${name} ${rec.pass ? "PASS" : "FAIL"} ${JSON.stringify(rec.detail).slice(0, 400)}`);
  return rec.pass;
};
const waitFor = async (what, fn, ms = 15000) => {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last && last.ok !== false) return last;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await Bun.sleep(250);
  }
};
const shot = async (p, name) => {
  await p.evaluate(() => document.fonts.ready).catch(() => {});
  await p.screenshot({ path: `${out}/${name}.png` }).catch(() => {});
};

// the fake camera: the test clip drawn into a canvas stream; every toast is recorded (they last 2.6 s)
const fakeCamera = (src) => {
  window.__toasts = [];
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      const t = document.getElementById("toast");
      if (t && t.textContent && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  if (!src) return;
  navigator.mediaDevices.getUserMedia = async () => {
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

let pin = null;
let matchId = null;
const state = async () => (await api("/api/state")).body;
const match = async () => (await state()).derived.matches.find((m) => m.id === matchId);
const H = (body) => api("/api/action", body, { "x-pin": pin });
const play = async (slot, n) => {
  for (let i = 0; i < n; i++) {
    const m = await match();
    const r = await H({ type: "point", matchId, side: slot, seq: m.points.length });
    if (r.status !== 200) throw new Error(`point ${r.status} ${JSON.stringify(r.body)}`);
  }
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const newCtx = async (vp, preset, cam) => {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vp.width < 1000 ? 3 : 1, isMobile: vp.width < 1000, hasTouch: vp.width < 1000, permissions: ["camera"] });
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, cam ? `${origin}/__qa/cam.webm` : "");
  await ctx.addInitScript((kv) => {
    if (sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, preset);
  return ctx;
};
const PHONE = { width: 393, height: 852 };
const TV = { width: 1920, height: 1080 };

// What each screen says: player name -> end (0 blue, 1 red), and the colour it paints that end.
const cameraView = (p) => p.evaluate(() => {
  const plates = [...document.querySelectorAll(".players .plate")].map((e) => e.textContent.trim());
  const colors = [...document.querySelectorAll(".players .plate")].map((e) => getComputedStyle(e).getPropertyValue("--plate-c").trim() && getComputedStyle(e).color);
  const keys = [...document.querySelectorAll(".court__key")].map((e) => e.textContent.trim());
  const text = document.getElementById("app").innerText + " " + [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ");
  const st = window.__ppv.state.players;
  return { plates, colors, keys, labels: [st.near.label, st.far.label], ends: [st.near.end, st.far.end], meWords: (text.match(/\(나\)|\(상대\)|앞쪽\(나\)|건너편\(상대\)/g) || []).length + keys.filter((k) => /^(나|상대)/.test(k)).length, toasts: window.__toasts.slice() };
});
const cardView = (p, sel, nameSel) => p.evaluate(([sel, nameSel]) => {
  const blue = getComputedStyle(document.documentElement).getPropertyValue("--c-blue").trim();
  const red = getComputedStyle(document.documentElement).getPropertyValue("--c-red").trim();
  const cards = [...document.querySelectorAll(sel)].map((e) => ({ name: (e.querySelector(nameSel)?.firstChild?.textContent || "").trim(), end: e.classList.contains("side0") ? 0 : e.classList.contains("side1") ? 1 : null, left: Math.round(e.getBoundingClientRect().left), top: Math.round(e.getBoundingClientRect().top) }));
  return { cards, colors: [blue, red], toasts: window.__toasts.slice() };
}, [sel, nameSel]);
const rgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const nameEnd = (plates) => Object.fromEntries(plates.map((t, i) => [t.split(" · ")[1], /^레드/.test(t) ? 1 : /^블루/.test(t) ? 0 : null]));

let camera = null;
let referee = null;
let tv = null;
const startCamera = async (p) => {
  await p.goto(`${origin}/vision/`, { waitUntil: "load" });
  await p.waitForFunction(() => !!window.__ppv, null, { timeout: 30000 });
  await p.getByRole("button", { name: /카메라 시작/ }).click();
  await p.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv?.state.mode), null, { timeout: 180000 });
  const s = await p.evaluate(() => window.__ppv.state);
  if (s.mode === "error") throw new Error(JSON.stringify(s.error));
  if (s.mode === "calibrating") {
    for (const c of corners) {
      const pt = await p.evaluate(([x, y]) => {
        const v = document.querySelector("video.stage__video") || document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
      await p.mouse.click(pt.x, pt.y);
      await p.waitForTimeout(300);
    }
    await p.getByRole("button", { name: /확인/ }).click();
  }
  await p.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 30000 });
};
// The tournament screens' 엔드 교체 notice: in the page flow, so it may touch no card, button or label,
// is not cut off, is on screen, and on the TV reads at least as large as the player names.
const endNotice = (p) => p.evaluate(() => {
  const n = document.querySelector("[data-end-notice]");
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const sel = "button, .pane, .pane-head, .pane-foot, .pscore, .tv-side, .tv-name, .tv-score, .tv-foot, .serve, .tag, .strip, .tv-strip, .banner, .tv-banner, .vcard, .card, .ref-half, .tv-clip, #toast.show";
  const hits = [...document.querySelectorAll(sel)].filter((e) => !e.contains(n) && !n.contains(e) && e.offsetParent !== null).filter((e) => {
    const q = e.getBoundingClientRect();
    return q.width && q.height && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom;
  }).map((e) => String(e.className || e.tagName).slice(0, 40));
  const name = document.querySelector(".tv-name, .pname, .ref-name");
  return { text: n.textContent.trim(), hits, fontPx: parseFloat(getComputedStyle(n).fontSize), namePx: name ? parseFloat(getComputedStyle(name).fontSize) : null, clipped: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1, onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
});
const noticeOk = (v, big) => !!v && v.text.includes("엔드 교체") && !v.hits.length && !v.clipped && v.onScreen && (!big || v.fontPx >= v.namePx);
// all three screens agree with the server on who stands at which end, and paint it one colour;
// toast: the camera showed a new "엔드 교체" since the count in `since`, and the referee and TV show their notice
const toastCounts = async () => ({ camera: (await cameraView(camera)).toasts.length });
const agree = async (want, toast, since) => waitFor(`camera / referee / TV show ${JSON.stringify(want)}`, async () => {
  const m = await match();
  const names = (await state()).tournament.players;
  const server = { [names[m.players[m.ends?.[0] ?? 0]]]: 0, [names[m.players[m.ends?.[1] ?? 1]]]: 1 };
  const cam = await cameraView(camera);
  const ref = await cardView(referee, ".pane", ".pname");
  const big = await cardView(tv, ".tv-side", ".tv-name");
  const camMap = nameEnd(cam.plates);
  const refMap = Object.fromEntries(ref.cards.map((c) => [c.name, c.end]));
  const tvMap = Object.fromEntries(big.cards.map((c) => [c.name, c.end]));
  const notices = toast ? { referee: await endNotice(referee), tv: await endNotice(tv) } : null;
  const colourOk = cam.plates.every((t, i) => cam.colors[i] === rgb(ref.colors[/^레드/.test(t) ? 1 : 0]));
  const ok = JSON.stringify(camMap) === JSON.stringify(want) && JSON.stringify(refMap) === JSON.stringify(want) && JSON.stringify(tvMap) === JSON.stringify(want) && JSON.stringify(server) === JSON.stringify(want)
    && colourOk && (!toast || (cam.toasts.slice(since.camera).some((t) => t.includes(toast)) && noticeOk(notices.referee, false) && noticeOk(notices.tv, true)));
  return { ok, server, camera: cam.plates, referee: ref.cards, tv: big.cards, colourOk, cameraToasts: cam.toasts.slice(-2), notices };
}, 20000);

try {
  await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "엔드 시험", players: ["김블루", "둘째", "셋째", "넷째"], format: "double", bestOf: 3 });
    if (r.status !== 200) throw new Error(`create ${r.status}`);
    pin = r.body.pin;
    matchId = "m1";
    const m = r.body.state.derived.matches.find((x) => x.id === matchId);
    return { matchId, players: m.players.map((i) => r.body.state.tournament.players[i]) };
  });

  // S1: a camera on its own (no PIN, no approval)
  const solo = await (await newCtx(PHONE, { "pp-role": "camera" }, true)).newPage();
  await step("S1-not-linked-sides", async () => {
    await startCamera(solo);
    const v = await waitFor("side labels", async () => {
      const c = await cameraView(solo);
      return { ...c, ok: JSON.stringify(c.plates) === JSON.stringify(["블루 사이드", "레드 사이드"]) && c.meWords === 0 };
    });
    return v;
  });
  await shot(solo, "S1-camera-not-linked-p852");
  await solo.setViewportSize(TV);
  await solo.waitForTimeout(800);
  await shot(solo, "S1-camera-not-linked-1920");
  await solo.context().close();

  // S2: the camera phone holds the PIN; the referee phone and the TV are open on the same match
  camera = await (await newCtx(PHONE, { "pp-role": "camera", "pp-pin": pin, "ppv.tourPin": JSON.stringify(pin), "ppv.tourMode": JSON.stringify("all") }, true)).newPage();
  referee = await (await newCtx(PHONE, { "pp-role": "referee", "pp-pin": pin }, false)).newPage();
  tv = await (await newCtx(TV, { "pp-role": "viewer" }, false)).newPage();
  await referee.goto(`${origin}/`, { waitUntil: "load" });
  await tv.goto(`${origin}/`, { waitUntil: "load" });
  await step("S2-linked-names", async () => {
    await startCamera(camera);
    await camera.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 15000 });
    return agree({ 김블루: 0, 넷째: 1 });
  });
  for (const [p, n] of [[camera, "camera-p852"], [referee, "referee-p852"], [tv, "tv-1920"]]) await shot(p, `S2-${n}`);

  await step("S3-swap-names-only", async () => {
    const before = await cameraView(camera);
    await camera.getByRole("button", { name: /자리 교체/ }).click();
    const v = await agree({ 넷째: 0, 김블루: 1 });
    const after = await cameraView(camera);
    if (JSON.stringify(after.colors) !== JSON.stringify(before.colors)) throw new Error(`end colours moved: ${before.colors} -> ${after.colors}`);
    return { ...v, colours: after.colors };
  });
  for (const [p, n] of [[camera, "camera-p852"], [referee, "referee-p852"], [tv, "tv-1920"]]) await shot(p, `S3-${n}`);

  await step("S4a-game-end-changes-ends", async () => {
    const since = await toastCounts();
    await play(1, 11);
    return agree({ 김블루: 0, 넷째: 1 }, "엔드 교체", since);
  });
  for (const [p, n] of [[camera, "camera-p852"], [referee, "referee-p852"], [tv, "tv-1920"]]) await shot(p, `S4a-${n}`);

  await step("S4b-deciding-game-at-5", async () => {
    await play(0, 11);
    await agree({ 넷째: 0, 김블루: 1 });
    await play(0, 4);
    await agree({ 넷째: 0, 김블루: 1 });
    const since = await toastCounts();
    await play(0, 1);
    return agree({ 김블루: 0, 넷째: 1 }, "엔드 교체", since);
  });
  for (const [p, n] of [[camera, "camera-p852"], [referee, "referee-p852"], [tv, "tv-1920"]]) await shot(p, `S4b-${n}`);
  await camera.setViewportSize(TV);
  await camera.waitForTimeout(800);
  await shot(camera, "S4b-camera-1920");
} finally {
  writeFileSync(`${out}/sides.json`, JSON.stringify({ tag, steps }, null, 2));
  const pass = steps.filter((s) => s.pass).length;
  console.log(`SIDES_E2E ${tag} ${pass}/${steps.length} PASS`);
  await browser.close().catch(() => {});
  proxy.stop(true);
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(steps.length === 6 && steps.every((s) => s.pass) ? 0 : 1);
}
