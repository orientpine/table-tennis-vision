import { createPose } from "./pose.js";
import { Pipeline } from "./pipeline.js";
import { RallyRecorder } from "./recorder.js";
import { createUI } from "./ui.js";
import { judgePoint } from "./point.js";
import { TournamentLink } from "./tournament.js";

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ppv.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ppv.${key}`, JSON.stringify(value));
    } catch (err) {
      console.warn("ppv: could not save", key, err);
    }
  },
};

const state = {
  mode: "intro",
  layout: "phone",
  layoutPref: store.get("layout", "auto"),
  source: null,
  loadingText: null,
  error: null,
  perf: { fps: 0, ms: 0, poseMs: 0, ballMs: 0 },
  video: { width: 0, height: 0 },
  calibration: null,
  rally: { active: false, timeMs: 0, shots: 0, speedKmh: null, maxSpeedKmh: null },
  ball: { trail: [], current: null },
  bounces: [],
  lastShot: null,
  players: {
    near: { label: "앞쪽(나)", hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
    far: { label: "건너편(상대)", hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
  },
  tracking: "no-calibration",
  calibrationIssue: null,
  save: { keySet: !!store.get("uploadKey", null), supported: null, keyError: null },
  history: store.get("history", []),
  showHistory: false,
  estimateNote: "속도·거리는 화면 기반 추정치",
};

let pose = null;
let pipeline = null;
let stream = null;
let fileUrl = null;
let running = false;
let frameHandle = null;
let wakeLock = null;
let lastShotAt = -Infinity;
let fpsCount = 0;
let fpsT0 = performance.now();
let lastRallyTimeMs = 0;
let recorder = null;
let lastRallyShots = 0;
const tour = new TournamentLink(store, () => {
  state.tour = tour.view();
  render();
});
state.tour = tour.view();

const ui = createUI(document.getElementById("app"), {
  onStartCamera: () => startCamera(),
  onOpenFile: (file) => startFile(file),
  onStop: () => stop(),
  onBeginCalibration: () => {
    if (!state.video.width) return;
    state.prevMode = state.mode;
    state.mode = "calibrating";
    holdFileForCalibration(true);
    render();
  },
  onCalibrationDone: (corners) => {
    applyCalibration(corners, true);
    state.mode = state.prevMode || "running";
    holdFileForCalibration(false);
    render();
  },
  onCalibrationCancel: () => {
    state.mode = state.prevMode || "running";
    holdFileForCalibration(false);
    render();
  },
  onSwapPlayers: () => {
    if (pipeline) pipeline.players.swap();
    syncPlayers();
    render();
  },
  onSetHand: (side, hand) => {
    const hands = store.get("hands", {});
    hands[side] = hand;
    store.set("hands", hands);
    if (pipeline) pipeline.players[side].hand = hand;
    state.players[side].hand = hand;
    render();
  },
  onOpenHistory: () => {
    state.showHistory = true;
    render();
  },
  onCloseHistory: () => {
    state.showHistory = false;
    render();
  },
  onClearHistory: () => {
    state.history = [];
    store.set("history", []);
    render();
  },
  onSetUploadKey: (key) => setUploadKey(key),
  onTourConnect: (pin) => tour.connect(pin),
  onTourDisconnect: () => tour.disconnect(),
  onTourRefresh: () => tour.refresh(),
  onTourMatch: (id) => tour.setMatch(id),
  onTourNear: (side) => tour.setNear(side),
  onTourMode: (mode) => tour.setMode(mode),
  onTourCancel: () => tour.cancel(),
  onTourPick: (side) => tour.pick(side),
  onDeleteRally: (id) => deleteRally(id),
  onSetLayout: (layout) => {
    state.layoutPref = layout;
    store.set("layout", layout);
    updateLayout();
    render();
  },
});
const video = ui.video;

function updateLayout() {
  const auto = innerWidth >= 1024 && innerWidth > innerHeight ? "tv" : "phone";
  state.layout = state.layoutPref === "auto" ? auto : state.layoutPref;
}
addEventListener("resize", () => {
  updateLayout();
  render();
});
updateLayout();

function render() {
  ui.render(state);
}

function fail(title, detail, steps = []) {
  running = false;
  state.mode = "error";
  state.error = { title, detail, steps };
  render();
}

async function ensurePipeline() {
  if (!pose) {
    state.mode = "loading";
    state.loadingText = "자세 인식 모델을 폰에 불러오는 중 (처음 한 번 약 6MB)";
    render();
    pose = await createPose({ model: "lite", numPoses: 2 });
  }
  if (!pipeline) {
    pipeline = new Pipeline({ pose, onEvent });
    const hands = store.get("hands", {});
    for (const side of ["near", "far"]) if (hands[side]) pipeline.players[side].hand = hands[side];
  }
}

function applyCalibration(corners, save) {
  const cal = pipeline.setCalibration(corners);
  state.calibration = cal ? { corners } : null;
  if (save && cal) store.set("calibration", { corners, width: state.video.width, height: state.video.height });
}

function restoreCalibration() {
  const saved = store.get("calibration", null);
  if (saved && saved.width === state.video.width && saved.height === state.video.height) applyCalibration(saved.corners, false);
  else if (saved && Math.abs(saved.width / saved.height - state.video.width / state.video.height) < 0.01) {
    const k = state.video.width / saved.width;
    applyCalibration(saved.corners.map((c) => ({ x: c.x * k, y: c.y * k })), true);
  }
}

function cameraError(err) {
  const name = err && err.name;
  if (!window.isSecureContext) {
    return fail("보안 주소(https)가 아니에요", "카메라는 https 주소에서만 켜져요.", ["안내받은 https:// 주소로 다시 열어 주세요."]);
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return fail("카메라 권한이 꺼져 있어요", "Safari가 이 사이트의 카메라 사용을 막았어요.", [
      "주소창 왼쪽 '가가' (또는 aA) 버튼 > 웹 사이트 설정 > 카메라 > 허용",
      "또는 설정 앱 > 앱 > Safari > 카메라 > 허용",
      "다시 시도 버튼을 누르세요.",
    ]);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return fail("카메라를 찾지 못했어요", "이 기기에서 쓸 수 있는 카메라가 없어요.", ["다른 앱이 카메라를 쓰고 있으면 닫고 다시 시도하세요."]);
  }
  if (name === "NotSupportedError" && state.source === "file") {
    return fail("이 영상을 재생하지 못했어요", "이 브라우저가 이 영상 파일을 열지 못했어요.", ["아이폰 카메라로 찍은 영상(MOV/MP4)을 고르세요.", "같은 영상으로 한 번 더 시도해 보세요."]);
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return fail("카메라를 열 수 없어요", "다른 앱이나 탭이 카메라를 쓰고 있을 수 있어요.", ["카메라 앱이나 영상 통화를 닫고 다시 시도하세요."]);
  }
  return fail("시작하지 못했어요", String((err && err.message) || err), ["페이지를 새로고침한 뒤 다시 시도하세요."]);
}

async function startCamera() {
  stopSources();
  state.error = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
  } catch (err) {
    return cameraError(err);
  }
  state.source = "camera";
  video.srcObject = stream;
  await begin();
}

async function startFile(file) {
  stopSources();
  state.error = null;
  fileUrl = URL.createObjectURL(file);
  state.source = "file";
  video.srcObject = null;
  video.autoplay = false;
  video.src = fileUrl;
  video.loop = false;
  await begin();
}

async function begin() {
  try {
    await ensurePipeline();
    // A seek on a freshly set file can finish after the calibration pause and make WebKit resume
    // on its own, so only seek when not already at the start.
    if (state.source === "file" && video.currentTime !== 0) video.currentTime = 0;
    try {
      await video.play();
    } catch (err) {
      if (state.source !== "file" || !video.error || video.error.code !== 4) throw err;
      console.warn("ppv: file source failed to load, reloading once", video.error.message);
      video.load();
      await video.play();
    }
    if (!video.videoWidth) await new Promise((res) => video.addEventListener("loadedmetadata", res, { once: true }));
  } catch (err) {
    console.warn("ppv: start failed", err && err.name, err && err.message, "media error", video.error && video.error.code, video.error && video.error.message, "readyState", video.readyState, "networkState", video.networkState);
    return cameraError(err);
  }
  state.video = { width: video.videoWidth, height: video.videoHeight };
  pipeline.setVideoSize(video.videoWidth, video.videoHeight);
  recorder = recorder || new RallyRecorder();
  recorder.setSize(video.videoWidth, video.videoHeight);
  state.save.supported = recorder.supported;
  restoreCalibration();
  pipeline.reset();
  state.bounces = [];
  state.lastShot = null;
  running = true;
  state.mode = state.calibration ? "running" : "calibrating";
  state.prevMode = "running";
  if (state.mode === "calibrating") holdFileForCalibration(true);
  requestWakeLock();
  render();
  schedule();
}

function holdFileForCalibration(on) {
  if (state.source !== "file" || !running) return;
  if (on) video.pause();
  else if (state.mode === "running") video.play().catch((err) => console.warn("ppv: resume after calibration", err));
}

video.addEventListener("playing", () => {
  if (state.source === "file" && state.mode === "calibrating") video.pause();
});
// requestVideoFrameCallback stops firing once a file ends, so onFrame never sees video.ended.
video.addEventListener("ended", () => {
  if (running && state.source === "file" && state.mode === "running") stop();
});

function schedule() {
  if (!running) return;
  if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
  else frameHandle = requestAnimationFrame(() => onFrame(performance.now(), null));
}

function onFrame(now, meta) {
  if (!running) return;
  if (video.ended) {
    stop();
    return;
  }
  const t = state.source === "file" ? (meta ? meta.mediaTime : video.currentTime) : now / 1000;
  if (state.mode === "running" && video.readyState >= 2) {
    pipeline.process(video, t);
    pipeline.poseEvery = Math.min(8, Math.max(1, Math.round(pipeline.perf.poseMs / 15)));
    snapshot(t);
    if (recorder && recorder.recording) recorder.frame(video, state);
    state.save.recording = !!(recorder && recorder.recording);
    fpsCount++;
  }
  const wall = performance.now();
  if (wall - fpsT0 >= 1000) {
    state.perf.fps = Math.round((fpsCount * 1000) / (wall - fpsT0));
    fpsCount = 0;
    fpsT0 = wall;
  }
  render();
  schedule();
}

function syncPlayers() {
  if (!pipeline) return;
  state.players = pipeline.players.state();
}

function snapshot(t) {
  const snap = pipeline.snapshot(t);
  state.ball = snap.ball;
  state.tracking = snap.tracking;
  state.calibrationIssue = snap.calibrationIssue;
  syncPlayers();
  state.perf = { ...state.perf, ms: snap.perf.ms, poseMs: snap.perf.poseMs, ballMs: snap.perf.ballMs };
  if (snap.rally) {
    state.rally = { active: true, timeMs: snap.rally.timeMs, shots: snap.rally.shots, speedKmh: snap.rally.speedKmh, maxSpeedKmh: snap.rally.maxSpeedKmh };
    state.bounces = snap.rally.bounces.map((b) => ({ tx: b.tx, ty: b.ty, side: b.side, t: b.t }));
    lastRallyTimeMs = snap.rally.timeMs;
    lastRallyShots = snap.rally.shots;
  } else {
    state.rally = { ...state.rally, active: false, timeMs: lastRallyTimeMs, shots: lastRallyShots };
  }
  const shot = snap.rally && snap.rally.lastShot;
  if (shot) lastShotAt = shot.t;
  state.lastShot = shot && t - lastShotAt < 1.5 ? { ...shot } : t - lastShotAt < 1.5 ? state.lastShot : null;
}

function onEvent(e) {
  if (e.type === "rallyStart") tour.dropChoice();
  if (e.type === "rallyStart" && store.get("uploadKey", null) && recorder) recorder.start();
  if (e.type !== "rallyEnd") return;
  // A rally cut short by 정지 is not a finished point; everything else is judged (point.js).
  const judged = e.why !== "stop" ? judgePoint({ shots: e.shotList, bounces: e.bounces }) : null;
  const linked = !!(state.tour.connected && state.tour.matchId && judged);
  const scored = linked ? tour.score(judged) : Promise.resolve(null);
  const keep = (e.shots >= 2 && e.bounces.length >= 1) || linked;
  const clip = recorder ? recorder.stop() : Promise.resolve(null);
  if (!keep) return;
  const players = Object.fromEntries(["near", "far"].map((s) => [s, { label: state.players[s].label, moveM: state.players[s].moveM, wristDeg: state.players[s].wristDeg }]));
  const entry = { id: Date.now(), startedAt: Date.now() - e.durationS * 1000, durationMs: Math.round(e.durationS * 1000), shots: e.shots, maxSpeedKmh: e.maxSpeedKmh, bounces: e.bounces, players };
  state.history = [entry, ...state.history].slice(0, 100);
  store.set("history", state.history);
  if (judged) entry.point = { winner: judged.winner, reason: judged.label };
  clip.then((blob) => {
    if (blob) uploadRally(entry, blob, scored);
  });
}

// ---------- rally saves on the owner's PC (docs/save-to-pc.md) ----------
function setUpload(entry, upload) {
  const h = state.history.find((r) => r.id === entry.id);
  if (!h) return;
  h.upload = upload;
  store.set("history", state.history);
  render();
}

async function uploadRally(entry, blob, scored = Promise.resolve(null)) {
  const key = store.get("uploadKey", null);
  if (!key) return;
  setUpload(entry, { status: "uploading" });
  const { upload, ...record } = entry;
  const form = new FormData();
  form.set("record", JSON.stringify(record));
  form.set("video", blob, blob.type.includes("mp4") ? "rally.mp4" : "rally.webm");
  try {
    const res = await fetch("./api/rallies", { method: "POST", headers: { "x-ppv-key": key }, body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const share = new URL(body.share, location.href);
    setUpload(entry, { status: "done", id: body.id, url: share.href, bytes: blob.size });
    scored.then((point) => point && tour.attachClip(point, share.pathname));
  } catch (err) {
    console.warn("ppv: upload failed", err);
    setUpload(entry, { status: "failed", error: String(err.message || err) });
  }
}

async function setUploadKey(key) {
  const k = String(key || "").trim();
  if (!k) {
    store.set("uploadKey", null);
    state.save = { ...state.save, keySet: false, keyError: null };
    return render();
  }
  try {
    const res = await fetch("./api/key-check", { headers: { "x-ppv-key": k } });
    if (res.status !== 204) throw new Error("열쇠가 맞지 않아요");
    store.set("uploadKey", k);
    state.save = { ...state.save, keySet: true, keyError: null };
    if (recorder && pipeline && pipeline.rally && pipeline.rally.rally && !recorder.recording) recorder.start();
  } catch (err) {
    state.save = { ...state.save, keyError: String(err.message || err) };
  }
  render();
}

async function deleteRally(id) {
  const entry = state.history.find((r) => r.id === id);
  if (!entry) return;
  if (entry.upload && entry.upload.id) {
    const res = await fetch(`./api/rallies/${entry.upload.id}`, { method: "DELETE", headers: { "x-ppv-key": store.get("uploadKey", "") } }).catch(() => null);
    if (!res || (res.status !== 204 && res.status !== 404)) {
      setUpload(entry, { ...entry.upload, error: "PC에서 지우지 못했어요" });
      return;
    }
  }
  state.history = state.history.filter((r) => r.id !== id);
  store.set("history", state.history);
  render();
}

function stopSources() {
  running = false;
  if (frameHandle != null) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (fileUrl) {
    URL.revokeObjectURL(fileUrl);
    fileUrl = null;
  }
}

function stop() {
  if (pipeline) pipeline.reset();
  stopSources();
  video.pause();
  if (wakeLock) wakeLock.release().catch((err) => console.warn("ppv: wake lock release", err));
  wakeLock = null;
  state.mode = "stopped";
  render();
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    console.warn("ppv: wake lock unavailable", err);
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch((err) => console.warn("ppv: service worker", err));
}

// One-time setup link (#setup=<token>): drop it from the address bar first, then trade it once
// for the upload key. The fragment is never sent to the server with the page request.
// A link opened in a tab that already shows the app only changes the fragment (no reload), so
// this also runs on hashchange and on a page restored from the back-forward cache.
async function redeemSetupLink() {
  if (!location.hash.startsWith("#setup")) return;
  const m = /^#setup=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  history.replaceState(null, "", location.pathname + location.search);
  if (!m) {
    const msg = "설정 링크 모양이 달라요. 받은 링크를 통째로 다시 열어 주세요";
    state.save = { ...state.save, keyError: msg, notice: msg };
    render();
    return;
  }
  try {
    const res = await fetch("./api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m[1] }) });
    if (!res.ok) throw new Error("설정 링크가 이미 쓰였거나 시간이 지났어요");
    const { key } = await res.json();
    store.set("uploadKey", key);
    state.save = { ...state.save, keySet: true, keyError: null, notice: "PC 저장이 켜졌어요. 랠리가 끝나면 그 구간 영상이 PC로 올라가요." };
  } catch (err) {
    state.save = { ...state.save, keyError: String(err.message || err), notice: String(err.message || err) };
  }
  render();
}
redeemSetupLink();
if (state.tour.connected) tour.refresh();
window.addEventListener("hashchange", redeemSetupLink);
window.addEventListener("pageshow", (e) => e.persisted && redeemSetupLink());

window.__ppv = { state, get pipeline() { return pipeline; } };
render();
