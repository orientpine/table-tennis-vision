// A referee's point during the camera's cancel window must still reach the camera (WebKit, isolated
// servers). Each round the camera enters a real point through its own score() path, the referee
// taps a point inside the 3 s window, and the camera must show the server's count within the
// window plus 2 s. The camera stays off, so no clip can start a window by chance.
//   bun qa/sync-pending.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --tag=before|after [--rounds=20] [--port=9700]
import { webkit } from "playwright";
import { DEVICES, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const rounds = Number(args.rounds || 20);
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9700) });
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const open = async (role, device) => {
  const ctx = await browser.newContext(device);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(([r, p]) => {
    localStorage.setItem("pp-role", r);
    localStorage.setItem("pp-sound", "0");
    localStorage.setItem("pp-pin", p);
  }, [role, app.pin]);
  const page = await ctx.newPage();
  await page.goto(app.origin + "/");
  return page;
};
const serverPoints = async () => {
  const s = await fetch(`${app.origin}/api/state`).then((r) => r.json());
  return s.derived.matches.find((m) => m.id === app.matchId).points.length;
};
// game score [slot 0, slot 1] now; the player who trails gets the next point so the match never ends
const current = async () => {
  const s = await fetch(`${app.origin}/api/state`).then((r) => r.json());
  const c = s.derived.matches.find((m) => m.id === app.matchId).score.current;
  return [c.a, c.b];
};
const shown = (page) => page.evaluate((id) => window.__ppv.venue.tour.matches.find((m) => m.id === id)?.points ?? null, app.matchId);

let missed = 0;
const delays = [];
try {
  const cam = await open("camera", DEVICES.phone);
  await cam.waitForFunction(() => window.__ppv?.venue?.tour?.linked() && window.__ppv.venue.tour.matchId, null, { timeout: 30000 });
  const ref = await open("referee", DEVICES.phone);
  await ref.waitForSelector('[data-act="point"]:visible', { timeout: 15000 });
  for (let i = 0; i < rounds; i++) {
    // the camera names the winner by end (near / far); which player stands there follows the ends
    const [a, b] = await current();
    const trailing = a < b ? 0 : 1;
    await cam.evaluate((slot) => {
      const tour = window.__ppv.venue.tour;
      return tour.score({ winner: tour.slotOf("near") === slot ? "near" : "far", sure: true, label: "시험" });
    }, trailing);
    await ref.waitForFunction((n) => document.querySelector('[data-act="point"]') && n >= 0, await serverPoints());
    await ref.waitForTimeout(250);
    if (!(await cam.evaluate(() => !!window.__ppv.venue.tour.pending))) throw new Error(`round ${i}: the window closed before the referee tap`);
    // keeps the game level (7:5 -> 7:7, then one point each) so the match never ends
    const [a2, b2] = await current();
    await ref.locator(`[data-act="point"][data-side="${b2 < a2 ? 1 : 0}"]:visible`).first().click();
    const want = (await serverPoints());
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 5000) {
      if ((await shown(cam)) === want) { seen = true; break; }
      await cam.waitForTimeout(100);
    }
    if (seen) delays.push(Date.now() - t0);
    else missed++;
    await cam.waitForFunction(() => !window.__ppv.venue.tour.pending, null, { timeout: 8000 });
    await cam.evaluate(() => window.__ppv.venue.tour.refresh());
  }
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
delays.sort((a, b) => a - b);
console.log(`SYNC_PENDING ${args.tag} rounds=${rounds} missed=${missed} medianMs=${delays[delays.length >> 1] ?? null} maxMs=${delays.at(-1) ?? null}`);
process.exit(missed ? 1 : 0);
