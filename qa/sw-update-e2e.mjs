// Service worker update repro through the real app in WebKit (iPhone 15). An old build is
// opened first, so its service worker and cache are installed. Then the same origin is switched
// to the new build, and a one-time setup link is opened in a new tab. That mirrors the owner's
// phone, which had opened an earlier deploy before the link was sent. Both builds run their real
// server.js behind one HTTPS proxy, so the origin and the service worker scope stay the same.
// Checks:
//   firstOpenNewHtml  the first page after the switch is the new index.html (build marker)
//   firstOpenRedeems  that first open trades the link (one POST /api/setup, key stored, notice shown
//                     inside the first screen without scrolling)
//   sameTabHash       a link opened in a tab that already shows the app is traded too
//   offlineShell      with the network off, the app shell still opens from the cache
//   modelCached       the pose model is still in the cache
//   malformedLinkSaysSo  a cut #setup link shows a notice instead of nothing
// The token and the key are never written to the report, the screenshots, or the console.
//   bun qa/sw-update-e2e.mjs --old=<old checkout> --new=<new checkout> --cert=<pem> --key=<pem> [--out=evidence/r3/sw]
import { devices, webkit } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupToken } from "../save-server.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/r3/sw";
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "ppv-sw-"));
const PROXY_PORT = Number(args.port || 8843);
const builds = { old: { root: args.old, port: PROXY_PORT + 1 }, new: { root: args.new, port: PROXY_PORT + 2 } };

const env = (name) => ({
  ...process.env,
  PORT: String(builds[name].port),
  PPV_SAVE_DIR: join(tmp, `${name}-saves`),
  PPV_KEY_FILE: join(tmp, "upload-key"),
  PPV_SETUP_FILE: join(tmp, "setup-tokens.json"),
});
const procs = [];
for (const name of Object.keys(builds)) {
  const p = spawn("bun", [join(builds[name].root, "server.js")], { cwd: builds[name].root, env: env(name), stdio: ["ignore", "ignore", "inherit"] });
  procs.push(p);
}
const up = async (port) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`server on ${port} did not start`);
};
await Promise.all(Object.values(builds).map((b) => up(b.port)));

// One origin, two builds: the proxy forwards to whichever build is "deployed" right now.
let deployed = "old";
const log = [];
const proxy = Bun.serve({
  port: PROXY_PORT,
  hostname: "127.0.0.1",
  tls: { cert: readFileSync(args.cert, "utf8"), key: readFileSync(args.key, "utf8") },
  async fetch(req) {
    const url = new URL(req.url);
    log.push({ build: deployed, method: req.method, path: url.pathname });
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(`http://127.0.0.1:${builds[deployed].port}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
});
const base = `https://localhost:${PROXY_PORT}/vision/`;
const newHtml = await (await fetch(`http://127.0.0.1:${builds.new.port}/vision/`)).text();
const marker = /<meta name="ppv-build" content="([^"]*)">/.exec(newHtml)?.[1] || null;
const key = () => readFileSync(join(tmp, "upload-key"), "utf8").trim();

const noticeInView = () => {
  const n = document.querySelector(".screen--intro .screen__note");
  const r = n?.getBoundingClientRect();
  return !!r && r.top >= 0 && r.bottom <= innerHeight && r.height > 0 && !!window.__ppv?.state.save.notice;
};
// The app scrolls a new notice into view on the next frame; wait for that state (bounded).
const waitNoticeInView = (page) => page.waitForFunction(`(${noticeInView})()`, null, { timeout: 3000 }).catch(() => {});
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const ctx = await browser.newContext({ ...devices["iPhone 15"], ignoreHTTPSErrors: true, serviceWorkers: "allow" });
const consoleLines = [];
ctx.on("page", (p) => p.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`)));
const report = { base, marker, steps: {} };
let pass = false;
try {
  // 1. The owner's earlier visit: the old build installs its service worker and cache.
  const p1 = await ctx.newPage();
  await p1.goto(base, { waitUntil: "load" });
  await p1.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await p1.reload({ waitUntil: "load" });
  report.steps.oldVisit = await p1.evaluate(async () => ({
    controlled: !!navigator.serviceWorker.controller,
    caches: await caches.keys(),
    cachedAppJs: !!(await caches.match("./js/app.js")),
    hasSetupCode: !!(await (await caches.match("./js/app.js"))?.text())?.includes("api/setup"),
  }));
  await p1.screenshot({ path: `${out}/1-old-visit.png` });
  await p1.close();

  // 2. Deploy the new build, then open the one-time link in a new tab (first open after deploy).
  deployed = "new";
  const mark = log.length;
  const t1 = createSetupToken({ tokenFile: join(tmp, "setup-tokens.json") }).token;
  const p2 = await ctx.newPage();
  await p2.goto(`${base}#setup=${t1}`, { waitUntil: "load" });
  await p2.waitForFunction(() => window.__ppv && (window.__ppv.state.save.keySet || window.__ppv.state.save.keyError), null, { timeout: 8000 }).catch(() => {});
  await waitNoticeInView(p2);
  const s2 = await p2.evaluate(() => ({
    href: location.href,
    build: document.querySelector('meta[name="ppv-build"]')?.content || null,
    keySet: !!window.__ppv?.state.save.keySet,
    stored: localStorage.getItem("ppv.uploadKey"),
    notice: window.__ppv?.state.save.notice || "",
    intro: document.querySelector(".screen--intro")?.innerText || "",
    inView: (() => { const n = document.querySelector(".screen--intro .screen__note"); if (!n) return false; const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; })(),
  }));
  await p2.screenshot({ path: `${out}/2-first-open-after-deploy.png` });
  report.steps.firstOpen = {
    build: s2.build,
    keySet: s2.keySet,
    storedKeyMatches: s2.stored === JSON.stringify(key()),
    noticeOnScreen: !!s2.notice && s2.intro.includes(s2.notice),
    noticeInView: s2.inView,
    hashGone: !s2.href.includes("#"),
    setupPosts: log.slice(mark).filter((l) => l.method === "POST" && l.path.endsWith("/api/setup")).length,
    requests: log.slice(mark).map((l) => `${l.build} ${l.method} ${l.path}`),
  };

  // 3. Offline right after that first open (no reload): once the new worker has taken over, the
  //    shell must still open with no network, from the new build, and the model must be cached.
  report.steps.takeover = await p2.evaluate(async (build) => {
    const want = build && `ppv-shell-${build}`;
    for (let i = 0; i < 100; i++) {
      const keys = await caches.keys();
      const reg = await navigator.serviceWorker.getRegistration();
      if ((!want || (keys.includes(want) && !keys.includes("ppv-v1"))) && reg?.active && !reg.installing && !reg.waiting) return { keys, ms: i * 100 };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { keys: await caches.keys(), timedOut: true };
  }, marker);
  await ctx.setOffline(true);
  const p4 = await ctx.newPage();
  const offlineMark = log.length;
  let offlineError = null;
  await p4.goto(base, { waitUntil: "load" }).catch((e) => (offlineError = String(e.message || e).split("\n")[0]));
  const s4 = await p4
    .evaluate(async () => ({
      introVisible: !!document.querySelector(".screen--intro") && getComputedStyle(document.querySelector(".screen--intro")).display !== "none",
      appRan: !!window.__ppv,
      build: document.querySelector('meta[name="ppv-build"]')?.content || null,
      model: !!(await caches.match("./models/pose_landmarker_lite.task")),
      caches: await caches.keys(),
    }))
    .catch((e) => ({ error: String(e.message || e) }));
  await p4.screenshot({ path: `${out}/3-offline-shell.png` });
  await p4.close();
  report.steps.offline = { ...s4, offlineError, requestsWhileOffline: log.length - offlineMark };
  await ctx.setOffline(false);

  // 4. A link opened in a tab that already shows the app: the address only gains #setup=...
  await p2.evaluate(() => localStorage.removeItem("ppv.uploadKey"));
  await p2.goto(base, { waitUntil: "load" });
  const mark3 = log.length;
  const t2 = createSetupToken({ tokenFile: join(tmp, "setup-tokens.json") }).token;
  await p2.goto(`${base}#setup=${t2}`, { waitUntil: "load" });
  await p2.waitForFunction(() => localStorage.getItem("ppv.uploadKey") || window.__ppv?.state.save.keyError, null, { timeout: 8000 }).catch(() => {});
  const s3 = await p2.evaluate(() => ({ href: location.href, stored: localStorage.getItem("ppv.uploadKey") }));
  await p2.screenshot({ path: `${out}/4-same-tab-link.png` });
  report.steps.sameTab = {
    storedKeyMatches: s3.stored === JSON.stringify(key()),
    hashGone: !s3.href.includes("#"),
    setupPosts: log.slice(mark3).filter((l) => l.method === "POST" && l.path.endsWith("/api/setup")).length,
  };

  // 5. A cut or altered link must say so on screen instead of doing nothing.
  const mark5 = log.length;
  await p2.goto(`${base}#setup=cut-short`, { waitUntil: "load" });
  await p2.waitForFunction(() => window.__ppv?.state.save.keyError, null, { timeout: 5000 }).catch(() => {});
  await waitNoticeInView(p2);
  const s5 = await p2.evaluate(() => ({ href: location.href, notice: window.__ppv?.state.save.notice || "", intro: document.querySelector(".screen--intro")?.innerText || "", inView: (() => { const n = document.querySelector(".screen--intro .screen__note"); if (!n) return false; const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; })(), }));
  await p2.screenshot({ path: `${out}/5-malformed-link.png` });
  report.steps.malformed = {
    notice: s5.notice,
    noticeOnScreen: !!s5.notice && s5.intro.includes(s5.notice),
    noticeInView: s5.inView,
    hashGone: !s5.href.includes("#"),
    setupPosts: log.slice(mark5).filter((l) => l.method === "POST" && l.path.endsWith("/api/setup")).length,
  };

  const f = report.steps.firstOpen;
  report.checks = {
    oldBuildCached: report.steps.oldVisit.controlled && report.steps.oldVisit.cachedAppJs && !report.steps.oldVisit.hasSetupCode,
    firstOpenNewHtml: marker === null ? null : f.build === marker,
    firstOpenRedeems: f.keySet && f.storedKeyMatches && f.noticeOnScreen && f.noticeInView && f.hashGone && f.setupPosts === 1,
    sameTabHash: report.steps.sameTab.storedKeyMatches && report.steps.sameTab.hashGone && report.steps.sameTab.setupPosts === 1,
    offlineShell: !!s4.introVisible && !!s4.appRan && (marker === null || s4.build === marker),
    modelCached: !!s4.model,
    malformedLinkSaysSo: report.steps.malformed.noticeOnScreen && report.steps.malformed.noticeInView && report.steps.malformed.hashGone && report.steps.malformed.setupPosts === 0,
  };
  pass = Object.values(report.checks).every((v) => v === true);
} catch (err) {
  report.error = String(err.stack || err);
} finally {
  await browser.close();
  proxy.stop(true);
  for (const p of procs) p.kill();
}
report.console = consoleLines.filter((l) => !l.includes(key()));
report.pass = pass;
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(`SW_UPDATE ${Object.entries(report.checks || {}).map(([k, v]) => `${k}=${v === true ? "PASS" : v === null ? "N/A" : "FAIL"}`).join(" ")}${report.error ? " ERROR" : ""}`);
process.exit(pass ? 0 : 1);
