import { bodyBox, Pipeline } from "../js/pipeline.js";
import { createPose } from "../js/pose.js";
import { plausiblePerson } from "../js/players.js";

const q = new URLSearchParams(location.search);
const SRC_FPS = Number(q.get("srcFps") || 120);
const STEP = Number(q.get("step") || 2);
const FROM = Number(q.get("from") || 0);
const TO = Number(q.get("to") || 1e9);
const corners = q.get("corners") ? JSON.parse(q.get("corners")) : null;
const usePose = q.get("pose") !== "0";
const poseEvery = Number(q.get("poseEvery") || 1);
const procWidth = Number(q.get("procWidth") || 640);

const log = (m) => (document.getElementById("log").textContent = m);

async function main() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = q.get("video");
  document.body.append(video);
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error("video load failed"));
  });
  const total = Math.floor(video.duration * SRC_FPS);
  const pose = usePose ? await createPose({ delegate: q.get("delegate") || "GPU", model: q.get("poseModel") || "lite", numPoses: Number(q.get("numPoses") || 2) }) : null;
  const events = [];
  const pipe = new Pipeline({ pose, procWidth, poseEvery, onEvent: (e) => events.push(structuredClone({ ...e, shot: e.shot && { ...e.shot } })) });
  pipe.setVideoSize(video.videoWidth, video.videoHeight);
  if (corners) pipe.setCalibration(corners);
  const frames = [];
  const seek = (time) =>
    new Promise((res) => {
      video.onseeked = () => res();
      video.currentTime = time;
    });
  const last = Math.min(total - 1, TO);
  const wall0 = performance.now();
  for (let f = FROM; f <= last; f += STEP) {
    await seek((f + 0.5) / SRC_FPS);
    const t = f / SRC_FPS;
    // rawPose=1: also run the pose model directly (the app skips it when no table is seen) and
    // record how many detections the person gate accepts, to test skeletons on non-people.
    const raw = q.get("rawPose") && pose ? pose.detect(video, (t + 1000) * 1000, video.videoWidth, video.videoHeight) : null;
    const r = pipe.process(video, t);
    const snap = pipe.snapshot(t);
    frames.push({
      f,
      ball: r.ball && { x: Math.round(r.ball.x), y: Math.round(r.ball.y) },
      cands: r.cands.length,
      cand: q.get("dumpCands") ? r.cands.slice(0, 12).map((c) => [Math.round(c.x * pipe.k), Math.round(c.y * pipe.k), c.area]) : undefined,
      poses: ["near", "far"].filter((s) => snap.players[s].landmarks).length,
      shots: snap.rally ? snap.rally.shots : 0,
      tracking: snap.tracking,
      move: [snap.players.near.moveM, snap.players.far.moveM],
      feet: ["near", "far"].map((s) => {
        const h = pipe.players[s].footHist;
        const p = h[h.length - 1];
        return p && p.t === t ? [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100] : null;
      }),
      wristDeg: [snap.players.near.wristDeg, snap.players.far.wristDeg],
      lock: !!snap.ball.lock,
      rawPoses: raw ? raw.length : undefined,
      acceptedPoses: raw ? raw.filter((lm) => plausiblePerson(lm, pipe.cal)).length : undefined,
      acceptedNoCal: raw ? raw.filter((lm) => plausiblePerson(lm, null)).length : undefined,
      boxes: q.get("dumpPose")
        ? ["near", "far"].map((s) => {
            const b = snap.players[s].landmarks && bodyBox(snap.players[s].landmarks);
            return b && [b.x0, b.y0, b.x1, b.y1].map(Math.round);
          })
        : undefined,
    });
    if (frames.length % 50 === 0) log(`frame ${f}/${last}`);
  }
  pipe.reset();
  window.__result = {
    video: q.get("video"),
    width: video.videoWidth,
    height: video.videoHeight,
    srcFps: SRC_FPS,
    step: STEP,
    procWidth,
    delegate: pose ? pose.delegate : null,
    perf: pipe.perf,
    wallMs: performance.now() - wall0,
    frames,
    events,
  };
  log("done");
}

main().catch((e) => {
  window.__result = { error: String(e && e.stack ? e.stack : e) };
  log("error " + e);
});
