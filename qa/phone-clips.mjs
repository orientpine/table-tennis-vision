// Public clips remain local. Run from repository root; see evidence/r4/phone/README.md.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Pipeline } from "../public/js/pipeline.js";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
if (!args.clip || !args.video) throw new Error("Required: --clip=cozza|portrait_game --video=/local/video.webm");
const config = JSON.parse(readFileSync(args.labels || "evidence/r4/phone/labels.json")).clips[args.clip];
if (!config) throw new Error(`Unknown clip ${args.clip}`);
const probe = spawnSync("ffprobe", ["-v","error","-select_streams","v:0","-show_packets","-show_streams","-show_format","-of","json",args.video], {encoding:"utf8", maxBuffer: 8e6});
if (probe.status !== 0) throw new Error(probe.stderr);
const info = JSON.parse(probe.stdout);
const stream = info.streams[0];
const pts = info.packets.map(p => Number(p.pts_time));
const [num, den] = stream.avg_frame_rate.split("/").map(Number);
const probedAvgFps = num / den;
// Cozza's container claims 15360 fps despite 486 packets in 17.859 seconds.
const fps = probedAvgFps > 240 ? pts.length / Number(info.format.duration) : probedAvgFps;
const corners = args.corners ? JSON.parse(args.corners) : config.corners;
const pipe = new Pipeline();
pipe.setVideoSize(stream.width, stream.height);
pipe.setCalibration(corners);
const labelsByIndex = new Map(config.labels.map(gt => {
  const i = pts.findIndex(t => t + 1e-7 >= gt.t);
  if (i < 0) throw new Error(`No source frame at ${gt.t}`);
  return [i, gt];
}));
const ff = spawn("nice", ["-n","10","ffmpeg","-v","error","-threads","1","-i",args.video,"-vf",`scale=${pipe.pw}:${pipe.ph}`,"-filter_threads","1","-fps_mode","passthrough","-f","rawvideo","-pix_fmt","rgba","-"]);
let stderr = "";
ff.stderr.on("data", b => stderr += b);
const done = new Promise((resolve,reject) => {
  ff.on("error",reject);
  ff.on("close",code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)));
});
const frameSize = pipe.pw * pipe.ph * 4;
let buffer = Buffer.alloc(0);
const perFrame = [], rows = [];
const summary = {frames:0, labelledFrames:config.labels.length, gtBalls:0, tp:0, fp:0, fn:0, stateCounts:{}};
console.log(`WORKING ${args.clip}: ${stream.width}x${stream.height}, processing ${pipe.pw}x${pipe.ph}, fps=${fps.toFixed(6)} (probed ${probedAvgFps})`);
for await (const chunk of ff.stdout) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= frameSize) {
    const n = summary.frames;
    const t = n / fps;
    const pixels = new Uint8ClampedArray(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + frameSize));
    buffer = buffer.subarray(frameSize);
    pipe.processPixels(pixels,t);
    const app = pipe.ball ? {...pipe.ball} : null;
    const gt = labelsByIndex.get(n) || null;
    const trackingState = pipe.tracking;
    summary.stateCounts[trackingState] = (summary.stateCounts[trackingState] || 0) + 1;
    let verdict = "unlabelled";
    if (gt) {
      if (gt.ballVisible) summary.gtBalls++;
      const correct = gt.ballVisible && app && Math.hypot(app.x-gt.x, app.y-gt.y) <= 25;
      const fp = !!app && !correct;
      const fn = gt.ballVisible && !correct;
      if (correct) summary.tp++;
      if (fp) summary.fp++;
      if (fn) summary.fn++;
      verdict = correct ? "TP" : fp && fn ? "FP+FN" : fp ? "FP" : fn ? "FN" : "TN";
    }
    const row = {t, sourceT:pts[n], frameIndex:n, gt, app, trackingState, verdict};
    perFrame.push(row);
    if (gt) rows.push({...row,t:gt.t, pipelineT:t,trail:pipe.trail.map(p=>({...p}))});
    summary.frames++;
  }
}
await done;
if (buffer.length || rows.length !== config.labels.length || summary.frames !== pts.length) throw new Error(`Incomplete frames/labels: ${summary.frames}/${pts.length}, ${rows.length}/${config.labels.length}`);
const out = args.out || `evidence/r4/phone/${args.clip}.json`;
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify({clip:args.clip,video:args.video,size:[stream.width,stream.height],corners,cornerConfidence:config.cornerConfidence,probedAvgFps,fps,timebaseNote:probedAvgFps>240 ? "Invalid container avg_frame_rate; effective average is packet count / format duration. Pipeline uses index / effective average; GT matches source packet PTS." : "Pipeline uses frame index / probed avg fps; GT matches source packet PTS.",summary,rows,perFrame},null,2)+"\n");
console.log(`SUMMARY ${args.clip} ${JSON.stringify(summary)}`);
