import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Pipeline } from "../public/js/pipeline.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const video = args.video || "data/videos/test_2.mp4";
const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video], { encoding: "utf8" });
const [vw, vh, rate] = probe.stdout.trim().split(",");
if (!+vw || !+vh) throw new Error(`ffprobe failed for ${video}: ${probe.stderr}`);
const srcFps = Number(args.srcFps || Math.round(rate.split("/").reduce((a, b) => a / b)));
const fps = Number(args.fps || Math.min(60, srcFps));
const pw = Number(args.procWidth || 640);
// --from/--to in source frames (inclusive); frame numbers in the output stay source frames.
const fFrom = Number(args.from || 0);
const fTo = Number(args.to || 1e9);
const ph = Math.round((vh / vw) * pw);
const k = vw / pw;
const corners = args.corners ? JSON.parse(args.corners) : null;
const out = args.out || "evidence/raw/offline.json";
const opts = args.opts ? JSON.parse(args.opts) : {};
const boxesByFrame = new Map();
if (args.boxes) {
  for (const fr of JSON.parse(readFileSync(args.boxes, "utf8")).frames) boxesByFrame.set(fr.f, (fr.boxes || []).filter(Boolean));
}
// Nearest pose dump frame within --boxGap source frames (2 for a full-rate dump, 12 for the
// every-12th-frame dumps of qa/eval-all.mjs --pose=1).
const boxGap = Number(args.boxGap || 2);
function boxesFor(f) {
  for (let d = 0; d <= boxGap; d++) for (const g of [f - d, f + d]) if (boxesByFrame.has(g)) return boxesByFrame.get(g);
  return [];
}

// The app's own pixel path (table check, shake gate, lock gate, rally), without pose; body boxes
// from a browser pose dump stand in for the pose exclusion.
const events = [];
const pipe = new Pipeline({ procWidth: pw, ballColor: args.color || "white", onEvent: (e) => events.push(JSON.parse(JSON.stringify(e))) });
pipe.setVideoSize(+vw, +vh);
pipe.setCalibration(corners);
if (opts.det) Object.assign(pipe.detector, opts.det);
if (opts.trk) Object.assign(pipe.tracker, opts.trk);

const step = Math.round(srcFps / fps);
const ff = spawn("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=between(n\\,${fFrom}\\,${fTo})*not(mod(n-${fFrom}\\,${step})),scale=${pw}:${ph}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
const size = pw * ph * 4;
let buf = Buffer.alloc(0);
let i = 0;
const frames = [];
let ms = 0;
ff.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= size) {
    const frame = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size));
    buf = buf.subarray(size);
    const fsrc = fFrom + i * step;
    const t = fsrc / srcFps;
    const t0 = performance.now();
    const exclude = boxesFor(fsrc).map(([x0, y0, x1, y1]) => ({ x0: x0 / k - 2, y0: y0 / k - 2, x1: x1 / k + 2, y1: y1 / k + 2 }));
    const { cands, ball } = pipe.processPixels(frame, t, { exclude });
    // --trail=1 scores what the trail shows: points handed back when the lock was acquired
    // land on their own (earlier) frames.
    if (args.trail) for (const q of pipe.trail) {
      const j = Math.round((q.t * srcFps - fFrom) / step);
      if (j < frames.length && !frames[j].ball) frames[j].ball = { x: Math.round(q.x), y: Math.round(q.y), backfill: true };
    }
    ms += performance.now() - t0;
    frames.push({
      f: fsrc,
      ball: ball && { x: Math.round(ball.x), y: Math.round(ball.y) },
      cands: cands.length,
      cand: args.dumpCands ? cands.slice(0, 60).map((c) => [Math.round(c.x * k), Math.round(c.y * k), c.area]) : undefined,
      poses: 0,
    });
    i++;
  }
});
ff.on("close", () => {
  pipe.rally.update((fFrom + i * step) / srcFps + 5, null, null);
  const result = { video, width: +vw, height: +vh, srcFps, step, procWidth: pw, delegate: null, perf: { ballMs: ms / i, poseMs: 0, ms: ms / i }, wallMs: ms, frames, events };
  writeFileSync(out, JSON.stringify(result));
  console.log(`OFFLINE frames=${i} ballMs=${(ms / i).toFixed(2)} -> ${out}`);
});
