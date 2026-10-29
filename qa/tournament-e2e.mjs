// Vision -> tournament app end to end on one origin, as on the Funnel host: the tournament app
// owns "/" (and /api, /ws), the vision app is mounted at /vision. Both real servers run behind a
// small proxy here (WebSocket included). Chromium fake camera plays a rally that ends by itself.
// Steps: create a tournament -> camera, 4-tap calibration -> in the vision settings type the upload
// key and the tournament PIN, pick the match, auto entry "모든 포인트" -> a point is entered automatically -> tap 취소
// inside 3 s (the point is undone) -> the next point stays -> its clip is attached to that point
// -> a viewer on the tournament page (no PIN, opened before) sees the score and the clip live.
//   bun qa/tournament-e2e.mjs --vision=<checkout> --tournament=<checkout> --y4m=<file> --corners='<json, 1920x1080>' [--out=evidence/r3/tournament]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r3/tournament";
mkdirSync(out, { recursive: true });
const corners = JSON.parse(args.corners);
const tmp = mkdtempSync(join(tmpdir(), "ppv-tour-"));
const P = Number(args.port || 8870);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };

const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json") },
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
await Promise.all([up(ports.tour, "/api/state"), up(ports.vision, "/healthz")]);

const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
const proxy = Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
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
const api = async (path, body, pin) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(pin ? { "x-pin": pin } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const steps = [];
let page = null;
let viewer = null;
const shot = async (p, name) => p && p.screenshot({ path: `${out}/${String(steps.length).padStart(2, "0")}-${name}.png` }).catch(() => {});
const step = async (name, fn, shotOf = () => page) => {
  try {
    steps.push({ name, pass: true, detail: await fn() });
  } catch (err) {
    steps.push({ name, pass: false, detail: String(err.message || err).split("\n")[0] });
  }
  await shot(shotOf(), name);
  return steps[steps.length - 1].pass;
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

let pin = null;
let matchId = null;
const match = async () => (await api("/api/state")).body.derived.matches.find((m) => m.id === matchId);
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${args.y4m}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  await step("create-tournament", async () => {
    const r = await api("/api/tournament", { name: "비전 연동 시험", players: ["블루선수", "레드선수", "셋째", "넷째"], format: "double", bestOf: 3 });
    if (r.status !== 200) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
    pin = r.body.pin;
    matchId = r.body.state.derived.matches.find((m) => m.status === "ready").id;
    return { matchId };
  }, () => null);

  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  viewer = await vctx.newPage();
  await step("viewer-open", async () => {
    await viewer.goto(origin + "/", { waitUntil: "networkidle" });
    return { title: await viewer.title() };
  }, () => viewer);

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ["camera"] });
  page = await ctx.newPage();
  await page.goto(origin + "/vision/", { waitUntil: "networkidle" });
  const key = readFileSync(join(tmp, "upload-key"), "utf8").trim();
  await step("camera-calibrate", async () => {
    await page.getByRole("button", { name: /카메라 시작/ }).tap();
    await page.waitForFunction(() => ["calibrating", "running", "error"].includes(window.__ppv.state.mode), null, { timeout: 120000 });
    const s = await page.evaluate(() => window.__ppv.state);
    if (s.mode === "error") throw new Error(JSON.stringify(s.error));
    for (const c of corners) {
      const pt = await page.evaluate(([x, y]) => {
        const v = document.querySelector("video");
        const r = v.getBoundingClientRect();
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        return { x: r.left + (r.width - v.videoWidth * k) / 2 + x * k, y: r.top + (r.height - v.videoHeight * k) / 2 + y * k };
      }, [c.x * (s.video.width / 1920), c.y * (s.video.height / 1080)]);
      await page.touchscreen.tap(pt.x, pt.y);
      await page.waitForTimeout(250);
    }
    await page.getByRole("button", { name: /확인/ }).tap();
    await page.waitForFunction(() => window.__ppv.state.mode === "running", null, { timeout: 10000 });
    return { video: s.video };
  });

  await step("settings-link", async () => {
    await page.getByRole("button", { name: /설정/ }).first().tap();
    await page.locator("input[name=upload-key]").fill(key);
    await page.getByRole("button", { name: /열쇠 저장/ }).tap();
    await page.waitForFunction(() => window.__ppv.state.save.keySet, null, { timeout: 10000 });
    await page.locator("input[name=tournament-pin]").fill(pin);
    await page.getByRole("button", { name: /^연결$/ }).tap();
    await page.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.matchId, null, { timeout: 10000 });
    await page.locator("select.select").selectOption(matchId);
    await page.waitForFunction((id) => window.__ppv.state.tour.matchId === id, matchId, { timeout: 5000 });
    await page.getByRole("button", { name: "모든 포인트 자동" }).tap();
    await page.waitForFunction(() => window.__ppv.state.tour.mode === "all", null, { timeout: 5000 });
    await page.screenshot({ path: `${out}/settings-linked.png` });
    const t = await page.evaluate(() => window.__ppv.state.tour);
    await page.getByRole("button", { name: /설정 닫기/ }).tap();
    return { matchId: t.matchId, near: t.near, status: await page.locator(".tourlink").count() };
  });

  await step("point-entered-then-cancelled", async () => {
    await page.waitForFunction(() => window.__ppv.state.tour.pending && !window.__ppv.state.tour.pending.choice, null, { timeout: 300000, polling: 50 });
    const pending = await page.evaluate(() => window.__ppv.state.tour.pending);
    const entered = (await match()).points.length;
    // The referee has 3 s: tap at once, before any slow screenshot.
    await page.locator(".pointbar__cancel").tap({ timeout: 2500 });
    await waitFor("undo", async () => (await match()).points.length === 0, 5000);
    await page.waitForFunction(() => !window.__ppv.state.tour.pending, null, { timeout: 5000 });
    if (entered !== 1) throw new Error(`tournament had ${entered} points when the bar appeared`);
    return { pending, enteredPoints: entered, afterCancel: (await match()).points.length, notice: await page.evaluate(() => window.__ppv.state.tour.notice) };
  });

  await step("next-point-stays-with-clip", async () => {
    await page.waitForFunction(() => window.__ppv.state.tour.pending && !window.__ppv.state.tour.pending.choice, null, { timeout: 300000, polling: 50 });
    await page.locator(".pointbar").screenshot({ path: `${out}/pointbar.png`, timeout: 2500 }).catch(() => {});
    await waitFor("second point", async () => (await match()).points.length === 1, 5000);
    const m = await waitFor("clip attached", async () => {
      const x = await match();
      return x.clips && x.clips[0] ? x : null;
    }, 120000);
    return { points: m.points, clip: m.clips[0] };
  });

  await step("viewer-sees-clip-live", async () => {
    await viewer.waitForSelector("video", { timeout: 15000 });
    const v = await viewer.evaluate(
      () =>
        new Promise((resolve) => {
          const el = document.querySelector("video");
          const done = () => resolve({ src: el.currentSrc || el.src, w: el.videoWidth, error: el.error && el.error.code, text: document.body.innerText.slice(0, 400) });
          if (el.readyState >= 1) return done();
          el.addEventListener("loadeddata", done, { once: true });
          el.addEventListener("error", done, { once: true });
          setTimeout(done, 15000);
        }),
    );
    if (!(v.w > 0) || v.error) throw new Error(`viewer video ${JSON.stringify(v)}`);
    return v;
  }, () => viewer);
} finally {
  const report = { steps, tmp };
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  proxy.stop(true);
  for (const p of procs) p.kill();
}
console.log(`TOURNAMENT_E2E ${steps.map((s) => `${s.name}=${s.pass ? "PASS" : "FAIL"}`).join(" ")}`);
for (const s of steps) if (!s.pass) console.log(`FAIL ${s.name} ${s.detail}`);
process.exit(steps.every((s) => s.pass) ? 0 : 1);
