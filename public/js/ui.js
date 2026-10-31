// ui.js - createUI(root, handlers) for pingpong-vision (contract: docs/contract.md)
// Screens: intro / loading / error / HUD (ready, running, stopped) / calibrating,
// plus the history sheet and the settings popover. render(state) is called every
// frame: DOM text is diffed, the overlay canvas is redrawn through hud.js.
// Layout fit (data-fit on .app): "stack" on a portrait phone (the panels are grid rows floating
// over the full-screen picture; while calibrating the picture sits between them), "overlay" elsewhere.
import { fitBox } from "./geom.js";
import { drawHud, invalidateHudTheme } from "./hud.js";
import { SIDE_NAMES } from "./tournament.js";
import { SMALL_TABLE, quadFraction } from "./guards.js";

const TABLE_L = 2.74;        // m, tx axis (from MY end)
const TABLE_W = 1.525;       // m, ty axis
const MOVE_SCALE_M = 6;      // MOVE meters share one scale: 6 m, growing in 6 m steps with the leader
const SHOT_SCALE_KMH = 60;   // SHOT meter is full at 60 km/h
const WRIST_SCALE_DEG = 90;  // 손목 (wrist bend) meter is full at 90 degrees

// status strip chip per state.tracking (docs/contract.md); kind: lock = gold, warn = orange
const TRACKING = {
  "no-calibration": { text: "코트 보정 필요", kind: "warn" },
  "no-table": { text: "탁구대 안 보임", kind: "warn" },
  unstable: { text: "폰 흔들림", kind: "warn" },
  searching: { text: "공 찾는 중", kind: "" },
  locked: { text: "공 추적 중", kind: "lock" },
};
const LOUPE_ZOOM = 3;
const LOUPE_PX = 120;
const DRAG_PX = 8;           // a press that moves less than this is a tap

const CALIB_STEPS = [
  "내 쪽 끝선 왼쪽 모서리를 누르세요",
  "내 쪽 끝선 오른쪽 모서리를 누르세요",
  "건너편 끝선 오른쪽 모서리를 누르세요",
  "건너편 끝선 왼쪽 모서리를 누르세요",
];
const CALIB_DONE = "4곳을 확인하고, 필요하면 끌어서 맞추세요";
const CALIB_SNAPPING = "탁구대 테두리에 맞추는 중…";
const CALIB_SNAPPED = "테두리에 딱 맞췄어요. 선이 탁구대와 맞으면 확인";
const CALIB_EDGE = "탁구대 끝이 화면 밖이에요. 탁구대 전체가 보이게 폰을 세워 주세요";
const CALIB_SNAP_FAILED = "테두리를 못 찾았어요. 찍은 점 그대로예요, 끌어서 맞추세요";

// One SVG icon set: 24px grid, 2px round stroke (guideline 18).
// how long a new calibration warning sentence stays over the picture (ms)
const BANNER_MS = 6000;

const ICONS = {
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  calibrate: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 9v6M9 12h6"/>',
  swap: '<path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  settings: '<path d="M4 7h8M18 7h2M4 17h4M14 17h6"/><circle cx="15" cy="7" r="2.5"/><circle cx="11" cy="17" r="2.5"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  file: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  court: '<rect x="3" y="6" width="18" height="12"/><path d="M12 6v12M3 12h18"/>',
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">${ICONS[name]}</svg>`;
}

function icon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconSvg(name);
  span._n = name;
  return span;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setText(node, text) {
  const s = text == null ? "" : String(text);
  if (node._t !== s) { node.textContent = s; node._t = s; }
}

function setAttr(node, name, value) {
  const s = value == null ? null : String(value);
  const key = `_a_${name}`;
  if (node[key] === s) return;
  node[key] = s;
  if (s == null) node.removeAttribute(name); else node.setAttribute(name, s);
}

function setStyleVar(node, name, value) {
  const key = `_v_${name}`;
  if (node[key] === value) return;
  node[key] = value;
  node.style.setProperty(name, value);
}

function toggleClass(node, cls, on) {
  const key = `_c_${cls}`;
  if (node[key] === !!on) return;
  node[key] = !!on;
  node.classList.toggle(cls, !!on);
}

function setHidden(node, on) {
  if (node.hidden === !!on) return;
  node.hidden = !!on;
}

function fmtRallyTime(ms) {
  // mm:ss.cc like the reference (00:03.20)
  const total = Math.max(0, Math.floor(ms || 0));
  const m = Math.min(99, Math.floor(total / 60000));
  const s = Math.floor((total % 60000) / 1000);
  const c = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtKmh(v) {
  return v == null || Number.isNaN(v) ? "--" : `~${Math.round(v)}`;
}

function fmtMeters(v) {
  return v == null || Number.isNaN(v) ? "--" : (Math.round(v * 10) / 10).toFixed(1);
}

function fmtDeg(v) {
  return v == null || Number.isNaN(v) ? "--" : `${Math.round(v)}\u00b0`;
}

function pct(x) {
  return `${Math.round(Math.max(0, Math.min(1, x || 0)) * 100)}%`;
}

function fmtTimeOfDay(epochMs) {
  const d = new Date(epochMs);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function fmtDuration(ms) {
  return `${(Math.max(0, ms || 0) / 1000).toFixed(1)}초`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Live court map floor around the table (cm): players stand behind the end lines, so the map
// shows FLOOR_X behind each end and FLOOR_Y beside each long side; a player further away sits
// on the edge as a hollow ring (the footer still reads the real distance).
const FLOOR_X = 120, FLOOR_Y = 30;

/** Court map SVG markup: table seen from above, MY end on the left; `stands` adds the floor and the players. */
function courtSvg(bounces, calibrated, small, stands = null) {
  const W = TABLE_L * 100, H = TABLE_W * 100;
  const pad = small ? 10 : 14;
  const fx = stands ? FLOOR_X : pad, fy = stands ? FLOOR_Y : pad;
  const label = stands ? `바운드 위치 ${bounces.length}개, 선수 위치` : `바운드 위치 ${bounces.length}개`;
  const parts = [
    `<svg class="court__svg" viewBox="${-fx} ${-fy} ${W + fx * 2} ${H + fy * 2}" role="img" aria-label="${label}">`,
    stands ? `<rect class="cm-floor" x="${-fx}" y="${-fy}" width="${W + fx * 2}" height="${H + fy * 2}"/>` : "",
    `<rect class="cm-table" x="0" y="0" width="${W}" height="${H}"/>`,
    `<line class="cm-mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>`,
    `<line class="cm-net" x1="${W / 2}" y1="${-pad / 2}" x2="${W / 2}" y2="${H + pad / 2}"/>`,
  ];
  if (calibrated && bounces.length) {
    const pts = bounces.map((b) => ({ x: Math.max(0, Math.min(W, b.tx * 100)), y: Math.max(0, Math.min(H, b.ty * 100)), side: b.side }));
    if (pts.length > 1) parts.push(`<polyline class="cm-path" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>`);
    const s = small ? 12 : 10;
    pts.forEach((p, i) => {
      const cls = p.side === "far" ? "far" : "near";
      parts.push(`<rect class="cm-dot cm-dot--${cls}" x="${(p.x - s / 2).toFixed(1)}" y="${(p.y - s / 2).toFixed(1)}" width="${s}" height="${s}"/>`);
      if (i === pts.length - 1) parts.push(`<circle class="cm-ring cm-ring--${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${s * 1.3}"/>`);
    });
  }
  if (calibrated && stands) {
    for (const side of ["far", "near"]) {
      const st = stands[side];
      if (!st) continue;
      const rx = st.x * 100, ry = st.y * 100, r = 11;
      const x = Math.max(-fx + r, Math.min(W + fx - r, rx)), y = Math.max(-fy + r, Math.min(H + fy - r, ry));
      const out = x !== rx || y !== ry;
      const cls = `cm-stand cm-stand--${side}${st.stale ? " cm-stand--stale" : ""}${out ? " cm-stand--out" : ""}`;
      parts.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`);
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

// What the screen says about PC save on this device. `kind` picks the chip colour; never the key.
const NEED_PIN = "PIN을 넣어야 점수가 기록돼요";

function saveStatus(save = {}, hasPin = false) {
  const off = { chip: "PC꺼짐", label: "PC 저장: 꺼짐" };
  if (save.supported === false) return { kind: "bad", chip: "PC불가", label: "PC 저장 불가 · 녹화 미지원", hint: "이 브라우저는 영상 녹화를 지원하지 않아요" };
  if (!save.keySet) return { ...off, kind: "off", hint: hasPin ? save.keyError || "PC 저장 권한 발급을 다시 시도해 주세요" : "대회 PIN을 넣으면 켜져요" };
  if (save.check === "rejected") return { ...off, kind: "bad", hint: hasPin ? "이 기기 권한이 끊겼어요. PC 저장 권한 발급을 다시 시도해 주세요" : "이 기기 권한이 끊겼어요. 대회 PIN을 넣으면 켜져요" };
  if (save.check === "unknown") return { kind: "bad", chip: "PC?", label: "PC 저장: 확인 못 함", hint: "서버에 닿지 않아요. 연결되면 다시 확인해요" };
  if (save.check !== "ok") return { kind: "wait", chip: "PC…", label: "PC 저장: 확인 중", hint: "" };
  return { kind: "on", chip: "PC✓", label: "PC 저장: 켜짐 ✓", hint: "끝난 랠리 구간 영상과 기록이 PC로 올라가요" };
}

/**
 * Build the UI inside `root`.
 * @param {HTMLElement} root
 * @param {object} handlers see docs/contract.md
 */
export function createUI(root, handlers = {}) {
  const H = (name, ...args) => { const fn = handlers[name]; if (typeof fn === "function") return fn(...args); };

  // ---------- stage ----------
  const video = el("video", { class: "stage__video", playsinline: true, muted: true, autoplay: true, "aria-label": "카메라 영상" });
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const overlay = el("canvas", { class: "stage__overlay", "aria-hidden": "true" });
  const calibPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  calibPoly.setAttribute("class", "calib__poly");
  const calibSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  calibSvg.setAttribute("class", "calib__svg");
  calibSvg.append(calibPoly);
  const loupe = el("canvas", { class: "calib__loupe", hidden: true, "aria-hidden": "true" });
  const calibLayer = el("div", { class: "calib", "aria-label": "코트 보정: 탁구대 모서리를 누르세요" }, calibSvg, loupe);
  const stageChips = el("div", { class: "stage__chips" });
  const fitToggleLabel = el("span", {}, "채움");
  const btnFit = el("button", { class: "chip stage__fit", type: "button", hidden: true, onclick: () => toggleVideoFit() }, fitToggleLabel);
  let videoFill = localStorage.getItem("ppv-video-fill");
  const stage = el("div", { class: "stage" }, video, overlay, calibLayer);
  // the live chips and the fit switch: on the picture, just under the top panels (portrait phone)
  const peek = el("div", { class: "peek" }, stageChips, btnFit);

  // ---------- HUD ----------
  const timeNum = el("span", { class: "num" }, "00:00.00");
  const shotsNum = el("span", { class: "num" }, "0");
  const speedNum = el("span", { class: "num" }, "--");
  const glance = el("header", { class: "glance", "aria-label": "랠리 요약" },
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "RALLY TIME"), el("div", { class: "panel__value" }, timeNum)),
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "SHOT COUNT"), el("div", { class: "panel__value" }, shotsNum, el("span", { class: "unit" }, "SHOT"))),
    el("div", { class: "panel panel--glance" },
      el("div", { class: "panel__label" }, "SHOT SPEED"),
      el("div", { class: "panel__value" }, speedNum,
        el("span", { class: "unit unit--stack" }, el("span", {}, "km/h"), el("span", { class: "panel__note", title: "속도·거리는 화면 기반 추정치" }, "추정")))),
  );

  // status strip (guideline 23/25): recording chip, tracking chip, perf readout
  const recDot = el("i", { class: "chip__dot", "aria-hidden": "true" });
  const recText = el("span", {}, "준비됨");
  const chipRec = el("span", { class: "chip chip--rec" }, recDot, recText);
  const chipTrack = el("span", { class: "chip chip--track", hidden: true }, "");
  const chipPerf = el("span", { class: "chip chip--perf" }, "");
  const chipSave = el("span", { class: "chip chip--save" }, "");
  const chipSlow = el("span", { class: "chip chip--warn", hidden: true }, "폰이 느려졌어요(열?)");
  // tap: back to the full-screen overlay now, and no switch again for this camera run
  const chipStable = el("button", { class: "chip chip--warn chip--stable", type: "button", hidden: true, "aria-label": "판정 안정 모드 끄고 전체 화면으로", onclick: () => H("onDismissStable") }, "판정 안정 모드 · 영상 작게");
  // orange chosen but a white ball keeps showing (state.colorHint from the engine)
  const chipColor = el("span", { class: "chip chip--warn", hidden: true }, "");
  // one app, a role per device: the tournament app link and the way back to the role choice
  // one chip: the camera role (tap to change it) and the tournament link state
  const roleLink = (label) => el("span", { class: "chip chip--role" }, el("span", {}, label));
  const chipLink = roleLink("");
  const chipLinkText = chipLink.lastChild;
  // a PIN phone fixes the score here, without leaving the camera screen (the 점수 고치기 panel)
  const chipFix = el("button", { class: "chip chip--fix", type: "button", hidden: true, "aria-label": "점수 고치기", "aria-expanded": "false", onclick: () => toggleFix() }, icon("edit"), el("span", {}, "점수"));
  // the way out, top left on every camera screen; the browser's back does the same (app.js)
  const backButton = () => el("button", { class: "chip chip--back", type: "button", "data-back": "", "aria-label": "뒤로: 카메라 끄고 모드 고르기", onclick: () => back() }, icon("back"));
  chipRec.setAttribute("data-screen-name", "");
  const strip = el("div", { class: "strip", role: "status", "aria-live": "off" }, backButton(), chipLink, chipSave, chipFix, chipRec, chipTrack, chipSlow, chipStable, chipColor, chipPerf);
  // calibration issue banner: the engine's sentence (state.calibrationIssue), shown only while set
  const bannerText = el("span", {}, "");
  const banner = el("div", { class: "banner", role: "status", hidden: true }, icon("warn"), bannerText);

  const playerRows = {};
  function playerBlock(side) {
    const cls = side === "near" ? "me" : "opp";
    const name = el("span", { class: `plate plate--${cls}` }, side === "near" ? "블루 사이드" : "레드 사이드");
    const off = el("span", { class: "prow__off", hidden: true }, "화면 밖");
    const row = (key, fill, num, unit) => el("div", { class: "prow" }, el("span", { class: "prow__k" }, key),
      el("span", { class: `meter meter--${cls}`, "aria-hidden": "true" }, el("i", { class: "meter__track" }), fill),
      el("span", { class: "prow__v" }, num, unit ? el("span", { class: "unit" }, ` ${unit}`) : null));
    const moveFill = el("i", { class: "meter__fill" }), moveNum = el("span", {}, "--");
    const wristFill = el("i", { class: "meter__fill" }), wristNum = el("span", {}, "--");
    const shotFill = el("i", { class: "meter__fill" }), shotNum = el("span", {}, "--");
    const block = el("div", { class: "pblock" },
      el("div", { class: "prow prow--name" }, name, off),
      row("MOVE", moveFill, moveNum, "m"),
      row("손목", wristFill, wristNum, null),
      row("SHOT", shotFill, shotNum, "km/h"));
    playerRows[side] = { name, off, wristFill, wristNum, moveFill, moveNum, shotFill, shotNum };
    return block;
  }
  const vs = el("div", { class: "vs", "aria-hidden": "true" }, el("span", { class: "vs__t" }, "VS"));
  const players = el("section", { class: "panel players", "aria-label": "선수 기록" }, playerBlock("near"), vs, playerBlock("far"));

  const courtSvgWrap = el("div", { class: "court__svgwrap" });
  const courtHint = el("p", { class: "court__hint", hidden: true }, "코트 보정을 하면 바운드 위치가 보여요");
  const courtBox = el("div", { class: "court__box" }, courtSvgWrap, courtHint);
  const courtCount = el("span", { class: "court__count" }, "바운드 0회");
  // metres behind the end line of each player's standing point ("1.2m", "옆" beside the table)
  const standDist = { near: el("span", { class: "court__dist" }, ""), far: el("span", { class: "court__dist" }, "") };
  // the end colour of each map end (the near end is at the bottom of the map)
  const courtKey = { near: el("span", {}, "블루"), far: el("span", {}, "레드") };
  const court = el("section", { class: "panel court", "aria-label": "바운드와 선수 위치" },
    el("div", { class: "court__head" }, el("span", { class: "court__title" }, "COURT MAP"), el("span", { class: "court__sub" }, "바운드·선수")),
    courtBox,
    el("div", { class: "court__foot" },
      el("span", { class: "court__key c-me" }, el("i", { class: "swatch swatch--me", "aria-hidden": "true" }), courtKey.near, standDist.near),
      courtCount,
      el("span", { class: "court__key c-opp" }, standDist.far, courtKey.far, el("i", { class: "swatch swatch--opp", "aria-hidden": "true" }))),
  );
  const bottom = el("div", { class: "bottom" }, players, court);
  // players + court map sit behind one chip. They start open on every visit, portrait and landscape,
  // and stay open through rallies (owner, 2026-10-31: "기본이 펼친걸로 해"); the chip folds them by hand.
  let panelsOpen = true;
  const dockArrow = el("span", { class: "dock__arrow", "aria-hidden": "true" }, "");
  const dock = el("button", { class: "chip dock", type: "button", "aria-expanded": "true", onclick: () => setPanels(!panelsOpen) }, icon("court"), el("span", {}, "선수·코트"), dockArrow);
  function setPanels(on) {
    panelsOpen = !!on;
    syncPanels();
  }
  function syncPanels() {
    setHidden(bottom, !panelsOpen);
    setAttr(app, "data-panels", panelsOpen ? "open" : "closed");
    setAttr(dock, "aria-expanded", String(panelsOpen));
    setAttr(dock, "aria-label", panelsOpen ? "선수·코트맵 접기" : "선수·코트맵 펼치기");
    setText(dockArrow, panelsOpen ? "▾" : "▴");
  }
  const live = el("div", { class: "visually-hidden", "aria-live": "polite" });
  const hud = el("div", { class: "hud" }, glance, banner, dock, bottom, live);

  // ---------- control bar ----------
  const toggleIcon = icon("play");
  const toggleLabel = el("span", {}, "시작");
  const btnToggle = el("button", { class: "btn btn--bar btn--primary", type: "button", onclick: () => (currentMode === "running" ? H("onStop") : H("onStartCamera")) }, toggleIcon, toggleLabel);
  const btnCalib = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onBeginCalibration"); } }, icon("calibrate"), el("span", {}, "코트 보정"));
  const btnSwap = el("button", { class: "btn btn--bar", type: "button", "aria-label": "자리 교체: 두 선수의 엔드 바꾸기, 레드·블루 사이드는 그대로", onclick: () => H("onSwapPlayers") }, icon("swap"), el("span", {}, "자리 교체"));
  const btnHistory = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onOpenHistory"); } }, icon("history"), el("span", {}, "기록"));
  const btnSettings = el("button", { class: "btn btn--bar", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => toggleSettings() }, icon("settings"), el("span", {}, "설정"));
  const bar = el("nav", { class: "bar", "aria-label": "조작" }, btnToggle, btnCalib, btnSwap, btnHistory, btnSettings);

  // ---------- point entered in the tournament app: 3 s to cancel ----------
  const pointText = el("span", { class: "pointbar__text" }, "");
  const pointCancel = el("button", { class: "btn btn--danger pointbar__cancel", type: "button", onclick: () => H("onTourCancel") }, "취소");
  const pickBlue = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--blue", type: "button", onclick: () => H("onTourPick", 0) }, "블루 득점");
  const pickRed = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--red", type: "button", onclick: () => H("onTourPick", 1) }, "레드 득점");
  const pointPicks = el("div", { class: "pointbar__picks", hidden: true }, pickBlue, pickRed);
  const askLet = el("button", { class: "btn btn--big pointbar__ask", type: "button", onclick: () => H("onTourLet") }, "렛?");
  const askFault = el("button", { class: "btn btn--big pointbar__ask", type: "button", onclick: () => H("onTourFault") }, "폴트?");
  const pointAsks = el("div", { class: "pointbar__picks pointbar__asks", hidden: true }, askLet, askFault);
  const pointbar = el("div", { class: "pointbar", role: "status", "aria-live": "polite", hidden: true }, pointText, pointCancel, pointPicks, pointAsks);

  // ---------- 점수 고치기: +1, 되돌리기, and a recent point to the other side (PIN phone only) ----------
  let fixOpen = false;
  let fixSig = "";
  const fixScore = el("span", { class: "fix__score" }, "");
  const fixClose = el("button", { class: "btn btn--quiet fix__close", type: "button", "aria-label": "점수 고치기 닫기", onclick: () => toggleFix(false) }, icon("close"));
  const fixPlus = [0, 1].map((side) => el("button", { class: `btn fix__plus fix__plus--${side ? "red" : "blue"}`, type: "button", "data-side": String(side), onclick: () => H("onTourFix", "plus", side) }, `${SIDE_NAMES[side]} +1`));
  const fixUndo = el("button", { class: "btn fix__undo", type: "button", onclick: () => H("onTourFix", "undo") }, icon("undo"), el("span", {}, "점수 취소"));
  const fixRecent = el("div", { class: "fix__recent", role: "group", "aria-label": "최근 점수, 누르면 반대쪽 득점으로" });
  const fixNote = el("p", { class: "fix__note", role: "status" }, "");
  const fixPanel = el("section", { class: "fix", "aria-label": "점수 고치기", hidden: true },
    el("div", { class: "fix__head" }, el("h2", { class: "fix__title" }, "점수 고치기"), fixClose),
    fixScore,
    el("div", { class: "fix__row" }, fixPlus[0], fixUndo, fixPlus[1]),
    el("p", { class: "fix__label" }, "최근 점수 · 누르면 반대쪽 득점으로 바뀜어요"),
    fixRecent, fixNote);
  function toggleFix(on = !fixOpen) {
    fixOpen = !!on;
    if (fixOpen) closeSettings();
    setAttr(chipFix, "aria-expanded", String(fixOpen));
    chipFix.disabled = fixOpen;
    syncBackNames();
  }
  const narrow = typeof matchMedia === "function" ? matchMedia("(max-width: 599px)") : { matches: false };

  // ---------- settings popover ----------
  let layoutPref = "auto";
  const segs = {};
  function seg(name, options, onPick) {
    const buttons = options.map(([value, label]) => el("button", { class: "seg__btn", type: "button", "aria-pressed": "false", onclick: () => onPick(value) }, label));
    segs[name] = { buttons, options };
    return el("div", { class: "seg", role: "group", "aria-label": name }, ...buttons);
  }
  function setSeg(name, value) {
    const s = segs[name];
    s.options.forEach(([v], i) => setAttr(s.buttons[i], "aria-pressed", v === value ? "true" : "false"));
  }
  const btnSettingsClose = el("button", { class: "btn btn--quiet", type: "button", "aria-label": "설정 닫기", onclick: () => closeSettings() }, icon("close"));
  const keyInput = el("input", { type: "password", name: "upload-key", autocomplete: "off", "aria-label": "PC 저장 열쇠", placeholder: "열쇠 붙여넣기" });
  const keyStatus = el("p", { class: "screen__note", role: "status" }, "");
  const saveState = el("span", { class: "chip chip--save", role: "status" }, "");
  const privacyNote = el("p", { class: "screen__note" }, "");
  const tourPin = el("input", { type: "password", name: "tournament-pin", inputmode: "numeric", autocomplete: "off", "aria-label": "대회 PIN", placeholder: "대회 PIN" });
  const tourForm = el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); H("onTourConnect", tourPin.value); tourPin.value = ""; } },
    tourPin, el("button", { class: "btn", type: "submit" }, "연결"));
  const tourMatch = el("select", { class: "select", "aria-label": "점수를 넣을 경기", onchange: (e) => H("onTourMatch", e.target.value) });
  const tourLinked = el("div", { class: "tourlink", hidden: true },
    tourMatch,
    seg("자동 입력", [["sure", "확실할 때만"], ["all", "모든 포인트 자동"]], (v) => H("onTourMode", v)),
    el("button", { class: "btn", type: "button", onclick: () => H("onTourDisconnect") }, "연동 끄기"));
  const tourStatus = el("p", { class: "screen__note", role: "status" }, "");
  let tourSig = "";
  const handPlate = { near: el("span", { class: "plate plate--me" }, "블루 사이드"), far: el("span", { class: "plate plate--opp" }, "레드 사이드") };
  const popover = el("div", { class: "popover", role: "dialog", "aria-label": "설정", hidden: true },
    el("h2", { class: "popover__title" }, "설정", btnSettingsClose),
    el("div", { class: "field" }, el("div", { class: "field__label" }, handPlate.near, el("span", { class: "unit" }, "라켓 손")),
      seg("앞쪽 라켓 손", [["R", "오른손"], ["L", "왼손"]], (v) => H("onSetHand", "near", v))),
    el("div", { class: "field" }, el("div", { class: "field__label" }, handPlate.far, el("span", { class: "unit" }, "라켓 손")),
      seg("건너편 라켓 손", [["R", "오른손"], ["L", "왼손"]], (v) => H("onSetHand", "far", v))),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "화면")),
      seg("화면", [["auto", "자동"], ["phone", "폰"], ["tv", "큰 화면(TV)"]], (v) => { layoutPref = v; setSeg("화면", v); H("onSetLayout", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "공 색")),
      seg("공 색", [["white", "흰색"], ["orange", "주황(실험)"]], (v) => { setSeg("공 색", v); H("onSetBallColor", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "탁구대 끝 뒤에서 찍을 때")),
      seg("끝 뒤 카메라", [["off", "기본"], ["on", "공 더 잡기(실험)"]], (v) => { setSeg("끝 뒤 카메라", v); H("onSetEndOnCubic", v === "on"); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "판정 안정 모드(분석이 느리면 영상 작게)")),
      seg("판정 안정 모드", [["auto", "자동"], ["off", "끄기"]], (v) => { setSeg("판정 안정 모드", v); H("onSetStableMode", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "다시 보기 영상에 오버레이 넣기")),
      seg("다시 보기 오버레이", [["on", "넣기"], ["off", "영상만"]], (v) => { setSeg("다시 보기 오버레이", v); H("onSetReplayOverlay", v === "on"); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "판정용 영상(시험)")),
      seg("판정용 영상", [["screen", "화면"], ["probe", "따로 작게"], ["probe-big", "따로 크게"]], (v) => { setSeg("판정용 영상", v); H("onSetAnalysisFrom", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "PC 저장 열쇠"), saveState),
      el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); if (!keyInput.value.trim()) { notice("열쇠를 붙여 넣어 주세요"); return; } H("onSetUploadKey", keyInput.value); keyInput.value = ""; } },
        keyInput, el("button", { class: "btn", type: "submit" }, "열쇠 저장")),
      keyStatus),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "대회 점수 자동 입력")),
      tourForm, tourLinked, tourStatus,
      seg("카메라 앞쪽", [[0, "앞쪽 블루 사이드"], [1, "앞쪽 레드 사이드"]], (v) => H("onTourNear", v)),
      seg("점수 음성", [[true, "음성 켜기"], [false, "음성 끄기"]], (v) => H("onTourVoice", v))),
    privacyNote,
  );
  setSeg("화면", layoutPref);
  setSeg("끝 뒤 카메라", "off");
  setSeg("판정용 영상", "screen");
  setSeg("판정 안정 모드", "auto");
  setSeg("다시 보기 오버레이", "on");
  setSeg("공 색", "white");

  let settingsOpen = false;
  let keySet = false;
  function onDocPointer(e) {
    // the back button closes settings itself (one level per press), so it is not an outside tap here
    if (!popover.contains(e.target) && !btnSettings.contains(e.target) && !e.target.closest("[data-back]")) closeSettings();
  }
  function openSettings() {
    if (settingsOpen) return;
    toggleFix(false);
    settingsOpen = true;
    btnSettings.disabled = true;
    popover.hidden = false;
    setAttr(btnSettings, "aria-expanded", "true");
    document.addEventListener("pointerdown", onDocPointer, true);
    btnSettingsClose.focus({ preventScroll: true });
    syncBackNames();
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    btnSettings.disabled = false;
    popover.hidden = true;
    setAttr(btnSettings, "aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    if (document.activeElement && popover.contains(document.activeElement)) btnSettings.focus({ preventScroll: true });
    syncBackNames();
  }
  function toggleSettings() { settingsOpen ? closeSettings() : openSettings(); }

  // ---------- history sheet ----------
  const rallyList = el("ul", { class: "rally-list" });
  // when the picture went small for 판정 안정 모드 or came back, and why (app.js applyStable)
  const stableNote = el("p", { class: "screen__note", hidden: true });
  // The list folds like every long list in the app, remembered on this device: 'closed', 'all' or absent.
  const foldState = () => localStorage.getItem("ppv-fold-rallies");
  const setFold = (value) => {
    if (value) localStorage.setItem("ppv-fold-rallies", value);
    else localStorage.removeItem("ppv-fold-rallies");
    historySig = "";
    renderHistory(lastHistory);
  };
  const foldName = el("span", { class: "fold-name" }, "랠리");
  const foldCount = el("span", { class: "fold-count" });
  const foldIcon = el("span", { class: "fold-chev" });
  const foldHead = el("button", { class: "fold-head", type: "button", hidden: true, onclick: () => setFold(foldState() === "closed" ? null : "closed") }, foldName, foldCount, foldIcon);
  const foldMore = el("button", { class: "btn fold-more", type: "button", hidden: true, onclick: () => setFold(foldState() === "all" ? null : "all") });
  const sheetBody = el("div", { class: "sheet__body" }, stableNote, foldHead, rallyList, foldMore);
  const btnClear = el("button", { class: "btn", type: "button", onclick: () => showClearConfirm(true) }, icon("trash"), el("span", {}, "비우기"));
  const footNormal = el("div", { class: "sheet__foot" }, btnClear);
  const btnConfirmNo = el("button", { class: "btn", type: "button", onclick: () => showClearConfirm(false) }, "취소");
  const btnConfirmYes = el("button", { class: "btn btn--danger", type: "button", onclick: () => { showClearConfirm(false); H("onClearHistory"); } }, "비우기");
  const confirmText = el("p", {}, "기록을 모두 비울까요?");
  const footConfirm = el("div", { class: "sheet__foot", hidden: true }, el("div", { class: "sheet__confirm" }, confirmText, btnConfirmNo, btnConfirmYes));
  const btnSheetX = el("button", { class: "btn btn--quiet", type: "button", "aria-label": "기록 닫기", onclick: () => H("onCloseHistory") }, icon("close"));
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "랠리 기록", hidden: true },
    el("div", { class: "sheet__head" }, el("h2", { class: "sheet__title" }, "랠리 기록"), btnSheetX),
    sheetBody, footNormal, footConfirm);
  const backdrop = el("div", { class: "backdrop", hidden: true, onclick: () => H("onCloseHistory") });
  let sheetOpen = false;
  let historySig = "";
  function showClearConfirm(on) {
    footNormal.hidden = !!on;
    footConfirm.hidden = !on;
    (on ? btnConfirmNo : btnClear).focus({ preventScroll: true });
  }
  function uploadRow(r) {
    const u = r.upload;
    if (!u) return el("span", {});
    const label = { uploading: "올리는 중", done: "올림", failed: "못 올림" }[u.status] || "";
    const kids = [el("span", { class: `upchip upchip--${u.status}`, role: "status" }, label)];
    if (u.status === "done" && u.url) kids.push(el("a", { class: "btn btn--link", href: u.url, target: "_blank", rel: "noopener" }, "공유 링크"));
    if (u.status !== "uploading") kids.push(el("button", { class: "btn", type: "button", onclick: () => H("onDeleteRally", r.id) }, icon("trash"), el("span", {}, "지우기")));
    if (u.error && u.status !== "failed") kids.push(el("span", { class: "upchip upchip--failed" }, u.error));
    return el("div", { class: "rally__upload" }, ...kids);
  }
  let lastHistory = [];
  function renderHistory(list) {
    lastHistory = list;
    const sig = list.map((r) => `${r.id}:${r.shots}:${r.bounces?.length || 0}:${r.upload?.status || ""}:${r.upload?.error || ""}`).join("|");
    if (sig === historySig) return;
    historySig = sig;
    rallyList.replaceChildren();
    foldHead.hidden = !list.length;
    foldMore.hidden = true;
    if (!list.length) {
      rallyList.append(el("li", {}, el("p", { class: "empty" }, "아직 기록이 없어요. 시작을 누르고 랠리를 해보세요.")));
      btnClear.disabled = true;
      return;
    }
    btnClear.disabled = false;
    const items = [...list].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const state = foldState();
    foldCount.textContent = `${items.length}개`;
    foldHead.setAttribute("aria-expanded", String(state !== "closed"));
    foldIcon.innerHTML = "";
    foldIcon.append(icon(state === "closed" ? "chevronDown" : "chevronUp"));
    const long = items.length > 10 && state !== "closed";
    foldMore.hidden = !long;
    foldMore.textContent = state === "all" ? "최근 5개만 보기" : `전체 ${items.length}개 보기`;
    const shown = state === "closed" ? [] : long && state !== "all" ? items.slice(0, 5) : items;
    for (const r of shown) {
      const map = el("div", { class: "rally__map", "aria-hidden": "true" });
      map.innerHTML = courtSvg(r.bounces || [], true, true);
      rallyList.append(el("li", { class: "rally" },
        el("div", {},
          el("div", { class: "rally__time" }, fmtTimeOfDay(r.startedAt)),
          el("div", { class: "rally__stats" },
            el("span", {}, "길이 ", el("b", {}, fmtDuration(r.durationMs))),
            el("span", {}, "샷 ", el("b", {}, String(r.shots ?? 0))),
            el("span", {}, "최고 ", el("b", {}, fmtKmh(r.maxSpeedKmh)), " km/h")),
          uploadRow(r)),
        map));
    }
  }
  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    closeSettings();
    showClearConfirm(false);
    backdrop.hidden = false;
    sheet.hidden = false;
    btnHistory.disabled = true;
    btnSheetX.focus({ preventScroll: true });
    syncBackNames();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    btnHistory.disabled = false;
    backdrop.hidden = true;
    sheet.hidden = true;
    historySig = "";
    btnHistory.focus({ preventScroll: true });
    syncBackNames();
  }

  // ---------- screens ----------
  function fileButton(label) {
    const input = el("input", { type: "file", accept: "video/*", "aria-label": label, onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) H("onOpenFile", f); e.target.value = ""; } });
    return el("label", { class: "btn btn--block btn--file" }, icon("file"), el("span", {}, label), input);
  }
  const introNote = el("p", { class: "screen__note", role: "status" }, "속도·거리는 화면 기반 추정치예요.");
  let shownNotice = null;
  const introSave = el("b", { class: "screen__save" }, "");
  const introPrivacyText = el("span", {}, "");
  const introPinInput = el("input", { type: "password", name: "intro-pin", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "대회 PIN", placeholder: "대회 PIN" });
  const introPin = el("form", { class: "keyform screen__pin", hidden: true, onsubmit: (e) => { e.preventDefault(); H("onTourConnect", introPinInput.value); introPinInput.value = ""; } },
    introPinInput, el("button", { class: "btn", type: "submit" }, "켜기"));
  const introRetry = el("button", { class: "btn", type: "button", hidden: true, onclick: () => H("onRetrySave") }, "PC 저장 다시 시도");
  const introPrivacy = el("span", {}, introSave, " ", introPrivacyText, introPin, introRetry);
  const introLink = roleLink("");
  const screenIntro = el("div", { class: "screen screen--intro" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton(), introLink),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    el("h1", { class: "screen__title", "data-screen-name": "" }, "탁구 랠리를 폰 카메라로 분석해요"),
    el("ul", { class: "screen__list" },
      el("li", {}, "삼각대에 폰을 세우고 탁구대를 비추면 랠리 시간, 샷 수, 샷 속도를 보여줘요."),
      el("li", {}, "두 선수의 자세와 공 궤적, 바운드 위치를 화면 위에 그려요."),
      el("li", {}, "처음 한 번 탁구대 모서리 4곳을 눌러 코트를 보정해요.")),
    el("p", { class: "screen__privacy" }, icon("shield"), introPrivacy),
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("camera"), el("span", {}, "카메라 시작")),
      fileButton("영상 파일로 시험")),
    introNote));

  const loadingText = el("p", { class: "screen__title", role: "status", "data-screen-name": "" }, "준비하는 중…");
  // real bytes: the fill is received / total; the init step after the download is a busy bar
  const progressFill = el("div", { class: "progress__fill" });
  const progressBar = el("div", { class: "progress progress--busy", role: "progressbar", "aria-label": "불러오는 중", "aria-valuemin": "0", "aria-valuemax": "100" }, progressFill);
  const progressCount = el("p", { class: "progress__count" }, "");
  const mb = (n) => (n / 1048576).toFixed(1);
  const screenLoading = el("div", { class: "screen screen--loading" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton()),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    loadingText,
    progressBar,
    progressCount,
    el("p", { class: "screen__note" }, "자세 인식 모델은 처음 열 때 한 번만 받아요.")));

  const errTitle = el("h1", { class: "screen__title", "data-screen-name": "" }, "문제가 생겼어요");
  const errDetail = el("p", { class: "screen__text" }, "");
  const errSteps = el("ol", { class: "screen__list" });
  const errRetryLabel = el("span", {}, "다시 시도");
  const screenError = el("div", { class: "screen screen--error", role: "alertdialog", "aria-labelledby": "ppv-err-title" }, el("div", { class: "screen__inner" },
    el("div", { class: "screen__role" }, backButton()),
    el("p", { class: "brand" }, "PINGPONG VISION"),
    errTitle, errDetail, errSteps,
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("restart"), errRetryLabel),
      fileButton("영상 파일로 시험"))));
  errTitle.id = "ppv-err-title";
  let errSig = "";

  // ---------- calibration bar ----------
  const calibStep = el("span", { class: "calibbar__step" }, "1/4");
  const calibText = el("p", { class: "calibbar__text" }, CALIB_STEPS[0]);
  const calibDots = el("div", { class: "calibbar__dots", "aria-hidden": "true" }, ...[0, 1, 2, 3].map(() => el("i")));
  const calibHint = el("p", { class: "calibbar__hint" }, "가로로 돌리면 더 정확해요");
  const btnUndo = el("button", { class: "btn", type: "button", "aria-label": "마지막 모서리 취소", onclick: () => calibUndo() }, icon("undo"), el("span", {}, "모서리 취소"));
  const btnRestart = el("button", { class: "btn", type: "button", onclick: () => calibReset() }, icon("restart"), el("span", {}, "다시"));
  const btnConfirm = el("button", { class: "btn btn--primary", type: "button", disabled: true, onclick: () => calibConfirm() }, icon("check"), el("span", {}, "확인"));
  const calibbar = el("div", { class: "calibbar" },
    el("div", { class: "calibbar__guide", role: "status", "aria-live": "polite" }, calibStep, calibText, calibDots, calibHint),
    el("div", { class: "calibbar__actions" }, btnUndo, btnRestart, btnConfirm));

  // ---------- assemble ----------
  // short message for an action with nothing else to show, same look as the tournament app's toast
  const toastEl = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
  let toastTimer = null;
  // centred under the top rows (strip, glance, chips on the picture): above the table, clear of panels and
  // buttons. Re-placed on every render while it shows: the record chips appear only after a calibration
  // confirm, and a notice placed before them sat over them (production capture, 2026-10-31)
  function placeToast() {
    const appTop = app.getBoundingClientRect().top;
    const top = Math.max(0, ...[strip, glance, stageChips, btnFit, pointbar].filter((n) => !n.closest("[hidden]") && n.offsetHeight).map((n) => n.getBoundingClientRect().bottom - appTop));
    const want = `${Math.round(top) + 8}px`;
    if (toastEl.style.top !== want) toastEl.style.top = want;
  }
  function notice(text) {
    setText(toastEl, text);
    placeToast();
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3000);
  }

  // ---------- leaving while recording: one confirm (no browser dialog) ----------
  let leaveResolve = null;
  const btnStay = el("button", { class: "btn btn--primary", type: "button", onclick: () => answerLeave(false) }, el("span", {}, "계속 찍기"));
  const btnGo = el("button", { class: "btn btn--danger", type: "button", onclick: () => answerLeave(true) }, el("span", {}, "멈추고 나가기"));
  const leaveDlg = el("div", { class: "leave", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "ppv-leave-title", hidden: true },
    el("div", { class: "leave__card" },
      el("p", { class: "leave__title", id: "ppv-leave-title" }, "찍는 중이에요. 멈추고 나갈까요?"),
      el("p", { class: "screen__note" }, "끝난 랠리 영상과 점수는 다 보낸 뒤에 나가요."),
      el("div", { class: "leave__actions" }, btnStay, btnGo)));
  function answerLeave(go) {
    setHidden(leaveDlg, true);
    const r = leaveResolve;
    leaveResolve = null;
    if (r) r(go);
  }
  function confirmLeave() {
    if (leaveResolve) answerLeave(false);
    closeSettings();
    setHidden(leaveDlg, false);
    btnStay.focus({ preventScroll: true });
    return new Promise((resolve) => { leaveResolve = resolve; });
  }
  // Back closes what is open on top first, then leaves the camera (app.js onLeave).
  function back() {
    if (leaveResolve) return answerLeave(false);
    if (settingsOpen) return closeSettings();
    if (sheetOpen) return H("onCloseHistory");
    if (fixOpen) return toggleFix(false);
    if (currentMode === "calibrating") { calibReset(); return H("onCalibrationCancel"); }
    H("onLeave");
  }
  function syncBackNames() {
    const name = leaveResolve ? "뒤로: 나가기 취소" : settingsOpen ? "설정 닫기" : sheetOpen ? "기록 닫기" : fixOpen ? "점수 고치기 닫기" : currentMode === "calibrating" ? "보정 취소" : "모드 고르기로";
    for (const button of app.querySelectorAll("[data-back]")) setAttr(button, "aria-label", name);
    for (const button of app.querySelectorAll("[data-back]")) setAttr(button, "data-back-destination", leaveResolve ? "recording" : settingsOpen ? "camera" : sheetOpen ? "camera" : fixOpen ? "camera" : currentMode === "calibrating" ? "camera" : "picker");
    // settings, history or 점수 고치기 open: the fold chip and the fit switch sit under them, so they step away
    setAttr(app, "data-over", settingsOpen || sheetOpen || fixOpen ? "1" : "0");
  }

  const app = el("div", { class: "app", "data-mode": "intro", "data-layout": "phone", "data-fit": "stack" },
    stage, peek, hud, strip, pointbar, bar, popover, fixPanel, calibbar, backdrop, sheet, screenIntro, screenLoading, screenError, leaveDlg, toastEl);
  root.replaceChildren(app);
  syncPanels();

  // ---------- geometry: video px <-> CSS px of the overlay (object-fit: contain) ----------
  let stageW = 0, stageH = 0, vidW = 0, vidH = 0;
  let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  function updateFit() {
    if (!stageW || !stageH || !vidW || !vidH) { fit = { x: 0, y: 0, w: stageW, h: stageH, scale: 1 }; return; }
    fit = fitBox(stageW, stageH, vidW, vidH, coverNow());
  }
  // Display only: the engine always reads the full frame. Calibration is always contain, so every
  // corner of the table can be tapped; a tall camera stream starts filled, a wide one whole.
  function coverNow() {
    if (fitMode !== "stack" || currentMode === "calibrating" || !vidW) return false;
    return videoFill ? videoFill === "fill" : vidH > vidW;
  }
  function syncVideoFit() {
    const cover = coverNow();
    setAttr(stage, "data-video-fit", cover ? "cover" : "contain");
    setAttr(app, "data-video-wide", vidW > vidH && !cover ? "1" : "0");
    if (vidW) app.style.setProperty("--vid-ar", `${vidW} / ${vidH}`);
    setText(fitToggleLabel, cover ? "맞춤" : "채움");
    btnFit.setAttribute("aria-pressed", String(cover));
    btnFit.setAttribute("aria-label", cover ? "영상 전체 보기" : "영상을 칸에 꽉 채우기");
    setHidden(btnFit, fitMode !== "stack" || !["ready", "running", "stopped"].includes(currentMode));
    updateFit();
  }
  function toggleVideoFit() {
    videoFill = coverNow() ? "fit" : "fill";
    localStorage.setItem("ppv-video-fill", videoFill);
    syncVideoFit();
  }
  function setVideoSize(w, h) {
    if (w > 0 && h > 0 && (w !== vidW || h !== vidH)) { vidW = w; vidH = h; updateFitMode(); syncVideoFit(); }
  }
  function videoToScreen(pt) { return { x: fit.x + pt.x * fit.scale, y: fit.y + pt.y * fit.scale }; }
  function screenToVideo(pt) { return { x: (pt.x - fit.x) / fit.scale, y: (pt.y - fit.y) / fit.scale }; }

  // Order matters: the band-mode stage box is computed from the panel heights and the fit
  // mode, so both must be settled before the stage size (and the overlay backing store) is read.
  function measureStage() {
    const gh = glance.offsetHeight;
    if (gh && gh !== glanceH) { glanceH = gh; app.style.setProperty("--glance-h", `${gh}px`); }
    const bh = bottom.offsetHeight;
    if (bh && bh !== bottomH) { bottomH = bh; app.style.setProperty("--bottom-h", `${bh}px`); }
    updateFitMode();
    const w = stage.clientWidth, h = stage.clientHeight;
    if (w !== stageW || h !== stageH) {
      stageW = w; stageH = h; updateFit();
      layoutCalibMarkers();
    }
  }
  let glanceH = 0;
  let bottomH = 0;
  let fitMode = "stack";
  // "stack": portrait phone, whatever the video's aspect ratio. Status strip, glance row, live
  //          chips, fold chip, players + court and the control bar are grid rows floating on the
  //          full-screen picture; while calibrating the picture is the middle row, uncovered.
  // "overlay": landscape phone and tv. The stage fills the screen; panels sit on its edges.
  function updateFitMode() {
    const portrait = app.clientWidth < app.clientHeight;
    const want = currentLayout === "phone" && portrait ? "stack" : "overlay";
    if (want !== fitMode) { fitMode = want; setAttr(app, "data-fit", want); syncVideoFit(); }
    // portrait: the strip stays one line and the live status sits on the picture
    const home = fitMode === "stack" ? stageChips : strip;
    if (chipRec.parentNode !== home) for (const c of [chipRec, chipTrack, chipSlow, chipStable, chipColor]) home === strip ? strip.insertBefore(c, chipPerf) : home.append(c);
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => measureStage()) : null;
  if (ro) { ro.observe(stage); ro.observe(glance); ro.observe(bottom); ro.observe(app); } else window.addEventListener("resize", measureStage);
  video.addEventListener("loadedmetadata", () => setVideoSize(video.videoWidth, video.videoHeight));
  video.addEventListener("resize", () => setVideoSize(video.videoWidth, video.videoHeight));
  // Calibration taps land on a still frame. app.js pauses a file source when calibration begins,
  // but WebKit's media engine sometimes undoes that by itself when the seek app.js queued before
  // the pause completes afterwards: the element resumes with no play() call, or jumps straight to
  // its end. The UI owns the element, so it holds it: pause again, and rewind a file that "ended"
  // while nobody was playing it.
  function holdCalibrationFrame() {
    if (currentMode !== "calibrating" || currentSource !== "file") return;
    if (!video.paused) video.pause();
    if (video.ended || (video.duration > 0 && video.currentTime >= video.duration)) video.currentTime = 0;
  }
  video.addEventListener("playing", holdCalibrationFrame);
  video.addEventListener("ended", holdCalibrationFrame);

  const ctx = overlay.getContext("2d");
  function ensureOverlaySize() {
    if (stage.clientWidth !== stageW || stage.clientHeight !== stageH) measureStage();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(stageW * dpr), h = Math.round(stageH * dpr);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }

  // ---------- calibration interaction ----------
  let calibPts = [];        // stage CSS px, tap order
  let calibMarkers = [];
  let drag = null;
  let posterImg = null;
  const stageRect = { left: 0, top: 0 };
  function refreshStageRect() { const r = stage.getBoundingClientRect(); stageRect.left = r.left; stageRect.top = r.top; }
  function clampToVideo(p) {
    if (!fit.w || !fit.h) return p;
    return { x: Math.max(fit.x, Math.min(fit.x + fit.w, p.x)), y: Math.max(fit.y, Math.min(fit.y + fit.h, p.y)) };
  }
  function updateCalibGuide() {
    const n = calibPts.length;
    setText(calibStep, `${Math.min(n + 1, 4)}/4`);
    setText(calibText, n >= 4 ? snapNote || CALIB_DONE : CALIB_STEPS[n]);
    calibDots.childNodes.forEach((d, i) => toggleClass(d, "on", i < n));
    btnConfirm.disabled = n < 4;
    btnUndo.disabled = n === 0;
    btnRestart.disabled = n === 0;
    const pts = calibPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    calibPoly.setAttribute("points", pts);
  }
  function layoutCalibMarkers() {
    calibMarkers.forEach((m, i) => { const p = calibPts[i]; if (p) { m.style.left = `${p.x}px`; m.style.top = `${p.y}px`; } });
    updateCalibGuide();
  }
  function addCalibPoint(p) {
    const idx = calibPts.length;
    calibPts.push(p);
    const cross = el("span", { class: "calib__pt-x", "aria-hidden": "true" });
    cross.innerHTML = '<svg viewBox="0 0 24 24"><path class="calib__pt-shadow" d="M12 1v8M12 15v8M1 12h8M15 12h8"/><path class="calib__pt-line" d="M12 1v8M12 15v8M1 12h8M15 12h8"/></svg>';
    const marker = el("button", { class: "calib__pt", type: "button", "aria-label": `모서리 ${idx + 1} (끌어서 조정)` }, cross, el("b", { class: "calib__pt-n" }, String(idx + 1)));
    marker.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      if (snapNote) dropSnap();
      calibPts[idx] = clampToVideo({ x: calibPts[idx].x + d[0], y: calibPts[idx].y + d[1] });
      layoutCalibMarkers();
    });
    calibMarkers.push(marker);
    calibLayer.append(marker);
    layoutCalibMarkers();
    if (calibPts.length === 4) snapCorners();
  }
  // The fourth tap asks the engine to snap the corners onto the table's white border
  // (calib-refine.js); the snapped quad is drawn for the owner to confirm. A tap, drag or
  // undo after that invalidates a reply still in flight.
  let snapNote = null;
  let snapSeq = 0;
  function snapCorners() {
    const seq = ++snapSeq;
    snapNote = CALIB_SNAPPING;
    updateCalibGuide();
    const corners = calibPts.map((p) => screenToVideo(p));
    const done = (res) => {
      if (seq !== snapSeq || calibPts.length !== 4) return;
      if (res && res.ok) {
        calibPts = res.corners.map((c) => clampToVideo(videoToScreen(c)));
        snapNote = CALIB_SNAPPED;
        layoutCalibMarkers();
      } else {
        snapNote = CALIB_SNAP_FAILED;
        updateCalibGuide();
      }
    };
    if (H("onSnapCorners", corners, done) === undefined) done(null);
  }
  function dropSnap() {
    snapSeq++;
    snapNote = null;
  }
  function calibUndo() {
    if (!calibPts.length) return;
    dropSnap();
    calibPts.pop();
    const m = calibMarkers.pop();
    if (m) m.remove();
    layoutCalibMarkers();
  }
  function calibReset() {
    dropSnap();
    calibPts = [];
    calibMarkers.forEach((m) => m.remove());
    calibMarkers = [];
    drag = null;
    loupe.hidden = true;
    updateCalibGuide();
  }
  function calibConfirm() {
    if (calibPts.length < 4) return;
    const corners = calibPts.map((p) => {
      const v = screenToVideo(p);
      return { x: Math.max(0, Math.min(vidW || Infinity, v.x)), y: Math.max(0, Math.min(vidH || Infinity, v.y)) };
    });
    // A corner pinned to the frame edge means that end of the table is out of view (a phone
    // held too close or turned upright): refuse it rather than track on a guessed quad.
    const edge = Math.max(2, Math.min(vidW, vidH) * 0.005);
    if (vidW && vidH && corners.some((c) => c.x <= edge || c.y <= edge || c.x >= vidW - edge || c.y >= vidH - edge)) {
      dropSnap();
      snapNote = CALIB_EDGE;
      updateCalibGuide();
      return;
    }
    if (quadFraction(corners, vidW, vidH) < SMALL_TABLE.frac) notice("탁구대가 작아요, 가까이 오거나 가로로 세우면 자동 점수가 잘 돼요");
    calibReset();
    H("onCalibrationDone", corners);
  }
  function pointFromEvent(e) {
    return clampToVideo({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
  }
  // One pointer handler for the whole layer. A tap (press + release, < DRAG_PX of
  // movement) ALWAYS adds a point while fewer than 4 exist, even on top of an
  // existing marker: table corners can be ~25 CSS px apart on a phone. A marker is
  // dragged only when the pointer moves >= DRAG_PX after pressing on it.
  calibLayer.addEventListener("pointerdown", (e) => {
    if (drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    refreshStageRect();
    const marker = e.target.closest(".calib__pt");
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, idx: marker ? calibMarkers.indexOf(marker) : -1, moving: false };
    try { calibLayer.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  });
  calibLayer.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moving) {
      if (drag.idx < 0 || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      drag.moving = true;
      toggleClass(calibMarkers[drag.idx], "calib__pt--drag", true);
    }
    const p = pointFromEvent(e);
    if (snapNote) dropSnap();
    calibPts[drag.idx] = p;
    layoutCalibMarkers();
    drawLoupe(p);
  });
  function finishPress(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const press = drag;
    drag = null;
    try { calibLayer.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (press.moving) {
      const m = calibMarkers[press.idx];
      if (m) toggleClass(m, "calib__pt--drag", false);
      loupe.hidden = true;
      return;
    }
    if (e.type === "pointercancel") return;
    if (calibPts.length < 4) addCalibPoint(clampToVideo({ x: press.x - stageRect.left, y: press.y - stageRect.top }));
    else if (press.idx >= 0) calibMarkers[press.idx].focus({ preventScroll: true });
  }
  calibLayer.addEventListener("pointerup", finishPress);
  calibLayer.addEventListener("pointercancel", finishPress);
  function loupeSource() {
    if (video.readyState >= 2 && video.videoWidth) return video;
    if (video.poster) {
      if (!posterImg || posterImg.src !== video.poster) { posterImg = new Image(); posterImg.src = video.poster; }
      if (posterImg.complete && posterImg.naturalWidth) return posterImg;
    }
    return null;
  }
  function drawLoupe(p) {
    const src = loupeSource();
    if (!src || !fit.scale) { loupe.hidden = true; return; }
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(LOUPE_PX * dpr);
    if (loupe.width !== size) { loupe.width = size; loupe.height = size; }
    const lctx = loupe.getContext("2d");
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#000";
    lctx.fillRect(0, 0, size, size);
    const v = screenToVideo(p);
    const sw = (LOUPE_PX / LOUPE_ZOOM) / fit.scale;
    lctx.drawImage(src, v.x - sw / 2, v.y - sw / 2, sw, sw, 0, 0, size, size);
    lctx.strokeStyle = "rgba(255,211,77,0.9)";
    lctx.lineWidth = Math.max(1, dpr);
    lctx.beginPath();
    lctx.moveTo(size / 2, 0); lctx.lineTo(size / 2, size);
    lctx.moveTo(0, size / 2); lctx.lineTo(size, size / 2);
    lctx.stroke();
    loupe.style.left = `${p.x}px`;
    loupe.style.top = `${p.y}px`;
    loupe.hidden = false;
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (leaveResolve) { answerLeave(false); e.preventDefault(); }
    else if (settingsOpen) { closeSettings(); e.preventDefault(); }
    else if (sheetOpen) { H("onCloseHistory"); e.preventDefault(); }
    else if (currentMode === "calibrating") { calibReset(); H("onCalibrationCancel"); e.preventDefault(); }
  });

  // ---------- mode visibility (the hidden attribute wins over every layout rule) ----------
  function applyModeVisibility(mode) {
    const hudOn = mode === "ready" || mode === "running" || mode === "stopped";
    const calibOn = mode === "calibrating";
    hud.hidden = !hudOn;
    strip.hidden = !hudOn && !calibOn;
    bar.hidden = !hudOn;
    calibLayer.hidden = !calibOn;
    calibbar.hidden = !calibOn;
    screenIntro.hidden = mode !== "intro";
    screenLoading.hidden = mode !== "loading";
    screenError.hidden = mode !== "error";
    if (!hudOn) { closeSheet(); }
  }

  // ---------- render ----------
  let currentMode = "intro";
  let currentSource = null;
  let currentLayout = "phone";
  let courtSig = "";
  let runStartedAt = 0;
  let lastRallyActive = false;
  let lastPerfAt = -Infinity;
  let bannerIssue = null;
  let bannerAt = 0;

  function render(state) {
    if (toastEl.classList.contains("show")) queueMicrotask(placeToast);
    if (!state) return;
    keySet = !!(state.save && state.save.keySet);
    const hasPin = !!state.tour?.fix?.can;
    const saved = saveStatus(state.save, hasPin);
    const saveClass = (node) => {
      setText(node, node === chipSave ? saved.chip : saved.label);
      setAttr(node, "data-save-kind", saved.kind);
      toggleClass(node, "chip--lock", saved.kind === "on");
      toggleClass(node, "chip--warn", saved.kind === "bad");
    };
    saveClass(chipSave);
    saveClass(saveState);
    setAttr(chipSave, "title", `${saved.label}. ${saved.hint}`);
    setAttr(chipSave, "aria-label", saved.label);
    setText(introSave, saved.label);
    setAttr(introSave, "data-save-kind", saved.kind);
    // PC save off and no PIN here yet: the PIN box is on this screen, not behind the camera.
    const askSavePin = (saved.kind === "off" || saved.kind === "bad") && !hasPin && saved.chip !== "PC?" && state.save?.supported !== false;
    // Beside a tournament app the camera writes scores only with its PIN: without one the same box asks.
    const needPin = !hasPin && !!state.tour && state.tour.ws !== "none";
    const askPin = askSavePin || needPin;
    introPin.hidden = !askPin;
    introRetry.hidden = !hasPin || saved.kind === "on" || state.save?.supported === false;
    setText(introPrivacyText, saved.kind === "on"
      ? "끝난 랠리 구간 영상과 기록만 PC로 올라가요."
      : needPin ? `${NEED_PIN}${askSavePin ? ". PC 저장도 같이 켜져요" : ""}`
      : askPin ? saved.hint : `${saved.hint ? `${saved.hint}. ` : ""}영상은 폰 밖으로 나가지 않아요.`);
    const mode = state.mode || "intro";
    for (const button of app.querySelectorAll("[data-back]")) button.disabled = !!state.leaving;
    currentSource = state.source || null;
    if (mode !== currentMode) {
      if (currentMode === "calibrating" && mode !== "calibrating") calibReset();
      if (mode === "calibrating") { refreshStageRect(); updateCalibGuide(); }
      if (mode === "running" && currentMode !== "running") runStartedAt = performance.now();
      currentMode = mode;
      setAttr(app, "data-mode", mode);
      applyModeVisibility(mode);
      closeSettings();
      updateFitMode();
      measureStage();
    }
    if (mode === "calibrating") holdCalibrationFrame();
    const layout = state.layout === "tv" ? "tv" : "phone";
    if (layout !== currentLayout) {
      currentLayout = layout;
      setAttr(app, "data-layout", layout);
      invalidateHudTheme();
      updateFitMode();
      measureStage();
    }
    if (coverNow() !== (stage.getAttribute("data-video-fit") === "cover")) syncVideoFit();
    else setHidden(btnFit, fitMode !== "stack" || !["ready", "running", "stopped"].includes(currentMode));
    if (state.video) setVideoSize(state.video.width, state.video.height);
    else if (video.videoWidth) setVideoSize(video.videoWidth, video.videoHeight);

    if (mode === "loading") {
      setText(loadingText, state.loadingText || "준비하는 중…");
      const ld = state.loading;
      const sized = !!(ld && ld.phase === "download" && ld.total > 0);
      toggleClass(progressBar, "progress--busy", !sized);
      if (sized) {
        const pct = Math.min(100, Math.floor((ld.received / ld.total) * 100));
        progressFill.style.width = `${pct}%`;
        setAttr(progressBar, "aria-valuenow", String(pct));
        setText(progressCount, `${mb(ld.received)} / ${mb(ld.total)}MB · ${pct}%`);
      } else {
        progressFill.style.width = "";
        progressBar.removeAttribute("aria-valuenow");
        setText(progressCount, ld && ld.phase === "init" ? "다 받았어요. 준비 중…" : "");
      }
    }
    if (mode === "error") {
      const err = state.error || {};
      const sig = JSON.stringify([err.title, err.detail, err.steps]);
      if (sig !== errSig) {
        errSig = sig;
        setText(errTitle, err.title || "문제가 생겼어요");
        setText(errDetail, err.detail || "");
        errSteps.replaceChildren(...(err.steps || []).map((s) => el("li", {}, s)));
        errSteps.hidden = !(err.steps && err.steps.length);
        setText(errRetryLabel, currentSource === "file" ? "카메라 시작" : err.retry || "다시 시도");
      }
    }

    if (state.save && state.save.notice) {
      // The note sits under the buttons, below the fold on a phone; a new notice (setup link
      // traded or refused) must be seen without scrolling.
      if (state.save.notice !== shownNotice) {
        shownNotice = state.save.notice;
        setText(introNote, shownNotice);
        requestAnimationFrame(() => introNote.scrollIntoView({ block: "nearest" }));
      }
    } else if (state.estimateNote) setText(introNote, `${state.estimateNote}예요.`);

    const tv = state.tour || { matches: [] };
    if (tv.errorFresh && tv.error !== introNote.textContent) {
      setText(introNote, tv.error);
      requestAnimationFrame(() => introNote.scrollIntoView({ block: "nearest" }));
    }
    const linkText = tv.ws === "none" ? "대회 연결 없이 혼자 쓰는 중"
      : tv.ws === "offline" ? "대회 연결 끊김 · 다시 연결 중"
      : tv.needPick ? "설정에서 경기 선택"
      : !tv.connected ? (tv.ws === "online" ? NEED_PIN : "대회에 연결하는 중")
      : tv.match ? `대회 연결됨 · ${tv.match.no}경기 ${tv.match.names[0]} vs ${tv.match.names[1]}` : "대회 연결됨 · 칠 경기가 없어요";
    setText(chipLinkText, `카메라 · ${tv.ws === "none" ? "혼자" : tv.ws === "offline" ? "끊김" : tv.needPick ? "경기?" : !tv.connected ? "PIN 필요" : tv.match ? `${tv.match.no}경기` : "연결"}`);
    setAttr(chipLink, "title", linkText);
    toggleClass(chipLink, "chip--warn", tv.ws !== "none" && (tv.ws === "offline" || !!tv.needPick || !tv.connected));
    toggleClass(chipLink, "chip--lock", tv.ws !== "offline" && !!tv.connected && !tv.needPick);
    setText(introLink.lastChild, `카메라 · ${linkText}`);
    setHidden(tourForm, !!tv.connected);
    setHidden(tourLinked, !tv.connected);
    const sig = JSON.stringify([tv.matchId, tv.matches.map((m) => [m.id, m.no, m.names])]);
    if (sig !== tourSig) {
      tourSig = sig;
      tourMatch.replaceChildren(...(tv.matches.length
        ? tv.matches.map((m) => el("option", { value: m.id, selected: m.id === tv.matchId }, `${m.no}경기 · ${m.names[0]} vs ${m.names[1]}`))
        : [el("option", { value: "" }, "칠 경기가 없어요")]));
      if (tv.matches.length && !tv.matchId) tourMatch.prepend(el("option", { value: "", selected: true, disabled: true }, "어느 경기를 찍나요?"));
    }
    setSeg("카메라 앞쪽", tv.near);
    // each end keeps its colour: --c-me / --c-opp are the near / far END colours (blue or red)
    for (const [side, prop] of [["near", "--c-me"], ["far", "--c-opp"]]) {
      const p = state.players?.[side];
      if (!p) continue;
      setText(handPlate[side], p.label);
      setText(courtKey[side], SIDE_NAMES[p.end] || "");
      const c = p.end === 1 ? "var(--c-red)" : "var(--c-blue)";
      if (app.style.getPropertyValue(prop) !== c) app.style.setProperty(prop, c);
    }
    setSeg("자동 입력", tv.mode);
    setSeg("점수 음성", tv.voice !== false);
    const tm = tv.match;
    setText(tourStatus, tv.ws === "offline" ? "대회 연결 끊김 · 다시 연결되면 점수 자동 입력을 이어가요." : tv.error || (tv.connected
      ? (tm ? `앞쪽 ${state.players.near.label} · 건너편 ${state.players.far.label}. 포인트가 끝나면 점수가 자동으로 들어가요.` : tv.matches.length ? "점수를 넣을 경기를 골라 주세요." : "칠 경기가 없어요. 다음 대회를 기다려 주세요.")
      : tv.notice ? `${tv.notice} · ${NEED_PIN}` : `${NEED_PIN}. 대회 PIN을 넣으면 포인트마다 점수가 자동으로 들어가요.`));
    const pend = tv.pending;
    const showErr = !pend && tv.connected && tv.errorFresh;
    setHidden(pointbar, !(pend || showErr));
    // the 3 s cancel bar sits right under the top rows (back and chips, the record strip, the live chips),
    // never on them: pinned to the screen top it covered all three on a portrait phone (lead, 2026-10-31)
    if (pend || showErr) {
      const under = Math.max(0, ...[strip, glance, stageChips, btnFit].filter((n) => !n.closest("[hidden]") && n.offsetHeight && getComputedStyle(n).visibility !== "hidden").map((n) => n.getBoundingClientRect().bottom));
      pointbar.style.top = `${Math.round(under) + 8}px`;
    }
    toggleClass(pointbar, "pointbar--error", !!showErr);
    setHidden(pointCancel, !pend || !!pend.choice);
    setHidden(pointPicks, !(pend && pend.choice));
    const sus = pend && pend.suspect;
    setHidden(pointAsks, !sus);
    setHidden(askLet, !(sus && sus.let));
    setHidden(askFault, !(sus && sus.fault));
    toggleClass(pointbar, "pointbar--choice", !!(pend && (pend.choice || sus)));
    if (pend && pend.choice) {
      setText(pointText, `누가 땄나요? 판정이 확실하지 않아요 (${pend.reason})`);
      for (const [btn, side] of [[pickBlue, 0], [pickRed, 1]]) {
        const who = tm ? tm.names[tm.ends[side]] : "";
        const label = `${SIDE_NAMES[side]} 득점|${who}`;
        if (btn.dataset.label !== label) {
          btn.dataset.label = label;
          btn.replaceChildren(el("span", {}, `${SIDE_NAMES[side]} 득점`), ...(tm ? [el("small", {}, who)] : []));
        }
      }
    } else if (pend) {
      const score = pend.score ? ` ${pend.score[0]}:${pend.score[1]}${pend.gameEnded ? " 게임" : ""}` : "";
      setText(pointText, `${SIDE_NAMES[pend.end ?? pend.side]} ${pend.name} 득점 · ${pend.reason}${score}`);
      setText(pointCancel, `취소 ${Math.max(1, Math.ceil((pend.until - Date.now()) / 1000))}`);
    } else if (showErr) setText(pointText, `대회 연결: ${tv.error}`);

    // 점수 고치기 (PIN phone, linked, a match to fix; the camera keeps running under it)
    const fx = tv.fix || {};
    const fixT = fx.target;
    const canFix = !!(fx.can && tv.connected && fixT && (mode === "ready" || mode === "running" || mode === "stopped"));
    if (!canFix && fixOpen) toggleFix(false);
    setHidden(chipFix, !canFix);
    setHidden(fixPanel, !(canFix && fixOpen));
    if (canFix && fixOpen) {
      // portrait phone: the control bar is in the page flow, so sit right on its top edge and
      // cover the stats panels completely (the camera image stays in view above)
      const stack = app.dataset.fit === "stack";
      const b = stack ? `${Math.round(app.getBoundingClientRect().bottom - bar.getBoundingClientRect().top)}px` : "";
      if (fixPanel.style.bottom !== b) fixPanel.style.bottom = b;
      const s = fixT.score || { current: { a: 0, b: 0 }, won: [0, 0] };
      const done = fixT.status === "done";
      // the buttons and chips are in end colours: blue = whoever stands at the blue end now
      const ends = fixT.ends || [0, 1];
      const endOf = (slot) => (ends[0] === slot ? 0 : 1);
      const cur = [s.current.a, s.current.b];
      setText(fixScore, `${fixT.no}경기${done ? " 끝" : ""} · ${SIDE_NAMES[0]} ${cur[ends[0]]} : ${cur[ends[1]]} ${SIDE_NAMES[1]} · 게임 ${s.won[ends[0]]}:${s.won[ends[1]]}`);
      const busy = !!fx.busy;
      for (const b of fixPlus) b.disabled = busy || done;
      fixUndo.disabled = busy || !fixT.log.length;
      const n = fixT.log.length;
      const from = Math.max(0, n - 3);
      const sig = JSON.stringify([fixT.id, n, fixT.log.slice(from), busy, fixT.names, ends]);
      if (sig !== fixSig) {
        fixSig = sig;
        const chips = [];
        for (let i = from; i < n; i++) {
          const side = fixT.log[i];
          const end = endOf(side);
          const ago = n - 1 - i;
          chips.push(el("button", {
            class: `btn fix__point fix__point--${end ? "red" : "blue"}`, type: "button", "data-index": String(i), disabled: busy,
            "aria-label": `${ago ? `${ago}점 전` : "방금"} ${SIDE_NAMES[end]} ${fixT.names[side]} 득점, 눌러서 ${SIDE_NAMES[1 - end]} ${fixT.names[1 - side]} 득점으로`,
            onclick: () => H("onTourFix", "flip", i, side),
          }, el("small", {}, ago ? `${ago}점 전` : "방금"), el("span", {}, `${SIDE_NAMES[end]}→${SIDE_NAMES[1 - end]}`)));
        }
        fixRecent.replaceChildren(...(chips.length ? chips : [el("p", { class: "fix__empty" }, "아직 들어간 점수가 없어요")]));
      }
      setText(fixNote, busy ? "고치는 중… 카메라는 계속 찍어요" : tv.errorFresh ? `대회 연결: ${tv.error}` : "카메라는 계속 찍어요");
    }

    const hudVisible = mode === "ready" || mode === "running" || mode === "stopped";
    if (mode === "calibrating") setText(recText, "코트 보정");
    if (hudVisible) {
      const rally = state.rally || {};
      setText(timeNum, fmtRallyTime(rally.timeMs));
      setText(shotsNum, String(rally.shots ?? 0));
      setText(speedNum, fmtKmh(rally.speedKmh));
      const calibrated = !!state.calibration?.corners;

      // status strip (guideline 23): recording chip + tracking chip + perf
      const liveNow = mode === "running";
      toggleClass(chipRec, "chip--live", liveNow);
      setText(recText, liveNow ? `기록 중 ${fmtClock(performance.now() - runStartedAt)}` : mode === "stopped" ? "정지됨" : "준비됨");
      // state.tracking arrives from the engine; until it does, derive it from what is known
      const tracking = TRACKING[state.tracking] ? state.tracking : !calibrated ? "no-calibration" : state.ball?.lock ? "locked" : "searching";
      const track = TRACKING[tracking];
      setHidden(chipTrack, !(liveNow || track.kind === "warn"));
      setText(chipTrack, track.text);
      toggleClass(chipTrack, "chip--lock", track.kind === "lock");
      toggleClass(chipTrack, "chip--warn", track.kind === "warn");
      setHidden(chipSlow, !(liveNow && state.slowPhone));
      setHidden(chipStable, !(liveNow && state.stable?.compact));
      setAttr(app, "data-stable", liveNow && state.stable?.compact ? "1" : "0");
      setHidden(chipColor, !(liveNow && state.colorHint));
      toggleClass(chipFix, "chip--icon", !!(liveNow && state.colorHint));
      // a phone strip fits the colour hint or the PC save chip, not both; settings still shows PC save
      setHidden(chipSave, !!(liveNow && state.colorHint) && narrow.matches);
      // the hint and the PC save chip matter more than the fps readout; a phone strip has no room for it
      setHidden(chipPerf, !!(liveNow && state.colorHint) || narrow.matches);
      if (state.colorHint) setText(chipColor, state.colorHint);
      const now = performance.now();
      if (state.perf && now - lastPerfAt > 500) {
        lastPerfAt = now;
        setText(chipPerf, `${Math.round(state.perf.fps || 0)}fps ${Math.round(state.perf.ms || 0)}ms`);
      }
      // calibration issue (guideline 25): sentence in the banner, 코트 보정 button asks for the tap
      // the sentence shows for a few seconds when it appears, then only the chip and the gold
      // 코트 보정 button keep saying it, so the picture is not covered for the whole rally
      const issue = state.calibrationIssue || null;
      if (issue !== bannerIssue) { bannerIssue = issue; bannerAt = now; }
      setHidden(banner, !issue || now - bannerAt > BANNER_MS);
      if (issue) setText(bannerText, issue);
      toggleClass(btnCalib, "btn--attention", !!issue || track.kind === "warn");

      // players: MOVE shares one scale so the two bars compare; 손목 is the wrist bend in degrees
      const moveMax = Math.max(state.players?.near?.moveM || 0, state.players?.far?.moveM || 0);
      const moveScale = Math.max(MOVE_SCALE_M, Math.ceil(moveMax / MOVE_SCALE_M) * MOVE_SCALE_M);
      for (const side of ["near", "far"]) {
        const p = state.players?.[side] || {};
        const r = playerRows[side];
        setText(r.name, p.label);
        setHidden(r.off, !p.offscreen);
        setText(r.moveNum, fmtMeters(p.moveM));
        setStyleVar(r.moveFill, "--pct", pct((p.moveM || 0) / moveScale));
        setText(r.wristNum, fmtDeg(p.wristDeg));
        setStyleVar(r.wristFill, "--pct", pct((p.wristDeg || 0) / WRIST_SCALE_DEG));
        setText(r.shotNum, fmtKmh(p.shotKmh));
        setStyleVar(r.shotFill, "--pct", pct((p.shotKmh || 0) / SHOT_SCALE_KMH));
      }

      // court map
      const bounces = state.bounces || [];
      const last = bounces[bounces.length - 1];
      const stands = { near: state.players?.near?.stand || null, far: state.players?.far?.stand || null };
      const standSig = ["near", "far"].map((s) => { const st = stands[s]; return st ? `${st.x.toFixed(2)},${st.y.toFixed(2)},${st.stale ? 1 : 0}` : "-"; }).join("/");
      const sig = `${calibrated}|${bounces.length}|${last ? `${last.tx},${last.ty},${last.side}` : ""}|${standSig}`;
      if (sig !== courtSig) {
        courtSig = sig;
        courtSvgWrap.innerHTML = courtSvg(bounces, calibrated, false, stands);
        courtHint.hidden = calibrated;
        for (const s of ["near", "far"]) {
          const st = stands[s];
          setText(standDist[s], st ? (st.behindM >= 0.05 ? `${st.behindM.toFixed(1)}m` : "옆") : "");
          toggleClass(standDist[s], "court__dist--stale", !!(st && st.stale));
        }
      }
      setText(courtCount, `바운드 ${bounces.length}회`);

      // rally-end announcement (guideline 44: one live region, once per rally)
      const active = !!rally.active;
      if (lastRallyActive && !active && mode === "running") {
        setText(live, `랠리 종료. ${rally.shots ?? 0}샷, 최고 ${fmtKmh(rally.maxSpeedKmh)} km/h`);
      }
      lastRallyActive = active;

      // control bar
      const running = mode === "running";
      setText(toggleLabel, running ? "정지" : "카메라 시작");
      const want = running ? "stop" : "play";
      if (toggleIcon._n !== want) { toggleIcon._n = want; toggleIcon.innerHTML = iconSvg(want); }
      setAttr(btnToggle, "aria-pressed", running ? "true" : "false");
      if (state.players) {
        setSeg("앞쪽 라켓 손", state.players.near?.hand || "R");
        setSeg("건너편 라켓 손", state.players.far?.hand || "R");
      }
      if (state.layoutPref && state.layoutPref !== layoutPref) { layoutPref = state.layoutPref; setSeg("화면", layoutPref); }
      setSeg("끝 뒤 카메라", state.endOnCubic ? "on" : "off");
      setSeg("판정용 영상", state.analysisFrom || "screen");
      setSeg("판정 안정 모드", state.stableMode === "off" ? "off" : "auto");
      setSeg("다시 보기 오버레이", state.replayOverlay === false ? "off" : "on");
      setSeg("공 색", state.ballColor === "orange" ? "orange" : "white");
      const save = state.save || {};
      setText(keyStatus, save.keyError || saved.hint);
      setText(privacyNote, saved.kind === "on" ? "랠리 구간 영상만 PC로 올라가고, 그 밖의 카메라 영상은 폰 밖으로 안 나가요. 속도·거리는 추정치예요." : `${saved.hint} · 영상은 폰 밖으로 나가지 않아요. 속도·거리는 화면 기반 추정치예요.`);
    }

    btnHistory.disabled = sheetOpen;
    syncBackNames();
    // overlay canvas
    if (hudVisible || mode === "calibrating") {
      if (!stageW) measureStage();
      ensureOverlaySize();
      let drawn = null;
      if (mode === "calibrating") {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (state.calibration?.corners && !calibPts.length) drawn = drawHud(ctx, { ...state, players: null, ball: null, lastShot: null }, videoToScreen);
      } else {
        const stageRect = stage.getBoundingClientRect();
        // labels start under the top rows, and under a notice while one shows (it sits right below them)
        const covered = [glance, strip, banner, stageChips, btnFit, ...(toastEl.classList.contains("show") ? [toastEl] : [])].filter((n) => !n.closest("[hidden]")).map((n) => n.getBoundingClientRect().bottom - stageRect.top);
        const barRect = bar.getBoundingClientRect();
        const barOverlapsRight = !bar.closest("[hidden]") && barRect.left > stageRect.left + stageRect.width / 2 && barRect.top < stageRect.bottom;
        // labels stay above whatever floats along the bottom edge (fold chip, players, control bar)
        const low = [dock, bottom, bar, fixPanel].filter((n) => !n.closest("[hidden]") && n.offsetHeight)
          .map((n) => n.getBoundingClientRect().top - stageRect.top).filter((y) => y > stageRect.height / 2);
        // panels and buttons over the picture (players, court, bar, fold chip, the 채움 switch, the 3 s
        // cancel / 누가 땄나요 bar while it shows): labels keep off them, and a standing mark under one is left out
        const avoid = [players, court, bar, dock, btnFit, pointbar].filter((n) => !n.closest("[hidden]")).map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.left - stageRect.left, y: r.top - stageRect.top, w: r.width, h: r.height };
        }).filter((r) => r.w > 0 && r.x < stageRect.width && r.y < stageRect.height && r.x + r.w > 0 && r.y + r.h > 0);
        drawn = drawHud(ctx, state, videoToScreen, {
          top: Math.max(4, ...covered.filter((b) => b > 0 && b < stageRect.height).map((b) => b + 4)),
          right: barOverlapsRight ? barRect.left - stageRect.left - 4 : Infinity,
          bottom: Math.min(stageRect.height, ...low) - 4,
          avoid,
        });
      }
      // QA-observable facts about the last frame: is a LOCK box on screen, which canvas font sizes
      setAttr(overlay, "data-lock", drawn && drawn.lock ? "1" : "0");
      if (drawn) { setAttr(overlay, "data-fonts", drawn.fonts); setAttr(overlay, "data-font", drawn.font); }
      setAttr(overlay, "data-stands", drawn && drawn.stands ? Object.entries(drawn.stands).map(([s, r]) => `${s}:${r.hidden ? "panel" : r.label}${r.stale ? "~" : ""}`).join("|") : "");
    }

    // history sheet
    if (state.showHistory) {
      openSheet();
      renderHistory(state.history || []);
      const log = (state.stable?.log || []).slice(-3).reverse();
      setHidden(stableNote, !log.length);
      setText(stableNote, log.map((e) => `${fmtTimeOfDay(e.at)} 판정 안정 모드 → ${e.what} (분석 ${e.fps}fps${e.basePct != null ? `, 처음의 ${e.basePct}%` : ""}, 반복 ${e.repeatPct}%)`).join(" · "));
    }
    else closeSheet();
  }

  applyModeVisibility(currentMode);
  measureStage();
  updateCalibGuide();

  return { video, render, videoToScreen, screenToVideo, back, confirmLeave, notice };
}
