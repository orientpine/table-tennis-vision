import { FilesetResolver, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { downloadAll } from "./download.js";

// Sizes for when a proxy drops Content-Length (bytes, @mediapipe/tasks-vision 0.10 and the bundled models).
const KNOWN = {
  "vision_wasm_internal.js": 334128,
  "vision_wasm_internal.wasm": 14466654,
  "vision_wasm_nosimd_internal.js": 333931,
  "vision_wasm_nosimd_internal.wasm": 12915401,
  "pose_landmarker_lite.task": 5777746,
  "pose_landmarker_full.task": 9398198,
};

// onProgress({ phase: "download", received, total }) while the files arrive, then { phase: "init" }.
// The model goes to MediaPipe as a buffer; the wasm loader and binary were just fetched with the same
// URLs, so MediaPipe's own requests come from the HTTP cache (immutable) or the service worker.
export async function createPose({ model = "lite", numPoses = 2, delegate = "GPU", onProgress = () => {} } = {}) {
  const base = new URL("../", import.meta.url);
  const fileset = await FilesetResolver.forVisionTasks(new URL("vendor/mediapipe/wasm", base).href);
  const modelUrl = new URL(`models/pose_landmarker_${model}.task`, base).href;
  const file = (url) => {
    const name = new URL(url, base).pathname.split("/").pop();
    return { url, name, size: KNOWN[name] || 0 };
  };
  const [, wasmBytes, modelBytes] = await downloadAll([file(fileset.wasmLoaderPath), file(fileset.wasmBinaryPath), file(modelUrl)], {
    onProgress: (p) => onProgress({ phase: "download", ...p }),
  });
  onProgress({ phase: "init" });
  // the wasm we just counted, handed over as is: MediaPipe would otherwise download it a second time
  const wasmUrl = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));
  const files = { ...fileset, wasmBinaryPath: wasmUrl };
  const options = (d) => ({
    baseOptions: { modelAssetBuffer: modelBytes, delegate: d },
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
    landmarker = await PoseLandmarker.createFromOptions(files, options(delegate));
  } catch (err) {
    if (delegate !== "GPU") throw err;
    used = "CPU";
    landmarker = await PoseLandmarker.createFromOptions(files, options("CPU"));
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
