// Owner decision (2026-10-31 12:07 KST): "없앰 — 카메라는 무조건 PIN을 넣어야만 점수 기록". The referee
// approval of a PIN-less camera is gone; a camera writes scores with the tournament PIN only.
// Checks, each PASS/FAIL (a checkout that still has the approval FAILS them):
//   api     approve and claim are refused (403); a camera token cannot write a point, undo or say
//   referee the referee screen (PIN) shows a PIN-less camera but offers no 승인 button
//   camera  a PIN-less camera opened straight at /vision/ shows "PIN을 넣어야 점수가 기록돼요" and the
//           PIN field, is not linked; typing the PIN links it and keeps it in pp-pin; scores go in
// With --old=<vision checkout>,<tournament checkout>: a camera approved and linked by token on the old
// code stays open through a deploy to this code: its next write is refused (403), the open screen
// drops the link, and after a reload it shows the PIN field and "PIN을 넣어야 점수가 기록돼요".
//   bun qa/approval-gone.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir>
//     [--old=<vision>,<tournament>] [--engine=chromium|webkit] [--port=9860]
import { chromium, webkit } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DEVICES, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const engine = args.engine || "chromium";
const out = `${args.out}/${engine}`;
mkdirSync(out, { recursive: true });
const NEED_PIN = "PIN을 넣어야 점수가 기록돼요";
const fails = [];
let passes = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${engine} ${name} ${JSON.stringify(detail)}`); if (ok) passes++; else fails.push(name); };
const launch = () => (engine === "webkit" ? webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : chromium.launch());

async function cameraPage(browser, app, view = DEVICES.phone) {
  const ctx = await browser.newContext(view);
  await ctx.addInitScript(fakeCamera, `${app.origin}/__qa/cam.webm`);
  await ctx.addInitScript(() => {
    if (location.origin === "null" || sessionStorage.getItem("__preset")) return;
    sessionStorage.setItem("__preset", "1");
    // a phone that came in through the app this visit: a reload of "/" resumes the camera
    sessionStorage.setItem("pp-started", "1");
    localStorage.clear();
    localStorage.setItem("pp-role", "camera");
    localStorage.setItem("pp-sound", "0");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(app.origin + "/vision/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__ppv?.state.tour.ws === "online" && window.__ppv.venue.id, null, { timeout: 20000 });
  return { ctx, page, errors };
}
const cameraSees = (page) => page.evaluate((need) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[hidden]"); };
  const t = window.__ppv.state.tour;
  return {
    connected: t.connected,
    approval: t.approval,
    needPin: document.body.innerText.includes(need) || [...document.querySelectorAll("[title]")].some((e) => e.title.includes(need)),
    waitingApproval: document.body.innerText.includes("승인"),
    pinField: [...document.querySelectorAll('input[name="intro-pin"]')].some(vis),
    ppPin: localStorage.getItem("pp-pin"),
  };
}, NEED_PIN);
// After a reload "/" hands the camera on to /vision/: wait through that hop for the camera app.
const waitCamera = async (page) => {
  for (let i = 0; i < 3; i++) {
    try { await page.waitForFunction(() => window.__ppv?.state.tour.ws === "online", null, { timeout: 20000 }); return; } catch {}
  }
};
const api = (app, path, body, headers = {}) => fetch(app.origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const points = async (app) => (await (await fetch(app.origin + "/api/state")).json()).derived.matches.find((m) => m.id === app.matchId).points.length;

const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9860) });
let browser = await launch();
try {
  // api: a PIN screen tries to approve a camera, the camera tries to claim and write with a token
  const secret = "S".repeat(43);
  const id = createHash("sha256").update(secret).digest("hex");
  const approve = await api(app, "/api/vision/approve", { id }, { "x-pin": app.pin });
  const claim = await api(app, "/api/vision/claim", { secret });
  const token = claim.body.token || "T".repeat(43);
  const n0 = await points(app);
  const point = await api(app, "/api/action", { type: "point", matchId: app.matchId, side: 0, seq: n0 }, { "x-vision-token": token });
  const n1 = await points(app);
  const undo = await api(app, "/api/action", { type: "undo", matchId: app.matchId, seq: n1 }, { "x-vision-token": token });
  const say = await api(app, "/api/vision/say", { text: "블루 사이드 1" }, { "x-vision-token": token });
  if ((await points(app)) !== n0) await app.reset();
  check("api: approve and claim are refused", approve.status === 403 && claim.status === 403 && !claim.body.token, { approve: approve.status, claim: claim.status, gotToken: !!claim.body.token });
  check("api: a camera token writes nothing (point, undo, say)", point.status === 403 && undo.status === 403 && say.status === 403, { point: point.status, undo: undo.status, say: say.status });

  // camera without the PIN, opened straight at /vision/ (old link, setup link, reload)
  const cam = await cameraPage(browser, app);
  await cam.page.waitForFunction((need) => document.body.innerText.includes(need) || !!document.querySelector('.screen--intro .chip--role')?.textContent.includes("승인"), NEED_PIN, { timeout: 15000 }).catch(() => {});
  const s0 = await cameraSees(cam.page);
  await cam.page.screenshot({ path: `${out}/1-camera-no-pin.png` });
  check("camera without the PIN: not linked, says it needs the PIN, PIN field on screen, no approval wait", !s0.connected && s0.needPin && s0.pinField && !s0.waitingApproval, s0);

  // referee screen while that camera is online: no 승인 button anywhere
  const refCtx = await browser.newContext(DEVICES.phone);
  await refCtx.addInitScript((p) => { if (location.origin === "null" || sessionStorage.getItem("__preset")) return; sessionStorage.setItem("__preset", "1"); sessionStorage.setItem("pp-started", "1"); localStorage.setItem("pp-role", "referee"); localStorage.setItem("pp-pin", p); localStorage.setItem("pp-sound", "0"); }, app.pin);
  const ref = await refCtx.newPage();
  await ref.goto(app.origin + "/", { waitUntil: "load" });
  await ref.waitForSelector("[data-camera]", { timeout: 15000 }).catch(() => {});
  const refSees = await ref.evaluate(() => ({ approve: document.querySelectorAll('[data-act="camera-approve"], [data-act="camera-revoke"]').length, camera: document.querySelector("[data-camera]")?.textContent.trim() || null }));
  await ref.screenshot({ path: `${out}/2-referee.png` });
  check("referee screen: the PIN-less camera shows, with no 승인 button", refSees.approve === 0 && !!refSees.camera && !/승인/.test(refSees.camera), refSees);
  await refCtx.close();

  // the right PIN on the camera: linked, remembered as pp-pin, and its score goes in
  if (s0.pinField) {
    await cam.page.locator('input[name="intro-pin"]').fill(app.pin);
    await cam.page.locator(".screen--intro .screen__pin button").click();
    await cam.page.waitForFunction(() => window.__ppv.state.tour.connected, null, { timeout: 15000 }).catch(() => {});
  }
  const s1 = await cameraSees(cam.page);
  const before = await points(app);
  const wrote = await cam.page.evaluate(async ([m, seq]) => { const t = window.__ppv.venue.tour; try { await t.call("/action", { type: "point", matchId: m, side: 0, seq }); return "ok"; } catch (e) { return String(e.message || e); } }, [app.matchId, before]);
  const after = await points(app);
  await cam.page.screenshot({ path: `${out}/3-camera-pin.png` });
  check("camera with the PIN typed: linked by PIN, kept in pp-pin, its point goes in", s1.connected && s1.approval === "pin" && s1.ppPin === app.pin && wrote === "ok" && after === before + 1, { ...s1, ppPin: s1.ppPin === app.pin, wrote, before, after });
  check("no page errors (camera)", cam.errors.length === 0, cam.errors);
  await cam.ctx.close();
  await app.reset();

  // an open camera linked by token on the old code, through a deploy to this code
  if (args.old) {
    const [oldVision, oldTournament] = args.old.split(",");
    const newer = { vision: args.vision, tournament: args.tournament };
    await app.swap({ vision: oldVision, tournament: oldTournament });
    const old = await cameraPage(browser, app);
    const camId = await old.page.evaluate(() => window.__ppv.venue.id);
    const ok = await api(app, "/api/vision/approve", { id: camId }, { "x-pin": app.pin });
    await old.page.waitForFunction(() => window.__ppv.state.tour.connected && window.__ppv.state.tour.approval === "camera", null, { timeout: 20000 }).catch(() => {});
    const linkedOld = await cameraSees(old.page);
    await old.page.screenshot({ path: `${out}/4-old-camera-token.png` });
    check("old code: the referee approval links the PIN-less camera by token (the path being removed)", ok.status === 200 && linkedOld.connected && linkedOld.approval === "camera", { approve: ok.status, ...linkedOld });

    await app.swap(newer);
    const n = await points(app);
    const res = await old.page.evaluate(async (m) => {
      const t = window.__ppv.venue.tour;
      const r = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", ...t.auth() }, body: JSON.stringify({ type: "point", matchId: m, side: 0, seq: 0 }) });
      let thrown = null;
      try { await t.call("/action", { type: "point", matchId: m, side: 0, seq: t.matches.find((x) => x.id === m)?.points.length ?? 0 }); } catch (e) { thrown = String(e.message || e); }
      await new Promise((r2) => setTimeout(r2, 300));
      return { status: r.status, sentToken: !!t.auth()["x-vision-token"] || r.status === 403, thrown, connected: window.__ppv.state.tour.connected };
    }, app.matchId);
    const after2 = await points(app);
    await old.page.screenshot({ path: `${out}/5-old-camera-after-deploy.png` });
    check("after the deploy the open camera's token write is refused (403), nothing written, the screen drops the link", res.status === 403 && after2 === n && !res.connected, { ...res, points: [n, after2] });

    await old.page.reload({ waitUntil: "load" });
    await waitCamera(old.page);
    let s2 = await cameraSees(old.page);
    if (!s2.pinField) {
      // a service worker may hand the old shell once more; the next load is the new one
      await old.page.reload({ waitUntil: "load" });
      await waitCamera(old.page);
      s2 = await cameraSees(old.page);
    }
    const leftToken = await old.page.evaluate(() => localStorage.getItem("ppv.tourToken"));
    await old.page.screenshot({ path: `${out}/6-old-camera-reloaded.png` });
    check("reloaded, the same camera asks for the PIN: not linked, PIN field, old token forgotten", !s2.connected && s2.needPin && s2.pinField && (leftToken === null || leftToken === "null"), { ...s2, leftToken });
    await old.ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop?.();
}
console.log(`APPROVAL_GONE_DONE engine=${engine} pass=${passes} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
