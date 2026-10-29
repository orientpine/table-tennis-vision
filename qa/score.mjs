import { readFileSync, writeFileSync } from "node:fs";
import { makeCalibration } from "../public/js/geom.js";
import { RallyEngine } from "../public/js/rally.js";

const [resultPath, markupDir, outPath] = process.argv.slice(2);
const res = JSON.parse(readFileSync(resultPath, "utf8"));
const ballGt = JSON.parse(readFileSync(`${markupDir}/ball_markup.json`, "utf8"));
const evGt = JSON.parse(readFileSync(`${markupDir}/events_markup.json`, "utf8"));
const fps = res.srcFps;
const R = 20;
const TOL = 6;
const f0 = res.frames[0].f;
const f1 = res.frames[res.frames.length - 1].f;

let annotated = 0;
let tp = 0;
let outOnAnnotated = 0;
let goodOut = 0;
for (const fr of res.frames) {
  const g = ballGt[fr.f];
  if (!g) continue;
  const visible = g.x >= 0;
  if (visible) annotated++;
  if (fr.ball) {
    outOnAnnotated++;
    if (visible && Math.hypot(fr.ball.x - g.x, fr.ball.y - g.y) <= R) {
      goodOut++;
      tp++;
    }
  }
}
const ball = {
  radiusPx: R,
  annotatedVisibleFrames: annotated,
  recall: annotated ? tp / annotated : null,
  precision: outOnAnnotated ? goodOut / outOnAnnotated : null,
  framesWithBall: res.frames.filter((f) => f.ball).length,
  framesEvaluated: res.frames.length,
};

const lastAnnotated = Math.max(...Object.keys(evGt).map(Number), ...Object.keys(ballGt).map(Number));
const fEnd = Math.min(f1, lastAnnotated + 30);
const gtB = Object.entries(evGt).filter(([f, e]) => e === "bounce" && +f >= f0 && +f <= fEnd).map(([f]) => +f).sort((a, b) => a - b);
const ourBEv = res.events.filter((e) => e.type === "bounce" && Math.round(e.t * fps) <= fEnd);
const ourB = ourBEv.map((e) => Math.round(e.t * fps));
const netX = Number(process.argv[5] || 920);
const gtSide = (f) => (ballGt[f] && ballGt[f].x >= 0 ? (ballGt[f].x < netX ? "near" : "far") : null);
const used = new Set();
let btp = 0;
const matches = [];
for (const g of gtB) {
  let best = -1;
  let bd = TOL + 1;
  ourB.forEach((o, i) => {
    if (!used.has(i) && Math.abs(o - g) < bd) {
      bd = Math.abs(o - g);
      best = i;
    }
  });
  if (best >= 0) {
    used.add(best);
    btp++;
    matches.push([g, ourB[best]]);
  } else matches.push([g, null]);
}
const bp = ourB.length ? btp / ourB.length : 0;
const br = gtB.length ? btp / gtB.length : 0;
const bounce = {
  toleranceFrames: TOL,
  gt: gtB.length,
  detected: ourB.length,
  tp: btp,
  precision: bp,
  recall: br,
  f1: bp + br ? (2 * bp * br) / (bp + br) : 0,
  scoredUntilFrame: fEnd,
  falsePositives: ourB.filter((_, i) => !used.has(i)),
  falsePositivesInsideSameSideGtGap: ourBEv.filter((e, i) => {
    if (used.has(i)) return false;
    const f = Math.round(e.t * fps);
    const prev = [...gtB].reverse().find((g) => g < f);
    const next = gtB.find((g) => g > f);
    if (prev == null || next == null || next - prev > 150) return false;
    const sp = gtSide(prev);
    return sp && sp === gtSide(next) && e.bounce.side !== sp;
  }).map((e) => Math.round(e.t * fps)),
  missed: matches.filter((m) => m[1] == null).map((m) => m[0]),
};

const gtEvents = Object.entries(evGt).map(([f, e]) => [+f, e]).filter(([f, e]) => f >= f0 && f <= f1 && e !== "empty_event").sort((a, b) => a[0] - b[0]);
const gtRallies = [];
for (const [f, e] of gtEvents) {
  const cur = gtRallies[gtRallies.length - 1];
  if (cur && f - cur.end < fps * 1.5) {
    cur.end = f;
    cur[e] = (cur[e] || 0) + 1;
  } else gtRallies.push({ start: f, end: f, [e]: 1 });
}
const ourRallies = res.events.filter((e) => e.type === "rallyEnd").map((e) => ({ start: Math.round((e.t - e.durationS) * fps), end: Math.round(e.t * fps), shots: e.shots, bounces: e.bounces.length }));
const shotFrames = res.events.filter((e) => e.type === "shot").map((e) => Math.round(e.t * fps));
const rallies = gtRallies.map((g) => {
  const overl = ourRallies.filter((o) => o.end >= g.start - fps * 0.5 && o.start <= g.end + fps * 0.5);
  const inWindow = shotFrames.filter((f) => f >= g.start - fps * 0.6 && f <= g.end + fps * 0.1).length;
  return { gtStart: g.start, gtEnd: g.end, gtNetCrossings: g.net || 0, gtBounces: g.bounce || 0, ourShotsInWindow: inWindow, ourRallySegments: overl.length, ourRalliesWithBounce: overl.filter((o) => o.shots >= 2 && o.bounces >= 1).length };
});
const shotFramesAll = res.events.filter((e) => e.type === "shot").map((e) => Math.round(e.t * fps));
// Between two consecutive annotated bounces on opposite sides exactly one hit happens, except
// after a serve's first bounce (server's own side), which crosses the net with no hit. A serve
// bounce is the first bounce after a pause of more than 0.8 s with no annotated event.
const allEventFrames = Object.keys(evGt).map(Number).sort((a, b) => a - b);
const isServeBounce = (f) => {
  const prev = allEventFrames.filter((g) => g < f).pop();
  return prev == null || f - prev > fps * 0.8;
};
const intervals = [];
for (let i = 1; i < gtB.length; i++) {
  const [a, b] = [gtB[i - 1], gtB[i]];
  if (b - a > 150 || !gtSide(a) || !gtSide(b) || gtSide(a) === gtSide(b)) continue;
  const expected = isServeBounce(a) ? 0 : 1;
  intervals.push({ from: a, to: b, expected, shots: shotFramesAll.filter((f) => f > a && f <= b).length });
}
const shotsBetweenBounces = {
  note: "opposite-side GT bounce pairs: 1 hit expected, 0 after a serve's own-side bounce",
  intervals: intervals.length,
  serveIntervals: intervals.filter((x) => x.expected === 0).length,
  exactlyOne: intervals.filter((x) => x.shots === x.expected).length,
  none: intervals.filter((x) => x.shots < x.expected).length,
  moreThanOne: intervals.filter((x) => x.shots > x.expected).length,
};
const shotErr = rallies.map((r) => Math.abs(r.ourShotsInWindow - r.gtNetCrossings));
// Reference speed per annotated flight: GT ball positions through the app's own table
// projection, split at horizontal direction changes, slope of distance-along-table vs time.
let speed = null;
if (process.env.PPV_CORNERS) {
  const projector = new RallyEngine({ calibration: makeCalibration(JSON.parse(process.env.PPV_CORNERS)) });
  const vis = Object.keys(ballGt).map(Number).filter((f) => ballGt[f].x >= 0 && f >= f0 && f <= fEnd).sort((a, b) => a - b);
  const flights = [];
  let run = [];
  const flush = () => {
    if (run.length < 6) return;
    const n = run.length;
    const mt = run.reduce((a, p) => a + p.t, 0) / n;
    const ma = run.reduce((a, p) => a + p.a, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of run) {
      num += (p.t - mt) * (p.a - ma);
      den += (p.t - mt) ** 2;
    }
    const v = Math.abs(num / den) * 3.6;
    if (v > 10) flights.push({ t0: run[0].t, t1: run[run.length - 1].t, v });
  };
  for (const f of vis) {
    const p = { f, t: f / fps, x: ballGt[f].x, a: projector.alongTable(ballGt[f]) };
    const last = run[run.length - 1];
    const prev = run[run.length - 2];
    const broken = last && f !== last.f + 1;
    const reversed = last && prev && Math.sign(p.x - last.x) && Math.sign(last.x - prev.x) && Math.sign(p.x - last.x) !== Math.sign(last.x - prev.x);
    if (broken || reversed) {
      flush();
      run = reversed && !broken ? [last] : [];
    }
    run.push(p);
  }
  flush();
  const finalShots = new Map();
  for (const e of res.events) if (e.type === "shot" || e.type === "shotUpdate") finalShots.set(e.shot.t.toFixed(3), e.shot);
  const shotList = [...finalShots.values()].sort((a, b) => a.t - b.t);
  const pairs = [];
  for (const fl of flights) {
    const s = shotList.filter((x) => x.t <= fl.t1 && x.t >= fl.t0 - 0.6).pop();
    if (s && s.speedKmh) pairs.push({ gtKmh: Math.round(fl.v), ourKmh: s.speedKmh });
  }
  const rel = pairs.map((p) => Math.abs(p.ourKmh - p.gtKmh) / p.gtKmh).sort((a, b) => a - b);
  const ratio = pairs.map((p) => p.ourKmh / p.gtKmh).sort((a, b) => a - b);
  speed = {
    flights: flights.length,
    paired: pairs.length,
    medianRatio: ratio.length ? ratio[ratio.length >> 1] : null,
    medianAbsRelErr: rel.length ? rel[rel.length >> 1] : null,
    within30pct: rel.filter((x) => x <= 0.3).length,
    pairs,
  };
}
const pose = {
  framesBoth: res.frames.filter((f) => f.poses === 2).length / res.frames.length,
  framesAny: res.frames.filter((f) => f.poses >= 1).length / res.frames.length,
};
bounce.precisionIfGtGapsCounted = bounce.detected ? (bounce.tp + bounce.falsePositivesInsideSameSideGtGap.length) / bounce.detected : 0;
const summary = {
  video: res.video,
  frames: [f0, f1],
  step: res.step,
  effectiveFps: fps / res.step,
  procWidth: res.procWidth,
  delegate: res.delegate,
  perfMs: res.perf,
  ball,
  bounce,
  rallies,
  shotsBetweenBounces,
  speed,
  rallyShotMeanAbsErr: shotErr.length ? shotErr.reduce((a, b) => a + b, 0) / shotErr.length : null,
  pose,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(1) + "%");
console.log(`SCORE ball recall=${pct(ball.recall)} precision=${pct(ball.precision)} (n=${annotated}) | bounce P=${pct(bounce.precision)} R=${pct(bounce.recall)} F1=${pct(bounce.f1)} (gt=${gtB.length}, det=${ourB.length}, gtGapFP=${bounce.falsePositivesInsideSameSideGtGap.length}, P_adj=${pct(bounce.precisionIfGtGapsCounted)}) | shots: ${shotsBetweenBounces.exactlyOne}/${shotsBetweenBounces.intervals} bounce-intervals have the expected hit count (${shotsBetweenBounces.serveIntervals} serve intervals expect 0; missing ${shotsBetweenBounces.none}, extra ${shotsBetweenBounces.moreThanOne}) | speed: ${speed ? `median ratio ${speed.medianRatio?.toFixed(2)}, median err ${pct(speed.medianAbsRelErr)}, ${speed.within30pct}/${speed.paired} within 30%` : "n/a"} | pose both=${pct(pose.framesBoth)} any=${pct(pose.framesAny)} | ms ball=${res.perf.ballMs?.toFixed(1)} pose=${res.perf.poseMs?.toFixed(1)}`);
