// ui.js - createUI(root, handlers) for pingpong-vision (contract: docs/contract.md)
// Screens: intro / loading / error / HUD (ready, running, stopped) / calibrating,
// plus the history sheet and the settings popover. render(state) is called every
// frame: DOM text is diffed, the overlay canvas is redrawn through hud.js.
// Layout fit (data-fit on .app): "stack" on a portrait phone (glance / strip / stage /
// players + court / bar in flow, nothing over the video), "overlay" elsewhere.
import { drawHud, invalidateHudTheme } from "./hud.js";
import { SIDE_NAMES } from "./tournament.js";

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
  locked: { text: "LOCK", kind: "lock" },
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

// One SVG icon set: 24px grid, 2px round stroke (guideline 18).
const ICONS = {
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  calibrate: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 9v6M9 12h6"/>',
  swap: '<path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  settings: '<path d="M4 7h8M18 7h2M4 17h4M14 17h6"/><circle cx="15" cy="7" r="2.5"/><circle cx="11" cy="17" r="2.5"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  file: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.5"/>',
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
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

/** Court map SVG markup: table seen from above, MY end on the left. */
function courtSvg(bounces, calibrated, small) {
  const W = TABLE_L * 100, H = TABLE_W * 100;
  const pad = small ? 10 : 14;
  const parts = [
    `<svg class="court__svg" viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" role="img" aria-label="바운드 위치 ${bounces.length}개">`,
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
  parts.push("</svg>");
  return parts.join("");
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
  const stage = el("div", { class: "stage" }, video, overlay, calibLayer);

  // ---------- HUD ----------
  const timeNum = el("span", { class: "num" }, "00:00.00");
  const shotsNum = el("span", { class: "num" }, "0");
  const speedNum = el("span", { class: "num" }, "--");
  const glance = el("header", { class: "glance", "aria-label": "랠리 요약" },
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "RALLY TIME"), el("div", { class: "panel__value" }, timeNum)),
    el("div", { class: "panel panel--glance" }, el("div", { class: "panel__label" }, "RALLY COUNT"), el("div", { class: "panel__value" }, shotsNum, el("span", { class: "unit" }, "SHOT"))),
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
  const strip = el("div", { class: "strip", role: "status", "aria-live": "off" }, chipRec, chipTrack, chipPerf);
  // calibration issue banner: the engine's sentence (state.calibrationIssue), shown only while set
  const bannerText = el("span", {}, "");
  const banner = el("div", { class: "banner", role: "status", hidden: true }, icon("warn"), bannerText);

  const playerRows = {};
  function playerBlock(side) {
    const cls = side === "near" ? "me" : "opp";
    const name = el("span", { class: `plate plate--${cls}` }, side === "near" ? "앞쪽(나)" : "건너편(상대)");
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
  const courtCount = el("span", { class: "court__count" }, "B#0");
  const court = el("section", { class: "panel court", "aria-label": "바운드 위치" },
    el("div", { class: "court__head" }, el("span", { class: "court__title" }, "COURT MAP"), el("span", { class: "court__sub" }, "바운드 위치")),
    courtBox,
    el("div", { class: "court__foot" },
      el("span", { class: "court__key c-me" }, el("i", { class: "swatch swatch--me", "aria-hidden": "true" }), "나"),
      courtCount,
      el("span", { class: "court__key c-opp" }, "상대", el("i", { class: "swatch swatch--opp", "aria-hidden": "true" }))),
  );
  const bottom = el("div", { class: "bottom" }, players, court);
  const live = el("div", { class: "visually-hidden", "aria-live": "polite" });
  const hud = el("div", { class: "hud" }, glance, strip, banner, bottom, live);

  // ---------- control bar ----------
  const toggleIcon = icon("play");
  const toggleLabel = el("span", {}, "시작");
  const btnToggle = el("button", { class: "btn btn--bar btn--primary", type: "button", onclick: () => (currentMode === "running" ? H("onStop") : H("onStartCamera")) }, toggleIcon, toggleLabel);
  const btnCalib = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onBeginCalibration"); } }, icon("calibrate"), el("span", {}, "코트 보정"));
  const btnSwap = el("button", { class: "btn btn--bar", type: "button", onclick: () => H("onSwapPlayers") }, icon("swap"), el("span", {}, "선수 바꾸기"));
  const btnHistory = el("button", { class: "btn btn--bar", type: "button", onclick: () => { closeSettings(); H("onOpenHistory"); } }, icon("history"), el("span", {}, "기록"));
  const btnSettings = el("button", { class: "btn btn--bar", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => toggleSettings() }, icon("settings"), el("span", {}, "설정"));
  const bar = el("nav", { class: "bar", "aria-label": "조작" }, btnToggle, btnCalib, btnSwap, btnHistory, btnSettings);

  // ---------- point entered in the tournament app: 3 s to cancel ----------
  const pointText = el("span", { class: "pointbar__text" }, "");
  const pointCancel = el("button", { class: "btn btn--danger pointbar__cancel", type: "button", onclick: () => H("onTourCancel") }, "취소");
  const pickBlue = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--blue", type: "button", onclick: () => H("onTourPick", 0) }, "블루 득점");
  const pickRed = el("button", { class: "btn btn--big pointbar__pick pointbar__pick--red", type: "button", onclick: () => H("onTourPick", 1) }, "레드 득점");
  const pointPicks = el("div", { class: "pointbar__picks", hidden: true }, pickBlue, pickRed);
  const pointbar = el("div", { class: "pointbar", role: "status", "aria-live": "polite", hidden: true }, pointText, pointCancel, pointPicks);

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
  const privacyNote = el("p", { class: "screen__note" }, "");
  const tourPin = el("input", { type: "password", name: "tournament-pin", inputmode: "numeric", autocomplete: "off", "aria-label": "대회 앱 PIN", placeholder: "대회 앱 PIN" });
  const tourForm = el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); H("onTourConnect", tourPin.value); tourPin.value = ""; } },
    tourPin, el("button", { class: "btn", type: "submit" }, "연결"));
  const tourMatch = el("select", { class: "select", "aria-label": "점수를 넣을 경기", onchange: (e) => H("onTourMatch", e.target.value) });
  const tourLinked = el("div", { class: "tourlink", hidden: true },
    tourMatch,
    seg("앞쪽(나) 색", [[0, "앞쪽 블루"], [1, "앞쪽 레드"]], (v) => H("onTourNear", v)),
    seg("자동 입력", [["sure", "확실할 때만"], ["all", "모든 포인트 자동"]], (v) => H("onTourMode", v)),
    el("button", { class: "btn", type: "button", onclick: () => H("onTourDisconnect") }, "연동 끄기"));
  const tourStatus = el("p", { class: "screen__note", role: "status" }, "");
  let tourSig = "";
  const popover = el("div", { class: "popover", role: "dialog", "aria-label": "설정", hidden: true },
    el("h2", { class: "popover__title" }, "설정", btnSettingsClose),
    el("div", { class: "field" }, el("div", { class: "field__label" }, el("span", { class: "plate plate--me" }, "앞쪽(나)"), el("span", { class: "unit" }, "라켓 손")),
      seg("앞쪽(나) 라켓 손", [["R", "오른손"], ["L", "왼손"]], (v) => H("onSetHand", "near", v))),
    el("div", { class: "field" }, el("div", { class: "field__label" }, el("span", { class: "plate plate--opp" }, "건너편(상대)"), el("span", { class: "unit" }, "라켓 손")),
      seg("건너편(상대) 라켓 손", [["R", "오른손"], ["L", "왼손"]], (v) => H("onSetHand", "far", v))),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "화면")),
      seg("화면", [["auto", "자동"], ["phone", "폰"], ["tv", "큰 화면(TV)"]], (v) => { layoutPref = v; setSeg("화면", v); H("onSetLayout", v); })),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "PC 저장 열쇠")),
      el("form", { class: "keyform", onsubmit: (e) => { e.preventDefault(); H("onSetUploadKey", keyInput.value); keyInput.value = ""; } },
        keyInput, el("button", { class: "btn", type: "submit" }, "열쇠 저장")),
      keyStatus),
    el("div", { class: "field field--wide" }, el("div", { class: "field__label" }, el("span", {}, "대회 앱 점수 연동")),
      tourForm, tourLinked, tourStatus),
    privacyNote,
  );
  setSeg("화면", layoutPref);

  let settingsOpen = false;
  function onDocPointer(e) {
    if (!popover.contains(e.target) && !btnSettings.contains(e.target)) closeSettings();
  }
  function openSettings() {
    if (settingsOpen) return;
    settingsOpen = true;
    popover.hidden = false;
    setAttr(btnSettings, "aria-expanded", "true");
    document.addEventListener("pointerdown", onDocPointer, true);
    btnSettingsClose.focus({ preventScroll: true });
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    popover.hidden = true;
    setAttr(btnSettings, "aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    if (document.activeElement && popover.contains(document.activeElement)) btnSettings.focus({ preventScroll: true });
  }
  function toggleSettings() { settingsOpen ? closeSettings() : openSettings(); }

  // ---------- history sheet ----------
  const rallyList = el("ul", { class: "rally-list" });
  const sheetBody = el("div", { class: "sheet__body" }, rallyList);
  const btnClear = el("button", { class: "btn", type: "button", onclick: () => showClearConfirm(true) }, icon("trash"), el("span", {}, "비우기"));
  const btnSheetClose = el("button", { class: "btn btn--primary", type: "button", onclick: () => H("onCloseHistory") }, "닫기");
  const footNormal = el("div", { class: "sheet__foot" }, btnClear, btnSheetClose);
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
  function renderHistory(list) {
    const sig = list.map((r) => `${r.id}:${r.shots}:${r.bounces?.length || 0}:${r.upload?.status || ""}:${r.upload?.error || ""}`).join("|");
    if (sig === historySig) return;
    historySig = sig;
    rallyList.replaceChildren();
    if (!list.length) {
      rallyList.append(el("li", {}, el("p", { class: "empty" }, "아직 기록이 없어요. 시작을 누르고 랠리를 해보세요.")));
      btnClear.disabled = true;
      return;
    }
    btnClear.disabled = false;
    const items = [...list].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const r of items) {
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
    btnSheetClose.focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    backdrop.hidden = true;
    sheet.hidden = true;
    historySig = "";
    btnHistory.focus({ preventScroll: true });
  }

  // ---------- screens ----------
  function fileButton(label) {
    const input = el("input", { type: "file", accept: "video/*", "aria-label": label, onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) H("onOpenFile", f); e.target.value = ""; } });
    return el("label", { class: "btn btn--block btn--file" }, icon("file"), el("span", {}, label), input);
  }
  const introNote = el("p", { class: "screen__note", role: "status" }, "속도·거리는 화면 기반 추정치예요.");
  let shownNotice = null;
  const introPrivacy = el("span", {}, "영상은 폰 밖으로 나가지 않아요. 분석은 전부 이 폰 안에서 끝나고, 어디에도 올리지 않아요.");
  const screenIntro = el("div", { class: "screen screen--intro" }, el("div", { class: "screen__inner" },
    el("p", { class: "brand" }, "PINGPONG VISION"),
    el("h1", { class: "screen__title" }, "탁구 랠리를 폰 카메라로 분석해요"),
    el("ul", { class: "screen__list" },
      el("li", {}, "삼각대에 폰을 세우고 탁구대를 비추면 랠리 시간, 샷 수, 샷 속도를 보여줘요."),
      el("li", {}, "두 선수의 자세와 공 궤적, 바운드 위치를 화면 위에 그려요."),
      el("li", {}, "처음 한 번 탁구대 모서리 4곳을 눌러 코트를 보정해요.")),
    el("p", { class: "screen__privacy" }, icon("shield"), introPrivacy),
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("camera"), el("span", {}, "카메라 시작")),
      fileButton("영상 파일로 시험")),
    introNote));

  const loadingText = el("p", { class: "screen__title", role: "status" }, "준비하는 중…");
  const screenLoading = el("div", { class: "screen screen--loading" }, el("div", { class: "screen__inner" },
    el("p", { class: "brand" }, "PINGPONG VISION"),
    loadingText,
    el("div", { class: "progress", role: "progressbar", "aria-label": "불러오는 중" }, el("div", { class: "progress__fill" })),
    el("p", { class: "screen__note" }, "자세 인식 모델은 처음 열 때 한 번만 받아요.")));

  const errTitle = el("h1", { class: "screen__title" }, "문제가 생겼어요");
  const errDetail = el("p", { class: "screen__text" }, "");
  const errSteps = el("ol", { class: "screen__list" });
  const screenError = el("div", { class: "screen screen--error", role: "alertdialog", "aria-labelledby": "ppv-err-title" }, el("div", { class: "screen__inner" },
    el("p", { class: "brand" }, "PINGPONG VISION"),
    errTitle, errDetail, errSteps,
    el("div", { class: "screen__actions" },
      el("button", { class: "btn btn--primary btn--big btn--block", type: "button", onclick: () => H("onStartCamera") }, icon("restart"), el("span", {}, "다시 시도")),
      fileButton("영상 파일로 시험"))));
  errTitle.id = "ppv-err-title";
  let errSig = "";

  // ---------- calibration bar ----------
  const calibStep = el("span", { class: "calibbar__step" }, "1/4");
  const calibText = el("p", { class: "calibbar__text" }, CALIB_STEPS[0]);
  const calibDots = el("div", { class: "calibbar__dots", "aria-hidden": "true" }, ...[0, 1, 2, 3].map(() => el("i")));
  const calibHint = el("p", { class: "calibbar__hint" }, "가로로 돌리면 더 정확해요");
  const btnUndo = el("button", { class: "btn", type: "button", onclick: () => calibUndo() }, icon("undo"), el("span", {}, "되돌리기"));
  const btnRestart = el("button", { class: "btn", type: "button", onclick: () => calibReset() }, icon("restart"), el("span", {}, "다시"));
  const btnCancel = el("button", { class: "btn", type: "button", onclick: () => { calibReset(); H("onCalibrationCancel"); } }, icon("close"), el("span", {}, "취소"));
  const btnConfirm = el("button", { class: "btn btn--primary", type: "button", disabled: true, onclick: () => calibConfirm() }, icon("check"), el("span", {}, "확인"));
  const calibbar = el("div", { class: "calibbar" },
    el("div", { class: "calibbar__guide", role: "status", "aria-live": "polite" }, calibStep, calibText, calibDots, calibHint),
    el("div", { class: "calibbar__actions" }, btnUndo, btnRestart, btnCancel, btnConfirm));

  // ---------- assemble ----------
  const app = el("div", { class: "app", "data-mode": "intro", "data-layout": "phone", "data-fit": "stack" },
    stage, hud, pointbar, bar, popover, calibbar, backdrop, sheet, screenIntro, screenLoading, screenError);
  root.replaceChildren(app);

  // ---------- geometry: video px <-> CSS px of the overlay (object-fit: contain) ----------
  let stageW = 0, stageH = 0, vidW = 0, vidH = 0;
  let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  function updateFit() {
    if (!stageW || !stageH || !vidW || !vidH) { fit = { x: 0, y: 0, w: stageW, h: stageH, scale: 1 }; return; }
    const s = Math.min(stageW / vidW, stageH / vidH);
    const w = vidW * s, h = vidH * s;
    fit = { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h, scale: s };
  }
  function setVideoSize(w, h) {
    if (w > 0 && h > 0 && (w !== vidW || h !== vidH)) { vidW = w; vidH = h; updateFit(); updateFitMode(); }
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
  // "stack": portrait phone, whatever the video's aspect ratio. Glance row, status strip, stage,
  //          players + court and the control bar are grid rows inside the visible viewport, so
  //          no panel ever covers the picture (a portrait camera stream included).
  // "overlay": landscape phone and tv. The stage fills the screen; panels sit on its edges.
  function updateFitMode() {
    const portrait = app.clientWidth < app.clientHeight;
    const want = currentLayout === "phone" && portrait ? "stack" : "overlay";
    if (want !== fitMode) { fitMode = want; setAttr(app, "data-fit", want); }
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
    setText(calibText, n >= 4 ? CALIB_DONE : CALIB_STEPS[n]);
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
      calibPts[idx] = clampToVideo({ x: calibPts[idx].x + d[0], y: calibPts[idx].y + d[1] });
      layoutCalibMarkers();
    });
    calibMarkers.push(marker);
    calibLayer.append(marker);
    layoutCalibMarkers();
  }
  function calibUndo() {
    if (!calibPts.length) return;
    calibPts.pop();
    const m = calibMarkers.pop();
    if (m) m.remove();
    layoutCalibMarkers();
  }
  function calibReset() {
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
    if (settingsOpen) { closeSettings(); e.preventDefault(); }
    else if (sheetOpen) { H("onCloseHistory"); e.preventDefault(); }
    else if (currentMode === "calibrating") { calibReset(); H("onCalibrationCancel"); e.preventDefault(); }
  });

  // ---------- mode visibility (the hidden attribute wins over every layout rule) ----------
  function applyModeVisibility(mode) {
    const hudOn = mode === "ready" || mode === "running" || mode === "stopped";
    const calibOn = mode === "calibrating";
    hud.hidden = !hudOn;
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

  function render(state) {
    setText(introPrivacy, state.save && state.save.keySet
      ? "분석은 전부 이 폰 안에서 끝나요. PC 저장이 켜져 있어서, 끝난 랠리 구간 영상과 기록만 저장 PC로 올라가요."
      : "영상은 폰 밖으로 나가지 않아요. 분석은 전부 이 폰 안에서 끝나고, 어디에도 올리지 않아요.");
    if (!state) return;
    const mode = state.mode || "intro";
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
    if (state.video) setVideoSize(state.video.width, state.video.height);
    else if (video.videoWidth) setVideoSize(video.videoWidth, video.videoHeight);

    if (mode === "loading") setText(loadingText, state.loadingText || "준비하는 중…");
    if (mode === "error") {
      const err = state.error || {};
      const sig = JSON.stringify([err.title, err.detail, err.steps]);
      if (sig !== errSig) {
        errSig = sig;
        setText(errTitle, err.title || "문제가 생겼어요");
        setText(errDetail, err.detail || "");
        errSteps.replaceChildren(...(err.steps || []).map((s) => el("li", {}, s)));
        errSteps.hidden = !(err.steps && err.steps.length);
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
    setHidden(tourForm, !!tv.connected);
    setHidden(tourLinked, !tv.connected);
    const sig = JSON.stringify([tv.matchId, tv.matches.map((m) => [m.id, m.no, m.names])]);
    if (sig !== tourSig) {
      tourSig = sig;
      tourMatch.replaceChildren(...(tv.matches.length
        ? tv.matches.map((m) => el("option", { value: m.id, selected: m.id === tv.matchId }, `${m.no}경기 · ${m.names[0]} vs ${m.names[1]}`))
        : [el("option", { value: "" }, "칠 경기가 없어요")]));
    }
    setSeg("앞쪽(나) 색", tv.near);
    setSeg("자동 입력", tv.mode);
    const tm = tv.match;
    setText(tourStatus, tv.error || (tv.connected
      ? (tm ? `앞쪽 ${SIDE_NAMES[tv.near]} ${tm.names[tv.near]} · 건너편 ${SIDE_NAMES[1 - tv.near]} ${tm.names[1 - tv.near]}. 포인트가 끝나면 점수가 자동으로 들어가요.` : "점수를 넣을 경기를 골라 주세요.")
      : (tv.notice || "대회 앱 PIN을 넣으면 포인트마다 점수가 자동으로 들어가요.")));
    const pend = tv.pending;
    const showErr = !pend && tv.connected && tv.errorFresh;
    setHidden(pointbar, !(pend || showErr));
    toggleClass(pointbar, "pointbar--error", !!showErr);
    setHidden(pointCancel, !pend || !!pend.choice);
    setHidden(pointPicks, !(pend && pend.choice));
    toggleClass(pointbar, "pointbar--choice", !!(pend && pend.choice));
    if (pend && pend.choice) {
      setText(pointText, `누가 땄나요? 판정이 확실하지 않아요 (${pend.reason})`);
      for (const [btn, side] of [[pickBlue, 0], [pickRed, 1]]) {
        const label = `${SIDE_NAMES[side]} 득점|${tm ? tm.names[side] : ""}`;
        if (btn.dataset.label !== label) {
          btn.dataset.label = label;
          btn.replaceChildren(el("span", {}, `${SIDE_NAMES[side]} 득점`), ...(tm ? [el("small", {}, tm.names[side])] : []));
        }
      }
    } else if (pend) {
      const score = pend.score ? ` ${pend.score[0]}:${pend.score[1]}${pend.gameEnded ? " 게임" : ""}` : "";
      setText(pointText, `${SIDE_NAMES[pend.side]} ${pend.name} 득점 · ${pend.reason}${score}`);
      setText(pointCancel, `취소 ${Math.max(1, Math.ceil((pend.until - Date.now()) / 1000))}`);
    } else if (showErr) setText(pointText, `대회 앱: ${tv.error}`);

    const hudVisible = mode === "ready" || mode === "running" || mode === "stopped";
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
      const now = performance.now();
      if (state.perf && now - lastPerfAt > 500) {
        lastPerfAt = now;
        setText(chipPerf, `${Math.round(state.perf.fps || 0)}fps ${Math.round(state.perf.ms || 0)}ms`);
      }
      // calibration issue (guideline 25): sentence in the banner, 코트 보정 button asks for the tap
      const issue = state.calibrationIssue || null;
      setHidden(banner, !issue);
      if (issue) setText(bannerText, issue);
      toggleClass(btnCalib, "btn--attention", !!issue || track.kind === "warn");

      // players: MOVE shares one scale so the two bars compare; 손목 is the wrist bend in degrees
      const moveMax = Math.max(state.players?.near?.moveM || 0, state.players?.far?.moveM || 0);
      const moveScale = Math.max(MOVE_SCALE_M, Math.ceil(moveMax / MOVE_SCALE_M) * MOVE_SCALE_M);
      for (const side of ["near", "far"]) {
        const p = state.players?.[side] || {};
        const r = playerRows[side];
        setText(r.name, p.label || (side === "near" ? "앞쪽(나)" : "건너편(상대)"));
        setHidden(r.off, !!p.landmarks);
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
      const sig = `${calibrated}|${bounces.length}|${last ? `${last.tx},${last.ty},${last.side}` : ""}`;
      if (sig !== courtSig) {
        courtSig = sig;
        courtSvgWrap.innerHTML = courtSvg(bounces, calibrated, false);
        courtHint.hidden = calibrated;
      }
      setText(courtCount, `B#${bounces.length}`);

      // rally-end announcement (guideline 44: one live region, once per rally)
      const active = !!rally.active;
      if (lastRallyActive && !active && mode === "running") {
        setText(live, `랠리 종료. ${rally.shots ?? 0}샷, 최고 ${fmtKmh(rally.maxSpeedKmh)} km/h`);
      }
      lastRallyActive = active;

      // control bar
      const running = mode === "running";
      setText(toggleLabel, running ? "정지" : "시작");
      const want = running ? "stop" : "play";
      if (toggleIcon._n !== want) { toggleIcon._n = want; toggleIcon.innerHTML = iconSvg(want); }
      setAttr(btnToggle, "aria-pressed", running ? "true" : "false");
      if (state.players) {
        setSeg("앞쪽(나) 라켓 손", state.players.near?.hand || "R");
        setSeg("건너편(상대) 라켓 손", state.players.far?.hand || "R");
      }
      if (state.layoutPref && state.layoutPref !== layoutPref) { layoutPref = state.layoutPref; setSeg("화면", layoutPref); }
      const save = state.save || {};
      setText(keyStatus, save.keyError ? save.keyError : save.keySet ? (save.supported === false ? "열쇠는 맞지만 이 브라우저는 영상 녹화가 안 돼요" : "저장 켜짐: 랜리가 끝나면 그 구간만 PC로 올려요") : "열쇠를 넣으면 랜리 기록과 랜리 구간 영상을 PC에 저장해요");
      setText(privacyNote, save.keySet ? "랜리 구간 영상만 PC로 올라가고, 그 밖의 카메라 영상은 폰 밖으로 안 나가요. 속도·거리는 추정치예요." : "영상은 폰 밖으로 나가지 않아요. 속도·거리는 화면 기반 추정치예요.");
    }

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
        const covered = [glance, strip, banner].filter((n) => !n.closest("[hidden]")).map((n) => n.getBoundingClientRect().bottom - stageRect.top);
        const barRect = bar.getBoundingClientRect();
        const barOverlapsRight = !bar.closest("[hidden]") && barRect.left > stageRect.left + stageRect.width / 2 && barRect.top < stageRect.bottom;
        drawn = drawHud(ctx, state, videoToScreen, {
          top: Math.max(4, ...covered.filter((b) => b > 0 && b < stageRect.height).map((b) => b + 4)),
          right: barOverlapsRight ? barRect.left - stageRect.left - 4 : Infinity,
        });
      }
      // QA-observable facts about the last frame: is a LOCK box on screen, which canvas font sizes
      setAttr(overlay, "data-lock", drawn && drawn.lock ? "1" : "0");
      if (drawn) { setAttr(overlay, "data-fonts", drawn.fonts); setAttr(overlay, "data-font", drawn.font); }
    }

    // history sheet
    if (state.showHistory) { openSheet(); renderHistory(state.history || []); }
    else closeSheet();
  }

  applyModeVisibility(currentMode);
  measureStage();
  updateCalibGuide();

  return { video, render, videoToScreen, screenToVideo };
}
