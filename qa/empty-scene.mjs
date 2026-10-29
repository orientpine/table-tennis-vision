// Empty-scene false-positive test: runs the app's own Pipeline pixel path (no pose) over a video
// that has no table and no ball, and counts everything the HUD would show as ball activity.
//   bun qa/empty-scene.mjs --video=data/videos/home_handheld.mp4 [--corners='<json>'|--corners=none] [--out=x.json]
// PASS = no ball drawn, no LOCK, no rally, no shot, no bounce. Exit code 1 on FAIL.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pipeline } from "../public/js/pipeline.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const video = args.video || "data/videos/home_handheld.mp4";
const fps = Number(args.fps || 60);
const corners = args.corners && args.corners !== "none" ? JSON.parse(args.corners) : null;
const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], { encoding: "utf8" });
const [vw, vh] = probe.stdout.trim().split(",").map(Number);
if (!vw || !vh) throw new Error(`ffprobe failed for ${video}: ${probe.stderr}`);

const events = [];
const pipe = new Pipeline({ onEvent: (e) => events.push(e.type) });
pipe.setVideoSize(vw, vh);
pipe.setCalibration(corners);
const { pw, ph } = pipe;

const ff = spawn("ffmpeg", ["-v", "error", "-i", video, "-vf", `fps=${fps},scale=${pw}:${ph}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
const size = pw * ph * 4;
let buf = Buffer.alloc(0);
let n = 0;
const m = { frames: 0, ballFrames: 0, lockFrames: 0, maxTrail: 0, rallyFrames: 0, maxShots: 0, maxBounces: 0, maxSpeedKmh: null, calibrationIssue: null };
ff.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= size) {
    const frame = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size));
    buf = buf.subarray(size);
    const t = n / fps;
    pipe.processPixels(frame, t);
    const s = pipe.snapshot(t);
    m.frames++;
    if (s.ball.current) m.ballFrames++;
    if (s.ball.lock) m.lockFrames++;
    m.maxTrail = Math.max(m.maxTrail, s.ball.trail.length);
    if (s.rally) {
      m.rallyFrames++;
      m.maxShots = Math.max(m.maxShots, s.rally.shots);
      m.maxBounces = Math.max(m.maxBounces, s.rally.bounces.length);
      if (s.rally.maxSpeedKmh != null) m.maxSpeedKmh = Math.max(m.maxSpeedKmh ?? 0, s.rally.maxSpeedKmh);
    }
    if (s.calibrationIssue) m.calibrationIssue = s.calibrationIssue;
    n++;
  }
});
ff.on("close", () => {
  const counts = events.reduce((a, e) => ((a[e] = (a[e] || 0) + 1), a), {});
  const pass = m.ballFrames === 0 && m.lockFrames === 0 && m.maxTrail === 0 && m.rallyFrames === 0 && !counts.shot && !counts.bounce && !counts.rallyStart;
  const result = { video, size: [vw, vh], corners, ...m, events: counts, pass };
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(result, null, 2));
  }
  console.log(`${pass ? "PASS" : "FAIL"} ${video} corners=${corners ? "set" : "none"} frames=${m.frames} ballFrames=${m.ballFrames} lockFrames=${m.lockFrames} maxTrail=${m.maxTrail} rallyFrames=${m.rallyFrames} shots=${counts.shot || 0} bounces=${counts.bounce || 0} rallies=${counts.rallyStart || 0} maxSpeed=${m.maxSpeedKmh}`);
  process.exit(pass ? 0 : 1);
});
