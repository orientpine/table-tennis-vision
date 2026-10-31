// qa/orange-synth.mjs - make a SYNTHETIC orange-ball copy of an OpenTTGames video: on every frame
// with a visible ball in ball_markup.json, the ball's pixels (brighter than the ring around it)
// are recoloured to table-tennis orange, keeping the motion-blur blend with the background.
// Everything else (white shirts, lines, the floor) stays as filmed, so a run with
// ballColor "orange" measures the orange colour path against the same ground truth, and a run
// with "white" shows the white path no longer finding the ball. Synthetic: no real orange ball
// was filmed; say so wherever the numbers are quoted.
//
//   bun qa/orange-synth.mjs --video=data/videos/test_2.mp4 --markup=data/videos/test_2 \
//     --out=data/videos/test_2_orange.mp4 [--from=0 --to=3600] [--shade=light|deep]
//
// shade: light = a lit orange ball after phone compression (green ~0.62 of red), deep = a deeper
// orange (green ~0.45 of red), so the colour test is checked across the shades a club ball shows.
//
// Output: H.264 at the source size and fps (never commit it; data/ is gitignored).
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const video = args.video || "data/videos/test_2.mp4";
const markup = JSON.parse(readFileSync(`${args.markup || "data/videos/test_2"}/ball_markup.json`, "utf8"));
const out = args.out || "data/videos/test_2_orange.mp4";
const from = Number(args.from || 0);
const to = Number(args.to || 1e9);
const shade = args.shade === "deep" ? [1.18, 0.45, 0.06] : [1.18, 0.62, 0.16];
const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video], { encoding: "utf8" }).stdout.trim().split(",");
const [W, H] = [Number(probe[0]), Number(probe[1])];
const rate = probe[2];
const FRAME = W * H * 3;
// Window around the marked centre (px at 1920 wide): a fast ball smears over ~20 px.
const S = W / 1920;
const RIN = Math.round(16 * S);
const ROUT = Math.round(20 * S);

// Orange for a ball whose brightest pixel has luminance L: hue ~25 deg, like a lit orange
// ball (ITTF orange) seen by a phone. Same peak brightness as the white ball it replaces.
function orange(L) {
  return shade.map((k) => Math.min(255, L * k));
}

function lum(b, i) {
  return (b[i] * 77 + b[i + 1] * 151 + b[i + 2] * 28) >> 8;
}

let changedFrames = 0;
let changedPx = 0;
function recolour(buf, gx, gy) {
  const cx = Math.round(gx), cy = Math.round(gy); // markup is in source px
  // ring: background luminance and colour
  const ring = [];
  for (let dy = -ROUT; dy <= ROUT; dy++) for (let dx = -ROUT; dx <= ROUT; dx++) {
    const d = Math.hypot(dx, dy);
    if (d < RIN || d > ROUT) continue;
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    ring.push(lum(buf, (y * W + x) * 3));
  }
  if (!ring.length) return;
  ring.sort((a, b) => a - b);
  const bg = ring[ring.length >> 1];
  let peak = 0;
  for (let dy = -RIN; dy <= RIN; dy++) for (let dx = -RIN; dx <= RIN; dx++) {
    if (Math.hypot(dx, dy) > RIN) continue;
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    peak = Math.max(peak, lum(buf, (y * W + x) * 3));
  }
  if (peak - bg < 12) return; // ball not brighter than its surroundings here: leave the frame alone
  const o = orange(peak);
  // Only the bright blob the mark sits on: flood from the brightest pixel near the mark, so a
  // white line or logo elsewhere in the window keeps its colour.
  const near = Math.round(6 * S);
  let seed = null, seedL = -1;
  for (let dy = -near; dy <= near; dy++) for (let dx = -near; dx <= near; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const L = lum(buf, (y * W + x) * 3);
    if (L > seedL) { seedL = L; seed = [x, y]; }
  }
  if (!seed || seedL < bg + 8) return;
  const blob = new Set();
  const stack = [seed];
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = y * W + x;
    if (blob.has(key) || x < 0 || y < 0 || x >= W || y >= H || Math.hypot(x - cx, y - cy) > RIN) continue;
    if (lum(buf, key * 3) < bg + 8) continue;
    blob.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  let n = 0;
  for (const key of blob) {
    const i = key * 3;
    const L = lum(buf, i);
    // share of the pixel covered by the ball (blur blend between background and ball)
    const w = Math.min(1, (L - bg) / Math.max(20, peak - bg));
    // pixel = background*(1-w) + white*w; swap the white share (all channels ~peak) for orange
    for (let c = 0; c < 3; c++) buf[i + c] = Math.max(0, Math.min(255, Math.round(buf[i + c] + w * (o[c] - peak))));
    n++;
  }
  if (n) { changedFrames++; changedPx += n; }
}

const dec = spawn("ffmpeg", ["-loglevel", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
const enc = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", rate, "-i", "-", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p", out]);
let pending = Buffer.alloc(0);
let f = 0;
const writeFrame = (buf) => new Promise((res) => (enc.stdin.write(buf) ? res() : enc.stdin.once("drain", res)));
for await (const chunk of dec.stdout) {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= FRAME) {
    const frame = Buffer.from(pending.subarray(0, FRAME));
    pending = pending.subarray(FRAME);
    const g = markup[f];
    if (f >= from && f <= to && g && g.x >= 0) recolour(frame, g.x, g.y);
    await writeFrame(frame);
    f++;
  }
}
enc.stdin.end();
await new Promise((res) => enc.on("close", res));
console.log(JSON.stringify({ video, out, frames: f, size: [W, H], recolouredFrames: changedFrames, meanPxPerFrame: changedFrames ? Math.round(changedPx / changedFrames) : 0 }));
