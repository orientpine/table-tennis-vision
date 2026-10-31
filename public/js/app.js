import { refineCornersMulti } from "./calib-refine.js";
import { createPose } from "./pose.js";
import { DownloadError } from "./download.js";
import { Pipeline } from "./pipeline.js";
import { RallyRecorder } from "./recorder.js";
import { createUI } from "./ui.js";
import { LOW_LIGHT, StarveWatch, frameLuma, frameSig } from "./guards.js";
import { judgePoint, suspects } from "./point.js";
import { SIDE_NAMES, TournamentLink, sideLabel } from "./tournament.js";
import { unlock } from "./voice.js";
import { Venue } from "./venue.js";

// Back from the mode choice lands here on the old camera entry; the camera stays closed and it goes
// straight on to the choice (and out of the app on the next back). Choosing camera clears the mark.
if (sessionStorage.getItem("pp-left-camera")) location.replace("/?role");
function leaveToPicker() {
  sessionStorage.setItem("pp-left-camera", "1");
  location.replace("/?role");
}

// The app's own folder (/vision/). The address bar shows only the one tournament address, so
// every request of this app is made against this folder, never against the page address.
const BASE = new URL("../", import.meta.url);

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
  endOnCubic: store.get("endOnCubic", false),
  // 판정 안정 모드: "auto" may make the picture small when the analysis starves, "off" never does (owner, 2026-10-31)
  stableMode: store.get("stableMode", "auto") === "off" ? "off" : "auto",
  analysisFrom: ["screen", "probe", "probe-big"].includes(store.get("analysisFrom", "screen")) ? store.get("analysisFrom", "screen") : "screen",
  replayOverlay: store.get("replayOverlay", true) !== false,
  ballColor: store.get("ballColor", "white") === "orange" ? "orange" : "white",
  source: null,
  loadingText: null,
  loading: null,
  error: null,
  perf: { fps: 0, ms: 0, poseMs: 0, ballMs: 0 },
  video: { width: 0, height: 0 },
  calibration: null,
  rally: { active: false, timeMs: 0, shots: 0, speedKmh: null, maxSpeedKmh: null },
  ball: { trail: [], current: null },
  bounces: [],
  lastShot: null,
  players: {
    near: { label: "블루 사이드", end: 0, hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
    far: { label: "레드 사이드", end: 1, hand: "R", landmarks: null, moveM: null, wristDeg: null, wristKmh: null, shotKmh: null },
  },
  tracking: "no-calibration",
  calibrationIssue: null,
  // check: what the server said about the stored key: null (not asked yet), "ok", "rejected", "unknown" (no answer)
  save: { keySet: !!store.get("uploadKey", null), check: null, supported: null, keyError: null },
  history: store.get("history", []),
  // 판정 안정 모드: compact = the portrait picture is the production-size middle row instead of full screen;
  // locked = it came back to full screen once and got bad again, so it stays compact for this camera run
  stable: { compact: false, locked: false, log: store.get("stableLog", []) },
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
}, {
  say: (text) => venue.say(text),
  onPin: () => saveByPin(),
  // the players changed ends (the rules, or a fix on any screen): their settings go with them
  onEnds: (m) => {
    swapPlayerSettings();
    ui.notice(`엔드 교체 · ${SIDE_NAMES[0]} ${m.names[m.ends[0]]} · ${SIDE_NAMES[1]} ${m.names[m.ends[1]]}`);
  },
});
const venue = new Venue(store, tour, () => state.mode);
state.tour = tour.view();

const ui = createUI(document.getElementById("app"), {
  onStartCamera: () => {
    unlock();
    startCamera();
  },
  onOpenFile: (file) => startFile(file),
  onStop: () => stop(),
  onLeave: () => leave(),
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
  onSnapCorners: (corners, done) => {
    snapCorners(corners).then(done, (err) => {
      console.warn("ppv: corner snap failed", err);
      done(null);
    });
    return true;
  },
  onCalibrationCancel: () => {
    state.mode = state.prevMode || "running";
    holdFileForCalibration(false);
    render();
  },
  // 자리 교체: the two players trade ends; the red / blue ends stay where they are. Linked, the
  // tournament keeps it for every screen (onEnds above follows); alone, only this camera.
  onSwapPlayers: () => {
    tour.swapEnds().then((written) => {
      if (written) return;
      swapPlayerSettings();
      ui.notice("자리 교체: 레드·블루 사이드는 그대로, 선수만 바꿨어요");
      render();
    });
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
  onRetrySave: () => saveByPin(),
  onTourConnect: (pin) => {
    unlock();
    tour.connect(pin).then(() => venue.start());
  },
  onTourVoice: (on) => {
    unlock();
    tour.setVoice(on);
  },
  onTourLet: () => tour.confirmLet(),
  onTourFault: () => tour.confirmFault(),
  onTourDisconnect: () => tour.disconnect(),
  onTourRefresh: () => tour.refresh(),
  onTourMatch: (id) => tour.setMatch(id),
  onTourNear: (side) => tour.setNear(side),
  onTourMode: (mode) => tour.setMode(mode),
  onTourCancel: () => tour.cancel(),
  onTourPick: (side) => tour.pick(side),
  onTourFix: (kind, arg, seen) => tour.fix(kind, arg, seen),
  onDeleteRally: (id) => deleteRally(id),
  onSetEndOnCubic: (on) => {
    state.endOnCubic = on;
    store.set("endOnCubic", on);
    if (pipeline) pipeline.setEndOnCubic(on);
    render();
  },
  onSetAnalysisFrom: (from) => {
    state.analysisFrom = ANALYSIS_FROM.includes(from) ? from : "screen";
    store.set("analysisFrom", state.analysisFrom);
    analysisPref = state.analysisFrom;
    probe.style.cssText = PROBE_CSS[analysisPref] || PROBE_CSS.probe;
    // the hidden copy is attached only at camera start, so a running camera restarts to apply it
    if (state.source === "camera" && running) startCamera();
    render();
  },
  onSetStableMode: (mode) => {
    state.stableMode = mode === "off" ? "off" : "auto";
    store.set("stableMode", state.stableMode);
    if (state.stableMode === "off" && state.stable.compact) backToFull("dismiss");
    render();
  },
  // the "판정 안정 모드 · 영상 작게" chip: full screen now, and not again for this camera run
  onDismissStable: () => {
    if (state.stable.compact) backToFull("dismiss");
    render();
  },
  onSetReplayOverlay: (on) => {
    state.replayOverlay = !!on;
    store.set("replayOverlay", state.replayOverlay);
    if (recorder) recorder.overlay = state.replayOverlay;
    render();
  },
  onSetBallColor: (color) => {
    state.ballColor = color === "orange" ? "orange" : "white";
    store.set("ballColor", state.ballColor);
    if (pipeline) pipeline.setBallColor(state.ballColor);
    render();
  },
  onSetLayout: (layout) => {
    state.layoutPref = layout;
    store.set("layout", layout);
    updateLayout();
    render();
  },
});
const video = ui.video;
// The analysis reads the camera from its own tiny video of the same stream, not from the full-screen
// stage video: on a software-composited WebKit the large stage video presented a new camera frame for
// only about one analysis read in four (72-91% repeats vs main's 0), and ball locks collapsed.
const probe = document.createElement("video");
probe.muted = true; probe.playsInline = true; probe.autoplay = true;
probe.setAttribute("aria-hidden", "true");
const PROBE_CSS = {
  probe: "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none",
  "probe-big": "position:fixed;left:0;bottom:0;width:320px;height:180px;opacity:0.01;pointer-events:none;z-index:2147483647",
};
probe.style.cssText = PROBE_CSS.probe;
document.body.append(probe);
// which video the analysis reads (preview setting for the phone check): "screen" (default, the stage
// video as before), "probe" (a hidden 2x2 copy of the stream) or "probe-big" (a hidden 320x180 copy)
const ANALYSIS_FROM = ["screen", "probe", "probe-big"];
let analysisPref = "screen";  // read from the store when the camera starts, not every frame
const analysisFrom = () => analysisPref;
let probeFresh = false;   // a new frame was presented since the last analysis read
let probeSeenAt = 0;      // when the analysis video last showed a new frame (performance.now)
let probeLastT = -1;
let probeGen = 0;
let probeStream = null;   // the hidden video's own clone of the camera stream ("따로" settings only)
function watchProbe() {
  probeSeenAt = performance.now();
  if (!probe.requestVideoFrameCallback) return;
  const gen = ++probeGen;
  const tick = () => {
    if (gen !== probeGen || !probe.srcObject) return;
    probeFresh = true;
    probeSeenAt = performance.now();
    probe.requestVideoFrameCallback(tick);
  };
  probe.requestVideoFrameCallback(tick);
}
// An almost invisible video may be paused or slowed by the browser (iOS power saving). If it shows no
// new frame for over a second, read the stage video instead until it moves again.
function analysisSource() {
  if (state.source !== "camera" || analysisFrom() === "screen" || !probe.srcObject || probe.readyState < 2) return video;
  const now = performance.now();
  if (!probe.requestVideoFrameCallback && probe.currentTime !== probeLastT) { probeLastT = probe.currentTime; probeSeenAt = now; }
  return now - probeSeenAt > 1000 ? video : probe;
}
function attachProbe() {
  if (!stream || probeStream) return;
  probe.style.cssText = PROBE_CSS[analysisFrom()] || PROBE_CSS.probe;
  probeStream = stream.clone();
  probe.srcObject = probeStream;
  probe.play().catch((err) => console.warn("ppv: analysis video", err));
  watchProbe();
}
function detachProbe() {
  probe.srcObject = null;
  if (probeStream) {
    for (const track of probeStream.getTracks()) track.stop();
    probeStream = null;
  }
}

// ---------- guards that keep automatic scoring from failing quietly (guards.js) ----------
const starve = new StarveWatch();
let guardFrames = 0;
let darkSince = null;
let darkShown = false;
function resetGuards() {
  starve.reset();
  guardFrames = 0;
  darkSince = null;
  darkShown = false;
  state.stable = { ...state.stable, compact: false, locked: false };
}
// processed: an analysis read happened on this frame tick
function guardTick(processed) {
  if (state.source !== "camera" || state.mode !== "running") return;
  const rgba = processed ? pipeline.lastRgba : null;
  const now = performance.now();
  const change = state.stableMode === "off" ? null : starve.tick(now, !!rgba, rgba ? frameSig(rgba) : 0);
  if (change) applyStable(change);
  if (!rgba || darkShown || ++guardFrames % 10) return;
  if (frameLuma(rgba) < LOW_LIGHT.luma) {
    darkSince = darkSince ?? now;
    if (now - darkSince >= LOW_LIGHT.holdMs) {
      darkShown = true;
      ui.notice("조명이 어두워요, 공이 잘 안 보일 수 있어요");
    }
  } else darkSince = null;
}
// a camera that stops presenting frames also stops the frame callback, so the window has to close on
// a clock too: no frame at all in 5 s is the worst starvation, not a pause in the count
setInterval(() => guardTick(false), 1000);
// 판정 안정 모드 (lead, 2026-10-31): when the analysis starves, the portrait picture leaves the full-screen
// overlay for the production-size middle row; after 30 s of good windows it goes back, and if it gets
// bad again it stays small for the rest of this camera run. The 판정용 영상 setting is never touched.
const STABLE_WHAT = { compact: "영상 작게", full: "전체 화면으로 돌아감", stay: "영상 작게(이번 촬영 동안 유지)", dismiss: "직접 전체 화면(이번 촬영 동안 안 켬)" };
function backToFull(action) {
  starve.dismiss();
  const last = starve.last || { fps: 0, repeat: 0 };
  applyStable({ action, fps: last.fps, repeat: last.repeat, base: starve.base });
}
function applyStable({ action, fps, repeat, base, badWindows = null }) {
  const entry = { at: Date.now(), action, fps: Math.round(fps), basePct: base ? Math.round((fps / base) * 100) : null, repeatPct: Math.round(repeat * 100), what: STABLE_WHAT[action] };
  const log = [...(state.stable.log || []), entry].slice(-20);
  state.stable = { compact: action === "compact" || action === "stay", locked: action === "stay", log };
  store.set("stableLog", log);
  console.warn("ppv: 판정 안정 모드", entry);
  // one numbers-only line in the vision server's journal, so we can see why a real phone switched
  fetch(new URL("api/stable-log", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, fps: entry.fps, repeatPct: entry.repeatPct, basePct: entry.basePct, badWindows, at: entry.at }), keepalive: true }).catch(() => {});
  // a frozen camera runs no frame loop, so redraw here or the chip and the smaller picture never show
  render();
}

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
  labelPlayers();
  ui.render(state);
}

// Each end by its colour and, linked to a match, the player standing there ("레드 · 김블루").
function labelPlayers() {
  const v = tour.view();
  for (const side of ["near", "far"]) {
    const p = state.players[side];
    const label = sideLabel(v, side);
    const end = tour.colourOf(side);
    if (p.label !== label || p.end !== end) state.players[side] = { ...p, label, end };
  }
}

function swapPlayerSettings() {
  if (pipeline) pipeline.players.swap();
  const hands = store.get("hands", {});
  store.set("hands", { near: hands.far, far: hands.near });
  const { near, far } = state.players;
  state.players = { near: { ...near, hand: far.hand, moveM: far.moveM }, far: { ...far, hand: near.hand, moveM: near.moveM } };
  syncPlayers();
}

function fail(title, detail, steps = [], retry = null) {
  running = false;
  state.mode = "error";
  state.loading = null;
  state.error = { title, detail, steps, retry };
  render();
}

async function ensurePipeline() {
  if (!pose) {
    state.mode = "loading";
    state.loadingText = "자세 인식 모델을 받는 중 (처음 한 번)";
    state.loading = { phase: "download", received: 0, total: 0 };
    render();
    pose = await createPose({
      model: "lite",
      numPoses: 2,
      onProgress: (p) => {
        state.loading = p;
        if (p.phase === "init") state.loadingText = "자세 인식 모델 준비 중";
        render();
      },
    });
    state.loading = null;
  }
  if (!pipeline) {
    pipeline = new Pipeline({ pose, onEvent, endOnCubic: state.endOnCubic, ballColor: state.ballColor });
    const hands = store.get("hands", {});
    for (const side of ["near", "far"]) if (hands[side]) pipeline.players[side].hand = hands[side];
  }
}

// Three full-size frames 150 ms apart (one, repeated, for a paused file): a player leaning over
// the table in one frame does not break the snap (refineCornersMulti takes per-corner medians).
async function snapCorners(corners) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((res) => setTimeout(res, 150));
    ctx.drawImage(video, 0, 0, w, h);
    frames.push({ rgba: ctx.getImageData(0, 0, w, h).data, w, h });
  }
  return refineCornersMulti(frames, corners);
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
  if (err instanceof DownloadError) {
    stopSources();
    return fail("자세 인식 모델을 받지 못했어요", err.kind === "stalled" ? `받는 중에 멈췄어요. ${err.message}.` : `${err.message}.`, [
      "와이파이나 데이터가 켜져 있는지 확인하세요.",
      "다시 받기를 누르면 처음부터 다시 받아요.",
    ], "다시 받기");
  }
  const name = err && err.name;
  if (!window.isSecureContext) {
    return fail("보안 주소(https)가 아니에요", "카메라는 https 주소에서만 켜져요.", ["안내받은 https:// 주소로 다시 열어 주세요."]);
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return fail("카메라 권한이 꺼져 있어요", "브라우저가 이 사이트의 카메라 사용을 막았어요.", [
      "브라우저의 사이트 설정에서 카메라 권한을 허용하세요.",
      "권한을 바꾼 뒤 다시 시도 버튼을 누르세요.",
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
  analysisPref = state.analysisFrom;
  probe.style.cssText = PROBE_CSS[analysisPref] || PROBE_CSS.probe;
  // "화면" (default): one video only, exactly as production. iPhone Safari showed a black stage when
  // the same camera stream also played in the hidden video (owner, 2026-10-31 05:56 KST), so a "따로"
  // setting gives the hidden video its own clone of the stream instead of sharing the track.
  resetGuards();
  if (analysisPref !== "screen") attachProbe();
  watchTrack(stream);
  await begin();
}

// The camera can drop out at a venue (iOS pauses it when another app takes over, a call comes
// in, the phone overheats). While the session runs, start it again by itself; begin() keeps
// the saved calibration, so play resumes without new taps.
function watchTrack(s) {
  for (const track of s.getVideoTracks()) {
    track.addEventListener("ended", () => {
      if (stream === s && running && state.source === "camera") setTimeout(() => startCamera(), 500);
    });
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !running || state.source !== "camera") return;
  const live = stream && stream.getVideoTracks().some((tr) => tr.readyState === "live");
  if (!live) startCamera();
});

// The tournament app can change the match list or drop the connection; refresh it every 30 s
// while linked so the next point goes to the right place.
setInterval(() => {
  if (state.tour.connected && !state.tour.pending && document.visibilityState === "visible") tour.refresh();
}, 30000);

// iPhone Safari tells a web page neither battery level nor temperature, so a phone that is
// heating up shows only as falling frame rate: warn when fps stays under half of what this
// session ran at in its first 20 s, for 30 s.
const slow = { base: [], since: null };
function watchSlow(fps, now) {
  if (!running || !fps) return;
  if (slow.base.length < 20) {
    slow.base.push(fps);
    return;
  }
  const base = [...slow.base].sort((x, y) => x - y)[10];
  if (fps < base / 2) slow.since = slow.since ?? now;
  else slow.since = null;
  state.slowPhone = slow.since != null && now - slow.since > 30000;
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
  // Reopening a file that already played to its end: WebKit can keep the old end position on
  // the element until the new source has loaded, so the new file played from 12 s, ended at once
  // and the app stopped (ui-r2 end-of-file-stop, about one run in three). Load the new source,
  // then start it from 0 and wait for that seek before playing.
  await new Promise((res) => {
    if (video.readyState >= 1) return res();
    const done = () => { video.removeEventListener("loadedmetadata", done); video.removeEventListener("error", done); res(); };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
    setTimeout(done, 10000);
  });
  if (video.currentTime !== 0 && !video.error) {
    await new Promise((res) => {
      const done = () => { video.removeEventListener("seeked", done); res(); };
      video.addEventListener("seeked", done);
      setTimeout(done, 3000);
      video.currentTime = 0;
    });
  }
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
  recorder = recorder || new RallyRecorder({ overlay: state.replayOverlay });
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
// The camera can change its frame size after it starts: an iPhone held upright reports the sensor's
// landscape 1280x720 first and turns it to 720x1280 a moment later (owner's iPhone, 2026-10-31 06:10 KST). The
// size taken at start fed the tap mapping (taps squeezed into a landscape band), the analysis canvas
// and the clip recorder, so all of them follow the new size here.
video.addEventListener("resize", () => {
  if (!running || !video.videoWidth || !video.videoHeight) return;
  const w = video.videoWidth, h = video.videoHeight;
  const old = state.video;
  if (w === old.width && h === old.height) return;
  const turned = !old.width || Math.abs(w / h - old.width / old.height) > 0.01;
  const corners = state.calibration && state.calibration.corners;
  state.video = { width: w, height: h };
  pipeline.setVideoSize(w, h);
  if (recorder) recorder.setSize(w, h);
  if (corners && !turned) {
    const k = w / old.width;
    applyCalibration(corners.map((c) => ({ x: c.x * k, y: c.y * k })), true);
  } else if (corners) {
    // corners taken on the other shape point at the wrong place: use a calibration saved for this
    // shape, else calibrate again
    applyCalibration(null, false);
    restoreCalibration();
    if (!state.calibration && state.mode === "running") {
      state.prevMode = "running";
      state.mode = "calibrating";
      ui.notice("화면 방향이 바뀌었어요. 다시 보정해 주세요");
    }
  }
  render();
});

function schedule() {
  if (!running) return;
  // camera read through the analysis video: tick with the display, not with the stage video's frames,
  // so a stage video that presents rarely cannot hold the analysis back (onFrame waits for probeFresh)
  const throughProbe = state.source === "camera" && analysisFrom() !== "screen";
  if (!throughProbe && video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
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
    const src = analysisSource();
    // with frame callbacks, read the analysis video only when it presented a new frame
    if (src !== probe || !probe.requestVideoFrameCallback || probeFresh) {
      probeFresh = false;
      pipeline.process(src, t);
      pipeline.poseEvery = Math.min(8, Math.max(1, Math.round(pipeline.perf.poseMs / 15)));
      snapshot(t);
      fpsCount++;
      guardTick(true);
    } else guardTick(false);
    if (recorder && recorder.recording) recorder.frame(video, state);
    state.save.recording = !!(recorder && recorder.recording);
  }
  const wall = performance.now();
  if (wall - fpsT0 >= 1000) {
    state.perf.fps = Math.round((fpsCount * 1000) / (wall - fpsT0));
    watchSlow(state.perf.fps, wall);
    fpsCount = 0;
    fpsT0 = wall;
  }
  render();
  // after render: the clip copies the screen's overlay and panels as just drawn
  if (state.mode === "running" && recorder && recorder.recording) {
    recorder.frame(video, state);
    state.perf.rec = recorder.stats;
  }
  schedule();
}

function syncPlayers() {
  if (!pipeline) return;
  state.players = pipeline.players.state();
  labelPlayers();
}

function snapshot(t) {
  const snap = pipeline.snapshot(t);
  state.ball = snap.ball;
  state.tracking = snap.tracking;
  state.calibrationIssue = snap.calibrationIssue;
  state.colorHint = snap.colorHint || null;
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
  const scored = linked ? tour.score(judged, suspects({ shots: e.shotList, bounces: e.bounces, serveNet: e.serveNet, serveSeen: e.serveSeen })) : Promise.resolve(null);
  if (!linked && judged && judged.sure) tour.say(`${SIDE_NAMES[tour.colourOf(judged.winner)]} 득점`);
  const keep = (e.shots >= 2 && e.bounces.length >= 1) || linked;
  const clip = recorder ? recorder.stop() : Promise.resolve(null);
  track(scored);
  if (!keep) return;
  const players = Object.fromEntries(["near", "far"].map((s) => [s, { label: state.players[s].label, moveM: state.players[s].moveM, wristDeg: state.players[s].wristDeg }]));
  const entry = { id: Date.now(), startedAt: Date.now() - e.durationS * 1000, durationMs: Math.round(e.durationS * 1000), shots: e.shots, maxSpeedKmh: e.maxSpeedKmh, bounces: e.bounces, players };
  state.history = [entry, ...state.history].slice(0, 100);
  store.set("history", state.history);
  if (judged) entry.point = { winner: judged.winner, reason: judged.label };
  track(clip.then((blob) => blob && uploadRally(entry, blob, scored)));
}

// ---------- leaving the camera: the top-left back, or the browser's back ----------
// Work that must finish before the page goes: rally uploads and score writes.
const pending = new Set();
function track(p) {
  pending.add(p);
  p.catch(() => {}).finally(() => pending.delete(p));
  return p;
}

// One extra history entry, added on the first tap (browsers skip entries added without one), so
// the browser's back lands here first and leaves the same way as the button.
function guard() {
  if (!(history.state && history.state.ppvGuard)) history.pushState({ ppvGuard: 1 }, "");
}
window.addEventListener("pointerdown", guard, true);
window.addEventListener("popstate", (e) => {
  if (e.state && e.state.ppvGuard) return;
  ui.back();
  if (!leaving) guard();
});

let leaving = false;
async function leave() {
  if (leaving) return;
  if (state.mode === "running" && !(await ui.confirmLeave())) return;
  leaving = true;
  state.leaving = true;
  stop();
  if (pending.size) {
    state.mode = "loading";
    state.loadingText = "나가는 중… 랠리 영상과 점수를 마저 보내요";
    render();
  }
  await Promise.race([Promise.allSettled([...pending, tour.queue]), new Promise((r) => setTimeout(r, 8000))]);
  leaveToPicker();
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
    const res = await fetch(new URL("api/rallies", BASE), { method: "POST", headers: { "x-ppv-key": key }, body: form });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.save = { ...state.save, check: "rejected" };
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const share = new URL(body.share, BASE);
    setUpload(entry, { status: "done", id: body.id, url: share.href, bytes: blob.size });
    scored.then((point) => point && tour.attachClip(point, share.pathname));
  } catch (err) {
    console.warn("ppv: upload failed", err);
    setUpload(entry, { status: "failed", error: String(err.message || err) });
  }
}

// A key on the phone is not enough: the on-screen PC save state says on only when the server
// takes this key. The key itself stays out of the state and off the screen.
async function checkSaveKey() {
  const key = store.get("uploadKey", null);
  if (!key) return null;
  let check = "unknown";
  try {
    const res = await fetch(new URL("api/key-check", BASE), { headers: { "x-ppv-key": key } });
    if (res.status === 204) check = "ok";
    else if (res.status === 401) check = "rejected";
  } catch (err) {
    console.warn("ppv: key check", err);
  }
  if (store.get("uploadKey", null) !== key) return null;
  state.save = { ...state.save, check };
  render();
  return check;
}

async function setUploadKey(key) {
  const k = String(key || "").trim();
  if (!k) {
    store.set("uploadKey", null);
    state.save = { ...state.save, keySet: false, check: null, keyError: null };
    return render();
  }
  try {
    const res = await fetch(new URL("api/key-check", BASE), { headers: { "x-ppv-key": k } });
    if (res.status !== 204) throw new Error("열쇠가 맞지 않아요");
    store.set("uploadKey", k);
    state.save = { ...state.save, keySet: true, check: "ok", keyError: null };
    if (recorder && pipeline && pipeline.rally && pipeline.rally.rally && !recorder.recording) recorder.start();
  } catch (err) {
    state.save = { ...state.save, keyError: String(err.message || err) };
  }
  render();
}

// A tournament PIN that passed on this device also turns PC save on: the server checks it the same
// way and gives this browser its own token, kept where a key would be. A key that still works stays.
let pinSaving = null;
const saveByPin = () => (pinSaving ||= saveByPinOnce().finally(() => (pinSaving = null)));
async function saveByPinOnce() {
  if (!tour.pin) return;
  if (store.get("uploadKey", null) && (await checkSaveKey()) !== "rejected") return;
  try {
    const res = await fetch(new URL("api/pin-save", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: tour.pin }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      store.set("uploadKey", body.token);
      state.save = { ...state.save, keySet: true, check: "ok", keyError: null, notice: "점수 기록과 PC 저장이 켜졌어요." };
      if (recorder && pipeline && pipeline.rally && pipeline.rally.rally && !recorder.recording) recorder.start();
    } else if (body.code === "pin") {
      // A stale copy is tried once, not on every open, so it cannot lock the venue out.
      tour.dropPin();
      state.tour = tour.view();
      state.save = { ...state.save, notice: "대회 PIN이 바뀌었어요. 새 PIN을 넣으면 다시 켜져요." };
    } else {
      state.save = { ...state.save, keyError: body.error || "PC 저장을 켜지 못했어요" };
    }
  } catch (err) {
    console.warn("ppv: pin save", err);
    state.save = { ...state.save, keyError: "PC 저장 권한을 받지 못했어요. 연결을 확인하고 다시 시도해 주세요." };
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
  detachProbe();
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
  navigator.serviceWorker.register(new URL("sw.js", BASE), { scope: BASE.pathname, updateViaCache: "none" }).catch((err) => console.warn("ppv: service worker", err));
}

// One-time setup link (#setup=<token>): drop it from the address bar first, then trade it once
// for the upload key. The fragment is never sent to the server with the page request.
// A link opened in a tab that already shows the app only changes the fragment (no reload), so
// this also runs on hashchange and on a page restored from the back-forward cache.
async function redeemSetupLink() {
  if (!location.hash.startsWith("#setup")) return;
  const m = /^#setup=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  history.replaceState(null, "", "/" + location.search);
  if (!m) {
    const msg = "설정 링크 모양이 달라요. 받은 링크를 통째로 다시 열어 주세요";
    state.save = { ...state.save, keyError: msg, notice: msg };
    render();
    return;
  }
  try {
    const res = await fetch(new URL("api/setup", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m[1] }) });
    if (!res.ok) throw new Error("설정 링크가 이미 쓰였거나 시간이 지났어요");
    const { key } = await res.json();
    store.set("uploadKey", key);
    state.save = { ...state.save, keySet: true, check: "ok", keyError: null, notice: "PC 저장이 켜졌어요. 랠리가 끝나면 그 구간 영상이 PC로 올라가요." };
  } catch (err) {
    // The DM link tapped a second time on a phone that is already on is not a failure.
    if ((await checkSaveKey()) === "ok") state.save = { ...state.save, keyError: null, notice: "PC 저장은 이미 켜져 있어요. 링크를 또 열지 않아도 돼요." };
    else state.save = { ...state.save, keyError: String(err.message || err), notice: String(err.message || err) };
  }
  render();
}
redeemSetupLink().then(checkSaveKey).then(saveByPin);
window.addEventListener("online", () => checkSaveKey().then(saveByPin));
// One app, one address: this screen is the camera role of the tournament app at "/". An old
// camera link lands here too; it keeps the role, and the address bar shows only the one address.
try {
  localStorage.setItem("pp-role", "camera");
} catch {}
if (location.pathname !== "/") history.replaceState(history.state, "", "/" + location.search + location.hash);
if (state.tour.connected) tour.refresh();
venue.start().catch((err) => console.warn("ppv: venue link", err));
window.addEventListener("hashchange", redeemSetupLink);
window.addEventListener("pageshow", (e) => e.persisted && redeemSetupLink());

window.__ppv = { state, venue, get pipeline() { return pipeline; }, get recorder() { return recorder; } };
render();
