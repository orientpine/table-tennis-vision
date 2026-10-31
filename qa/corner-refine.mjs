// Corner snapping accuracy: perturb each video's read corners (qa/eval-set.json) like rough
// taps, run public/js/calib-refine.js on five full-size frames (median per corner), and compare both against the read
// corners.  bun qa/corner-refine.mjs [--frames=600,1500,3000,4500,6000] [--out=evidence/r4/corner-refine.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { refineCorners, refineCornersMulti } from "../public/js/calib-refine.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const set = JSON.parse(readFileSync(args.set || "qa/eval-set.json", "utf8"));
const frameNos = (args.frames || "600,1500,3000,4500,6000").split(",").map(Number);
const frameNo = frameNos[0];
const out = args.out || "evidence/r4/corner-refine.json";
const RADII = [8, 15, 25, 40];
const ANGLES = 6;

// All sample frames of one video in a single decode (frames past the end are dropped).
function framesOf(video, ns) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], { encoding: "utf8" });
  const [w, h] = probe.stdout.trim().split(",").map(Number);
  const sel = ns.map((n) => `eq(n\\,${n})`).join("+");
  const ff = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `select=${sel}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: ns.length * w * h * 4 + 1024 });
  const size = w * h * 4;
  const out = [];
  for (let o = 0; o + size <= ff.stdout.length; o += size) out.push({ w, h, rgba: new Uint8ClampedArray(ff.stdout.buffer, ff.stdout.byteOffset + o, size) });
  return out;
}

const err = (a, b) => a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y));
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const report = { frame: frameNo, radii: RADII, angles: ANGLES, videos: {} };
for (const v of set.videos) {
  if (!v.markup || v.name.includes("oldcorners")) continue;
  const frames = framesOf(v.video, frameNos);
  const gt = v.corners;
  const byRadius = {};
  for (const r of RADII) {
    const before = [];
    const after = [];
    let ok = 0;
    let n = 0;
    const reasons = {};
    let single = 0;
    for (let a = 0; a < ANGLES; a++) {
      // Each corner pushed r px in its own direction, so the quad is skewed, not shifted.
      const taps = gt.map((p, i) => {
        const th = ((a * 4 + i) * 2.399963) % (2 * Math.PI);
        return { x: Math.round(p.x + r * Math.cos(th)), y: Math.round(p.y + r * Math.sin(th)) };
      });
      const res = refineCornersMulti(frames, taps);
      const one = refineCorners(frames[0].rgba, frames[0].w, frames[0].h, taps);
      if (one.ok) single++;
      if (!res.ok) reasons[res.reason] = (reasons[res.reason] || 0) + 1;
      n++;
      if (res.ok) ok++;
      before.push(...err(taps, gt));
      after.push(...err(res.corners, gt));
    }
    byRadius[r] = { trials: n, frames: frames.length, snapped: ok, snappedSingleFrame: single, reasons, meanErrBeforePx: +mean(before).toFixed(1), meanErrAfterPx: +mean(after).toFixed(1), maxErrAfterPx: +Math.max(...after).toFixed(1) };
  }
  report.videos[v.name] = byRadius;
  console.log(v.name, JSON.stringify(byRadius));
}
const old = set.videos.find((v) => v.name === "test_2_oldcorners");
const t2 = set.videos.find((v) => v.name === "test_2");
if (old && t2) {
  const res = refineCornersMulti(framesOf(t2.video, frameNos), old.corners);
  report.test2OldCorners = { ok: res.ok, reason: res.reason, errBeforePx: err(old.corners, t2.corners).map((x) => +x.toFixed(1)), errAfterPx: err(res.corners, t2.corners).map((x) => +x.toFixed(1)), corners: res.corners };
  console.log("test_2 old corners", JSON.stringify(report.test2OldCorners));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
