// Point-winner accuracy against OpenTTGames ground truth. The dataset marks every table bounce
// (frame and ball position) but not who won the point. The "net" marks sit on both sides of the
// net in the image, so they are not crossings and are not used. The ground-truth winner is read
// from the end of each marked rally: the player on the side of the last marked bounce failed
// (let it bounce twice, missed it, or hit it into the net or out), with sides from the four table
// corners. Only the end is used because the marks skip some bounces mid-rally (two marks in a
// row on one side), so the alternation the app checks cannot be replayed on them. Each such
// ground-truth call was checked against the video frames (REPORT-3 lists them). A rally is a run
// of bounces with no gap over 1.5 s; runs with fewer than 3 bounces are annotation fragments,
// not points.
// The app side: every rallyEnd from qa/ball-offline.mjs (same pixel path as the phone) is judged
// with public/js/point.js, exactly what would be sent to the tournament app. Counted per video:
//   correct / wrong   the one app entry for that rally has the right / wrong winner
//   missed            no app entry for that rally (nothing sent; the referee taps it)
//   extra             a second entry for one rally (a wrong point the referee must cancel)
// Each app entry belongs to the annotated window it overlaps most; entries in fragment windows
// or outside every window cannot be checked and are only counted.
//   bun qa/point-eval.mjs --offline=<ball-offline json> --gt=data/videos/test_2 --corners='<json>' [--out=x.json]
import { readFileSync, writeFileSync } from "node:fs";
import { TABLE_LENGTH, apply, makeCalibration } from "../public/js/geom.js";
import { judgePoint } from "../public/js/point.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const res = JSON.parse(readFileSync(args.offline, "utf8"));
const fps = res.srcFps || 120;
const cal = makeCalibration(JSON.parse(args.corners));
const marks = JSON.parse(readFileSync(`${args.gt}/events_markup.json`, "utf8"));
const ball = JSON.parse(readFileSync(`${args.gt}/ball_markup.json`, "utf8"));
const bounces = Object.entries(marks)
  .filter(([f, type]) => type === "bounce" && ball[f] && ball[f].x >= 0)
  .map(([f]) => ({ f: Number(f), t: Number(f) / fps, side: apply(cal.toTable, ball[f]).x < TABLE_LENGTH / 2 ? "near" : "far" }))
  .sort((a, b) => a.f - b.f);

const runs = [];
for (const b of bounces) {
  const cur = runs[runs.length - 1];
  if (cur && b.f - cur[cur.length - 1].f <= 1.5 * fps) cur.push(b);
  else runs.push([b]);
}
const windows = runs.map((r) => ({ startS: r[0].t, endS: r[r.length - 1].t }));
const gt = runs
  .filter((r) => r.length >= 3)
  .map((r) => {
    const last = r[r.length - 1].side;
    return { startS: r[0].t, endS: r[r.length - 1].t, winner: last === "near" ? "far" : "near", why: `last bounce ${last}`, bounces: r.map((b) => `${b.side[0]}${b.t.toFixed(2)}`).join(" ") };
  });

const app = res.events
  .filter((e) => e.type === "rallyEnd" && e.why !== "stop")
  .map((e) => ({ startS: e.t - e.durationS, endS: e.t, why: e.why, judged: judgePoint({ shots: e.shotList || [], bounces: e.bounces || [] }) }))
  .filter((a) => a.judged);

const overlap = (x, w) => Math.min(x.endS, w.endS) - Math.max(x.startS, w.startS);
const allWindows = [...gt.map((g, i) => ({ ...g, point: i })), ...windows.filter((w) => !gt.some((g) => g.startS === w.startS)).map((w) => ({ ...w, point: null }))];
const assigned = app.map((x) => {
  const best = allWindows.map((w) => ({ w, o: overlap(x, w) })).filter((c) => c.o > 0 || (x.endS >= c.w.startS && x.startS <= c.w.endS + 1)).sort((p, q) => q.o - p.o)[0];
  return best ? best.w : null;
});
const rows = gt.map((g, i) => {
  const mine = app.filter((_, k) => assigned[k] && assigned[k].point === i);
  const first = mine[0] || null;
  return { ...g, appEntries: mine.length, appWinner: first?.judged.winner ?? null, appReason: first?.judged.reason ?? null, appSure: !!first?.judged.sure, appSpan: first ? `${first.startS.toFixed(1)}-${first.endS.toFixed(1)}` : null, correct: !!first && first.judged.winner === g.winner };
});
const inFragments = app.filter((_, k) => assigned[k] && assigned[k].point === null).length;
const outside = app.filter((_, k) => !assigned[k]).length;
const extraDup = rows.reduce((n, r) => n + Math.max(0, r.appEntries - 1), 0);
const summary = {
  video: res.video,
  fps: Math.round(fps / res.step),
  gtPoints: gt.length,
  correct: rows.filter((r) => r.correct).length,
  wrong: rows.filter((r) => r.appEntries && !r.correct).length,
  missed: rows.filter((r) => !r.appEntries).length,
  extra: extraDup,
  sureCorrect: rows.filter((r) => r.appSure && r.correct).length,
  sureWrong: rows.filter((r) => r.appSure && r.appEntries && !r.correct).length,
  unverifiedInFragments: inFragments,
  outsideGt: outside,
  fragments: windows.length - gt.length,
};
if (args.out) writeFileSync(args.out, JSON.stringify({ summary, rows, appEntries: app.map((x, k) => ({ ...x, window: assigned[k] ? (assigned[k].point ?? 'fragment') : null })) }, null, 2));
console.log(`POINT_EVAL ${JSON.stringify(summary)}`);
for (const r of rows) console.log(`  ${r.startS.toFixed(1)}-${r.endS.toFixed(1)}s gt=${r.winner}(${r.why}) app=${r.appWinner ?? "-"}(${r.appReason ?? "-"}) span=${r.appSpan ?? "-"} entries=${r.appEntries}`);
