import { FilesetResolver, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";

export async function createPose({ model = "lite", numPoses = 2, delegate = "GPU" } = {}) {
  const base = new URL("../", import.meta.url);
  const fileset = await FilesetResolver.forVisionTasks(new URL("vendor/mediapipe/wasm", base).href);
  const options = (d) => ({
    baseOptions: { modelAssetPath: new URL(`models/pose_landmarker_${model}.task`, base).href, delegate: d },
    runningMode: "VIDEO",
    numPoses,
    // 0.5 made the model drop the player at the frame edge (both players 73% -> 0% of frames on
    // test_2); objects are rejected by plausiblePerson() in players.js instead.
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  let landmarker;
  let used = delegate;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, options(delegate));
  } catch (err) {
    if (delegate !== "GPU") throw err;
    used = "CPU";
    landmarker = await PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
  let lastTs = -1;
  return {
    delegate: used,
    detect(source, tMs, width, height) {
      const ts = Math.max(lastTs + 1, Math.round(tMs));
      lastTs = ts;
      const res = landmarker.detectForVideo(source, ts);
      return (res.landmarks || []).map((pose) =>
        pose.map((p) => ({ x: p.x * width, y: p.y * height, v: p.visibility ?? 1 })),
      );
    },
    close() {
      landmarker.close();
    },
  };
}
