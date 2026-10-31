// The viewer role on big screens, with a real point clip: TV 1920x1080 and 1280x720 (Chromium, as a
// TV browser), portrait pad 768x1024 (WebKit), plus the phone viewer and the referee pad that must
// not change. Measures the score digits (CSS px and mm on a 55"/65" 1080p TV), checks nothing spills
// out of the screen and the clip plays.
//   bun qa/tv-viewer-shots.mjs --origin=http://127.0.0.1:8960 --key-file=<upload-key> --clip=<webm> [--out=evidence/r6/tv]
import { chromium, devices, webkit } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const origin = args.origin;
const out = args.out || "evidence/r6/tv";
mkdirSync(out, { recursive: true });
const api = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return res.json();
};

// A match in its second game: blue won game 1 11:7, game 2 stands at 7:5, and the last point has its clip.
const created = await api("/api/tournament", { name: "탁구장 시험", players: ["김블루", "박레드", "셋째", "넷째"], format: "double", bestOf: 3 });
const pin = created.pin;
const matchId = created.state.derived.matches.find((m) => m.status === "ready").id;
const seq = [...Array(11).fill(0).flatMap((_, i) => (i < 7 ? [0, 1] : [0])), ...[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0]];
let n = 0;
for (const side of seq) await api("/api/action", { type: "point", matchId, side, seq: n++ }, { "x-pin": pin });
const form = new FormData();
form.set("record", JSON.stringify({ id: Date.now(), durationMs: 4200, shots: 5, bounces: [] }));
form.set("video", new Blob([readFileSync(args.clip)], { type: "video/webm" }), "rally.webm");
const up = await (await fetch(`${origin}/vision/api/rallies`, { method: "POST", headers: { "x-ppv-key": readFileSync(args["key-file"], "utf8").trim() }, body: form })).json();
await api("/api/action", { type: "clip", matchId, index: n - 1, url: `/vision/${up.share}` }, { "x-pin": pin });
const score = (await api("/api/state")).derived.matches.find((m) => m.id === matchId).score;

const measure = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { fontPx: parseFloat(getComputedStyle(el).fontSize), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    const v = document.querySelector("video[data-clip-video]");
    return {
      layout: document.body.dataset.tv || "none",
      score: box(".tv-score") || box(".pscore"),
      name: box(".tv-name") || box(".pname"),
      foot: box(".tv-foot"),
      clip: box(".tv-clip video") || box(".clip-now video"),
      clipPlaying: v ? { readyState: v.readyState, w: v.videoWidth, paused: v.paused } : null,
      overflow: { x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight },
      nav: !!document.querySelector("nav.nav"),
      // every control on screen must be tappable: the topmost element at its centre is the control
      // itself (the latest-clip box once covered the referee's 심판 모드 button on a 1024 px pad)
      clipOverButtons: [...document.querySelectorAll("button, a[href], [role=button]")].map((b) => ({ b, r: b.getBoundingClientRect() }))
        .filter(({ r }) => r.width && r.height && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth)
        .filter(({ b, r }) => {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit && !b.contains(hit) && !hit.contains(b);
        })
        .map(({ b }) => (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 20)),
      viewport: { w: innerWidth, h: innerHeight },
    };
  });

const shots = [
  { name: "tv-1920x1080", engine: chromium, ctx: { viewport: { width: 1920, height: 1080 } }, role: "viewer" },
  { name: "tv-1280x720", engine: chromium, ctx: { viewport: { width: 1280, height: 720 } }, role: "viewer" },
  { name: "pad-portrait-768x1024", engine: webkit, ctx: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, role: "viewer" },
  { name: "phone-viewer-393x852", engine: webkit, ctx: { ...devices["iPhone 15"] }, role: "viewer" },
  { name: "referee-pad-1024x768", engine: chromium, ctx: { viewport: { width: 1024, height: 768 } }, role: "referee", pin: true },
  { name: "referee-pad-768x1024", engine: webkit, ctx: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, role: "referee", pin: true },
  { name: "referee-phone-393x852", engine: webkit, ctx: { ...devices["iPhone 15"] }, role: "referee", pin: true },
  { name: "referee-desktop-1280x800", engine: chromium, ctx: { viewport: { width: 1280, height: 800 } }, role: "referee", pin: true },
];
const results = {};
const browsers = new Map();
for (const s of shots) {
  if (!browsers.has(s.engine)) browsers.set(s.engine, await s.engine.launch(s.engine === webkit && process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : { args: ["--autoplay-policy=no-user-gesture-required"] }));
  const ctx = await browsers.get(s.engine).newContext(s.ctx);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(([role, p]) => {
    localStorage.setItem("pp-role", role);
    localStorage.setItem("pp-sound", "1");
    if (p) localStorage.setItem("pp-pin", p);
  }, [s.role, s.pin ? pin : null]);
  const page = await ctx.newPage();
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForSelector(".tv-score, .pscore", { timeout: 20000 });
  await page.waitForFunction(() => {
    const v = document.querySelector("video[data-clip-video]");
    return !v || v.readyState >= 2;
  }, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  results[s.name] = await measure(page);
  await page.screenshot({ path: `${out}/${s.name}.png` });
  await ctx.close();
}
for (const b of browsers.values()) await b.close();

// 1080p TV pixel pitch: 55" = 1218 mm wide, 65" = 1439 mm wide, over 1920 px.
const mm = (px, inch) => Math.round(px * (inch === 55 ? 1218 : 1439) / 1920);
const tv = results["tv-1920x1080"];
const report = {
  matchScore: { games: score.won, current: [score.current.a, score.current.b], server: score.server },
  results,
  readability: tv && tv.score && {
    scoreFontPx: tv.score.fontPx,
    scoreDigitHeightMm: { tv55: mm(tv.score.fontPx * 0.72, 55), tv65: mm(tv.score.fontPx * 0.72, 65) },
    nameFontPx: tv.name.fontPx,
    nameHeightMm: { tv55: mm(tv.name.fontPx * 0.72, 55), tv65: mm(tv.name.fontPx * 0.72, 65) },
    gamesServeFontPx: tv.foot.fontPx,
    gamesServeHeightMm: { tv55: mm(tv.foot.fontPx * 0.72, 55), tv65: mm(tv.foot.fontPx * 0.72, 65) },
    rule: "3 m: text needs about 25 mm cap height (1 inch per 10 ft) to be read, 50 mm to be read at a glance",
  },
};
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
report.refereeOverlap = Object.fromEntries(Object.entries(results).filter(([k]) => k.startsWith("referee")).map(([k, v]) => [k, v.clipOverButtons]));
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log("TV_SHOTS " + JSON.stringify({ readability: report.readability, refereeOverlap: report.refereeOverlap, layouts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [v.layout, v.score && v.score.fontPx, v.overflow.x, v.clipPlaying && v.clipPlaying.readyState]])) }));
const bad = Object.values(report.refereeOverlap).some((l) => l.length);
process.exit(bad ? 1 : 0);
