// Accuracy over every public video in qa/eval-set.json, through the app's own pixel path.
//   bun qa/eval-all.mjs [--set=qa/eval-set.json] [--out=evidence/r4/base] [--only=test_1,test_3]
//                       [--fps=60] [--opts='{"det":{...},"trk":{...}}'] [--jobs=6] [--pose=1]
// --pose=1 first runs the browser harness (qa/eval-run.mjs, MediaPipe pose, every 12th source
// frame) per video into evidence/r4/pose/<name>.json; later runs reuse those dumps for the
// two-player rate and as body boxes the ball detector skips, like the app does.
// Writes <out>/<name>.score.json per video and <out>/table.md + <out>/summary.json.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const set = JSON.parse(readFileSync(args.set || "qa/eval-set.json", "utf8"));
const out = args.out || "evidence/r4/base";
const poseDir = args.poseDir || "evidence/r4/pose";
const rawDir = `${out}/raw`;
const fps = Number(args.fps || 60);
const jobs = Number(args.jobs || 6);
const only = args.only ? new Set(args.only.split(",")) : null;
const videos = set.videos.filter((v) => v.markup && (!only || only.has(v.name)));
mkdirSync(rawDir, { recursive: true });
mkdirSync(poseDir, { recursive: true });

function run(cmd, argv, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { env: { ...process.env, ...env } });
    let so = "";
    let se = "";
    p.stdout.on("data", (d) => (so += d));
    p.stderr.on("data", (d) => (se += d));
    p.on("close", (code) => resolve({ code, so, se }));
  });
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        res[i] = await fn(items[i]);
      }
    }),
  );
  return res;
}

if (args.pose) {
  const port = 8800 + Math.floor(Math.random() * 90);
  const server = spawn("bun", ["server.js"], { env: { ...process.env, PPV_QA: "1", PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await pool(videos, Math.min(jobs, 4), async (v) => {
    const r = await run("bun", [
      "qa/eval-run.mjs",
      `--base=http://127.0.0.1:${port}/vision/`,
      `--video=${v.video.replace(/^data\/videos\//, "./videos/")}`,
      `--srcFps=${v.srcFps || 120}`,
      "--step=12",
      "--delegate=CPU",
      "--dumpPose=1",
      `--corners=${JSON.stringify(v.corners)}`,
      ...(v.poseTo ? [`--to=${v.poseTo}`] : []),
      `--out=${poseDir}/${v.name}.json`,
    ]);
    console.log(`POSE ${v.name} exit=${r.code} ${r.so.trim().split("\n").pop()} ${r.code ? r.se.slice(-400) : ""}`);
  });
  server.kill();
}

const rows = await pool(videos, jobs, async (v) => {
  const posePath = `${poseDir}/${v.name}.json`;
  const hasPose = existsSync(posePath) && !JSON.parse(readFileSync(posePath, "utf8")).error;
  const raw = `${rawDir}/${v.name}.json`;
  const scorePath = `${out}/${v.name}.score.json`;
  const a = await run("bun", [
    "qa/ball-offline.mjs",
    `--video=${v.video}`,
    `--fps=${fps}`,
    `--corners=${JSON.stringify(v.corners)}`,
    `--out=${raw}`,
    ...(hasPose ? [`--boxes=${posePath}`, "--boxGap=12"] : []),
    ...(v.from != null ? [`--from=${v.from}`] : []),
    ...(v.to != null ? [`--to=${v.to}`] : []),
    ...(args.opts ? [`--opts=${args.opts}`] : []),
    ...(args.color ? [`--color=${args.color}`] : []),
  ]);
  if (a.code) return { name: v.name, error: a.se.slice(-600) };
  const s = await run("bun", ["qa/score.mjs", raw, v.markup, scorePath], { PPV_CORNERS: JSON.stringify(v.corners) });
  if (s.code) return { name: v.name, error: s.se.slice(-600) };
  const sc = JSON.parse(readFileSync(scorePath, "utf8"));
  if (hasPose) {
    const pf = JSON.parse(readFileSync(posePath, "utf8")).frames || [];
    sc.pose = { source: posePath, sampledFrames: pf.length, framesBoth: pf.filter((f) => f.poses === 2).length / pf.length, framesAny: pf.filter((f) => f.poses >= 1).length / pf.length };
    writeFileSync(scorePath, JSON.stringify(sc, null, 2));
  }
  console.log(`${v.name} ${s.so.trim()}`);
  return { name: v.name, sc };
});

const pct = (x) => (x == null || Number.isNaN(x) ? "-" : `${(x * 100).toFixed(1)}%`);
const lines = [
  "| video | ball recall | ball precision | bounce F1 (labelled stretches) | shots (bounce pairs right) | speed median err (n) | serve start R / P | net crossing R / P | two players (pose) | ball ms |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
const summary = {};
for (const r of rows) {
  if (r.error) {
    lines.push(`| ${r.name} | ERROR ${r.error.replace(/\n/g, " ").slice(0, 200)} |`);
    summary[r.name] = { error: r.error };
    continue;
  }
  const s = r.sc;
  const sb = s.shotsBetweenBounces;
  summary[r.name] = {
    ballRecall: s.ball.recall,
    ballPrecision: s.ball.precision,
    annotated: s.ball.annotatedVisibleFrames,
    bounceF1: s.bounceWin.f1,
    bounceP: s.bounceWin.precision,
    bounceR: s.bounceWin.recall,
    bounceF1Legacy: s.bounce.f1,
    shotsRight: sb.exactlyOne,
    shotIntervals: sb.intervals,
    shotsMissing: sb.none,
    shotsExtra: sb.moreThanOne,
    speedMedianErr: s.speed && s.speed.medianAbsRelErr,
    speedMedianRatio: s.speed && s.speed.medianRatio,
    speedPaired: s.speed && s.speed.paired,
    serveR: s.serveStart.recall,
    serveP: s.serveStart.precision,
    netR: s.netCrossing.recall,
    netP: s.netCrossing.precision,
    poseBoth: s.pose.sampledFrames ? s.pose.framesBoth : null,
    poseAny: s.pose.sampledFrames ? s.pose.framesAny : null,
    ballMs: s.perfMs.ballMs,
  };
  const m = summary[r.name];
  lines.push(
    `| ${r.name} | ${pct(m.ballRecall)} | ${pct(m.ballPrecision)} | ${pct(m.bounceF1)} | ${m.shotsRight}/${m.shotIntervals} | ${pct(m.speedMedianErr)} (${m.speedPaired ?? 0}) | ${pct(m.serveR)} / ${pct(m.serveP)} | ${pct(m.netR)} / ${pct(m.netP)} | ${pct(m.poseBoth)} | ${m.ballMs.toFixed(1)} |`,
  );
}
writeFileSync(`${out}/table.md`, lines.join("\n") + "\n");
writeFileSync(`${out}/summary.json`, JSON.stringify({ fps, opts: args.opts ? JSON.parse(args.opts) : null, videos: summary }, null, 2));
console.log(lines.join("\n"));
