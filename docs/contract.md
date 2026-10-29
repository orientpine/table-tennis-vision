# App module contract (UI <-> pipeline)

Plain ES modules under `public/js/`, no build step, no external network. Served at `/vision/` (all URLs RELATIVE, never absolute `/...`).

## Files and owners
- `public/index.html`, `public/style.css`, `public/js/ui.js`, `public/js/hud.js`, `public/fonts/*`, `public/icons/*`, `public/manifest.webmanifest`, `qa/ui-r2.mjs`, `docs/ui-guidelines.md` - UI (visual-engineering).
- `public/js/app.js` (glue/state), `public/js/pose.js`, `public/js/ball.js`, `public/js/rally.js`, `public/js/players.js`, `public/js/geom.js`, `public/js/pipeline.js`, `public/sw.js`, `server.js` - pipeline (lead).
- `qa/demo-state.js`, `qa/demo.html`, `qa/ui-demo.js`, `qa/fixtures/*.jpg`, and `public/bench/frame.jpg` are local-only QA fixtures and are not shipped in the public repo. The design fixture is served only when `PPV_QA=1` (the server maps `/vision/qa/*` to `qa/*`). Screens used for measurement come from the real app computing values from a clip (`qa/ui-webkit.mjs`, `qa/ui-r2.mjs`).

## ui.js
```js
export function createUI(root, handlers) -> {
  video: HTMLVideoElement,          // UI creates it: playsinline muted autoplay; app sets srcObject/src
  render(state),                    // called every frame (cheap: diff DOM text, redraw overlay canvas)
  videoToScreen(pt) -> {x,y},       // video px -> CSS px of overlay
  screenToVideo(pt) -> {x,y},
}
handlers = {
  onStartCamera(), onOpenFile(File), onStop(),
  onBeginCalibration(), onCalibrationDone(corners /* 4 video-px points in tap order */), onCalibrationCancel(),
  onSwapPlayers(), onSetHand(side /*'near'|'far'*/, hand /*'R'|'L'*/),
  onOpenHistory(), onCloseHistory(), onClearHistory(),
  onSetLayout(layout /* 'auto'|'phone'|'tv' */),
}
```
Calibration tap order (guide text must say this): 1-2 = the two corners of MY end line (앞쪽/나), 3-4 = the two corners of the OPPONENT end line. Points draggable before 확인; 다시 to restart. While `mode === 'calibrating'` and `source === 'file'` the UI keeps its `<video>` paused (WebKit can resume a paused element by itself when a seek queued before the pause completes), so the taps always land on a still frame.

Layout fit (`data-fit` on `.app`, chosen by ui.js from `layout` and the viewport):
- `stack` - phone in portrait, whatever the video's aspect ratio: glance row / status strip / issue banner / stage / players + court / control bar / calibration bar are grid rows inside the visible viewport (`100dvh`, safe-area insets). No panel ever covers the picture; the video is `object-fit: contain` inside the leftover row.
- `overlay` - phone in landscape and `tv`: the stage fills the screen and the panels sit on its edges (landscape keeps the right-edge control column free of video).

## hud.js
`drawHud(ctx, state, toScreen, {top, right})` draws on the overlay canvas (backing store = CSS px x devicePixelRatio, text at integer CSS px and at the pixel font's integer sizes `--fs-hud-label` / `--fs-hud-value`): skeletons (near = cyan, far = green), foot ellipse, name plate above the head, table polygon when calibrated, the locked-ball trail, the LOCK target (gold bracket corners on `state.ball.lock` plus a label box "LOCK <side>" / "~27 km/h" when `speedKmh` is known), shot label above the hitter ("포핸드 드라이브 ~27km"). The LOCK target is drawn from `state.ball.lock` ONLY: when it is null nothing LOCK-shaped is on screen; an unlocked `ball.current` is a 4 px white square. It returns `{ lock: rect|null, tags, fonts: "12,24", font: "Galmuri11" }`; ui.js mirrors that onto the canvas as `data-lock="1"|"0"`, `data-fonts`, `data-font` so QA can read what the last frame drew.

## State (produced by app.js each frame; all coords video px unless noted)
```js
{
  mode: 'intro'|'loading'|'ready'|'running'|'stopped'|'calibrating'|'error',
  layout: 'phone'|'tv',            // tv = big-screen landscape layout for iPad + TV mirroring
  source: 'camera'|'file'|null,
  loadingText: string|null,
  error: null | { title, detail, steps: string[] },
  perf: { fps: number, ms: number, poseMs: number, ballMs: number },
  video: { width, height },        // a portrait camera stream is 720x1280; a clip may be 1280x720
  calibration: null | { corners: [{x,y},{x,y},{x,y},{x,y}] },  // tap order
  tracking: 'no-calibration'|'no-table'|'unstable'|'searching'|'locked',
  calibrationIssue: string|null,   // Korean sentence while tracking is 'no-table' or 'unstable', e.g. "탁구대가 안 보여요. 코트 보정으로 탁구대 네 모서리를 맞춰 주세요"
  rally: { active: bool, timeMs: number, shots: number, speedKmh: number|null, maxSpeedKmh: number|null },
  ball: {
    trail: [{x,y,t}],              // locked-ball points only
    current: {x,y}|null,           // the locked ball, else null
    lock: null | { x, y, id, speedKmh: number|null, side: 'near'|'far'|null },  // non-null exactly while a flight is locked
  },
  bounces: [{ tx, ty, side: 'near'|'far', t }],   // current rally; table meters: tx 0..2.74 from MY end, ty 0..1.525
  lastShot: null | { side: 'near'|'far', stroke: '포핸드'|'백핸드', kind: '드라이브'|'스매시'|'로빙'|'푸시'|'서브', label: string, speedKmh: number|null, at: {x,y}, t },
  players: {
    near: { label: '앞쪽(나)', hand: 'R'|'L', landmarks: null | [{x,y,v}] /* 33 MediaPipe */,
            moveM: number|null,    // metres moved this session from both feet on the floor, table coordinates; null until calibrated -> "--"
            wristDeg: number|null, // wrist bend in degrees, 0 = straight forearm-to-hand; null = low confidence -> "--"
            wristKmh: number|null, shotKmh: number|null },
    far:  { label: '건너편(상대)', ... },
  },
  history: [{ id, startedAt /* epoch ms */, durationMs, shots, maxSpeedKmh, bounces: [{tx,ty,side}] }],
  showHistory: bool,
  estimateNote: '속도·거리는 화면 기반 추정치',
}
```
Speeds are estimates: always prefixed "~" and the HUD shows "추정" next to SHOT SPEED.

How the UI renders the tracking fields (all defensive: a missing field falls back to what calibration and `ball.lock` imply):
- status strip chip per `tracking`: `no-calibration` 코트 보정 필요, `no-table` 탁구대 안 보임, `unstable` 폰 흔들림 (orange), `searching` 공 찾는 중 (neutral), `locked` LOCK (gold). The chip shows while running, and in ready/stopped only for the orange states.
- `calibrationIssue` non-null: a gold-framed banner with the sentence under the strip, and the 코트 보정 bar button takes the gold "attention" frame (also while `tracking` is any orange state).
- players panel rows: MOVE (m, HP-style bar; both bars share one scale that grows in 6 m steps with the leader), 손목 (`wristDeg` as "35°", bar full at 90°), SHOT (km/h, bar full at 60).
