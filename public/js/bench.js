import { FilesetResolver, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";

const base = new URL("../", import.meta.url);
const url = (path) => new URL(path, base).href;
const N = 40;
const WARMUPS = 5;
const crops = [[0, 280, 300, 660], [1450, 250, 270, 630]]
  .map((box) => box.map((v) => v * 2 / 3));
const edges = [[5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
const progress = document.querySelector("#progress");
const run = document.querySelector("#run");
const copy = document.querySelector("#copy");
const tbody = document.querySelector("#results");
const previews = document.querySelector("#previews");
document.querySelector("#ua").textContent = navigator.userAgent;
let report;
let ort;
const paint = () => new Promise((resolve) => requestAnimationFrame(resolve));
const errorText = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function preview(image, label, poses, boxes = false) {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, 640, 360);
  ctx.scale(0.5, 0.5);
  poses.forEach((pose, i) => {
    ctx.strokeStyle = ctx.fillStyle = i === 0 ? "#ffab32" : "#20e7ff";
    ctx.lineWidth = 3;
    if (boxes) ctx.strokeRect(...crops[i]);
    for (const [a, b] of edges) {
      if (!pose[a] || !pose[b]) continue;
      ctx.beginPath(); ctx.moveTo(pose[a].x, pose[a].y); ctx.lineTo(pose[b].x, pose[b].y); ctx.stroke();
    }
    for (const p of pose) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    }
  });
  figure.append(caption, canvas);
  previews.append(figure);
}

function preprocess(image, crop) {
  const canvas = document.createElement("canvas");
  canvas.width = 192; canvas.height = 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, ...crop, 0, 0, 192, 256);
  const rgba = ctx.getImageData(0, 0, 192, 256).data;
  const pixels = 192 * 256;
  const values = new Float32Array(pixels * 3);
  const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < pixels; i++) values[c * pixels + i] = (rgba[i * 4 + c] - mean[c]) / std[c];
  }
  return new ort.Tensor("float32", values, [1, 3, 256, 192]);
}

function decode(outputs, crop) {
  const tensors = Object.values(outputs);
  const x = tensors.find((t) => t.dims.at(-1) === 384);
  const y = tensors.find((t) => t.dims.at(-1) === 512);
  if (!x || !y) throw new Error(`Unexpected SimCC output shapes: ${tensors.map((t) => t.dims.join("x"))}`);
  const argmax = (data, start, length) => {
    let best = 0;
    for (let j = 1; j < length; j++) if (data[start + j] > data[start + best]) best = j;
    return best;
  };
  return Array.from({ length: x.dims[1] }, (_, k) => ({
    x: crop[0] + argmax(x.data, k * 384, 384) / 2 / 192 * crop[2],
    y: crop[1] + argmax(y.data, k * 512, 512) / 2 / 256 * crop[3],
  }));
}

async function mediaPipe(image, model, row) {
  const fileset = await FilesetResolver.forVisionTasks(url("vendor/mediapipe/wasm"));
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: url(`models/pose_landmarker_${model}.task`), delegate },
    runningMode: "IMAGE", numPoses: 2,
    minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4,
  });
  let detector;
  try {
    detector = await PoseLandmarker.createFromOptions(fileset, options("GPU"));
    row.backend = "GPU";
  } catch (error) {
    row.fallbackReason = errorText(error);
    detector = await PoseLandmarker.createFromOptions(fileset, options("CPU"));
    row.backend = "CPU";
  }
  return {
    infer: () => detector.detect(image).landmarks.map((pose) => {
      // Convert MediaPipe's 33-point skeleton to the COCO order used by the overlay.
      const order = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
      return order.map((i) => ({ x: pose[i].x * image.width, y: pose[i].y * image.height }));
    }),
    close: () => detector.close(),
  };
}

async function rtmPose(image, model, provider, row) {
  ort ??= await import("../vendor/ort/ort.all.min.mjs");
  ort.env.wasm.wasmPaths = url("vendor/ort/");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  if (provider === "webgpu" && !navigator.gpu) throw new Error("WebGPU unavailable: navigator.gpu is absent");
  const session = await ort.InferenceSession.create(url(`models/rtmpose-${model}.onnx`), {
    executionProviders: [provider],
  });
  row.backend = provider;
  return {
    async infer() {
      const poses = [];
      for (const crop of crops) {
        const input = preprocess(image, crop);
        let outputs;
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          poses.push(decode(outputs, crop));
        } finally {
          input.dispose();
          if (outputs) Object.values(outputs).forEach((tensor) => tensor.dispose());
        }
      }
      return poses;
    },
    close: () => session.release(),
  };
}

function render(row, tr) {
  tr.replaceChildren();
  const cells = [row.model, row.backend ?? "—", row.meanMs?.toFixed(2) ?? "—",
    row.p90Ms?.toFixed(2) ?? "—", row.fps?.toFixed(2) ?? "—", row.error ?? row.status];
  for (const text of cells) {
    const td = document.createElement("td"); td.textContent = text; tr.append(td);
  }
  tr.className = row.error ? "error" : "";
}

run.addEventListener("click", async () => {
  run.disabled = true; copy.disabled = true;
  tbody.replaceChildren(); previews.replaceChildren();
  report = { version: 1, userAgent: navigator.userAgent, date: new Date().toISOString(),
    iterations: N, warmups: WARMUPS, image: { width: 1280, height: 720, path: "bench/frame.jpg" },
    crops, timing: "MediaPipe full-image IMAGE inference; RTMPose two sequential crops including preprocessing and decoding; excludes model loading and overlay drawing",
    ortVersion: null, results: [], complete: false };
  window.benchResult = report;
  try {
    const image = new Image(); image.src = url("bench/frame.jpg"); await image.decode();
    const candidates = [
      ...["lite", "full"].map((model) => ({ name: `MediaPipe ${model}`, setup: (row) => mediaPipe(image, model, row) })),
      ...["s", "t"].flatMap((model) => ["wasm", "webgl", "webgpu"].map((provider) => ({
        name: `RTMPose-${model} ×2 (${provider})`, boxes: true,
        setup: (row) => rtmPose(image, model, provider, row),
      }))),
    ];
    for (const candidate of candidates) {
      const row = { model: candidate.name, status: "Loading", samplesMs: [] };
      report.results.push(row);
      const tr = document.createElement("tr"); tbody.append(tr); render(row, tr);
      progress.textContent = `${candidate.name}: loading`; await paint();
      let engine;
      try {
        engine = await candidate.setup(row);
        let poses;
        for (let i = 0; i < WARMUPS + N; i++) {
          progress.textContent = `${candidate.name}: ${i < WARMUPS ? `warm-up ${i + 1}/${WARMUPS}` : `iteration ${i - WARMUPS + 1}/${N}`}`;
          await paint();
          const start = performance.now();
          poses = await engine.infer();
          const elapsed = performance.now() - start;
          if (i >= WARMUPS) row.samplesMs.push(elapsed);
        }
        const sorted = [...row.samplesMs].sort((a, b) => a - b);
        row.meanMs = sorted.reduce((a, b) => a + b, 0) / N;
        row.p90Ms = sorted[Math.ceil(N * 0.9) - 1];
        row.fps = 1000 / row.meanMs;
        row.poseCount = poses.length;
        row.keypoints = poses;
        row.status = `Done (${poses.length} poses)`;
        preview(image, candidate.name, poses, candidate.boxes);
      } catch (error) {
        row.status = "Failed"; row.error = errorText(error);
      } finally {
        if (engine) {
          try { await engine.close(); } catch (error) { row.cleanupError = errorText(error); }
        }
        render(row, tr);
      }
    }
    report.ortVersion = ort?.env.versions;
    report.complete = true;
    progress.textContent = `Complete: ${report.results.filter((r) => !r.error).length}/${report.results.length} candidates succeeded. Errors remain visible in the table.`;
  } catch (error) {
    report.error = errorText(error);
    report.complete = true;
    progress.textContent = `Benchmark failed: ${report.error}`;
  } finally {
    run.disabled = false; copy.disabled = false;
    window.dispatchEvent(new Event("bench-complete"));
  }
});

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    progress.textContent = "Result JSON copied.";
  } catch (error) {
    progress.textContent = `Clipboard failed: ${errorText(error)}`;
  }
});
