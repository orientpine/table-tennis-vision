# UI Guidelines: PingPong Vision (iPhone Safari, tripod camera + pixel-art fighting-game HUD)

Universal interface rules distilled from Apple's Human Interface Guidelines (Apple-only details removed; source pages listed at the end), written so each one can be checked from a screenshot or a DOM measurement. `qa/ui-r2.mjs` measures the starred items (`*`) on the real app in four viewports; before/after measurements are retained with the test results.

Viewing context: the phone sits on a tripod 2 to 4 m away, it is glanced at between points, hands are sweaty, the UI text is Korean, and Safari's address bar and bottom toolbar eat about 190 px of a 393x852 screen (visible height about 659 px).

Design system: `public/style.css` header (tokens, type scale, fit modes). Theme: arcade fighting-game HUD - square panels with a 2 px light frame, dark inner bevel and a hard 3 px drop shadow; HP-bar meters; VS name plates; one accent (orange) for the primary action and the calibration call to action; gold for speed and LOCK. No borrowed art.

Layout: HUD portrait phone - top row / fluid video / bottom row / control bar must all fit the visible viewport without covering the video -> bounded shell with a non-scrolling fluid middle (grid rows auto auto auto minmax(0,1fr) auto auto auto, height 100dvh); scroll owner: none (the app shell never scrolls; `.sheet__body`, `.popover` and `.screen` own their own scroll); anti-patterns: absolute panels overlaying the stage, 100vh, measured heights pushed through CSS variables.

## A. Checklist

### Layout and safe areas

1. `*` **Tap targets are big.** Every tappable control is >= 44x44 CSS px; primary controls (start/stop) >= 60x60. Check: `getBoundingClientRect()` on every visible `button, [role=button], input, label`.
   A double tap never zooms the page and two fingers still do (owner Q407): `* { touch-action: manipulation }` in style.css, no `maximum-scale` or `user-scalable=no` in the viewport; only the calibration layer keeps `none`. Check: `qa/no-dbltap-zoom.mjs` (every element, `touchAuto` in `qa/theme-audit.mjs`).
2. `*` **Spacing between targets.** Adjacent controls, and a field and its button, have >= 8 CSS px between them; the target is 12 (--sp-3), 8 (--sp-2) only in dense rows that must fit 360 px. `qa/theme-audit.mjs` counts pairs under 8 px across the whole page (`gaps=`). Fields compute to >= 16 px (`inputSmall=`). Long lists fold: `qa/list-fold.mjs`.
3. **Nothing under the home indicator or notch.** Controls and HUD text sit inside `env(safe-area-inset-*)` in both orientations; `viewport-fit=cover`.
4. `*` **The picture fills the screen; panels float on it, slim.** Owner 2026-10-30: "세로모드도 가로모드처럼 영상 전체 위에 오버레이", then "가로모드도 정리해줘 오버레이 요소가 너무커서 화면이 안보여". Every layout shows the picture full-screen with translucent panels on its edges: the glance is one thin row, a calibration warning sentence shows for 6 s then only its chip and the gold 코트 보정 button keep it, players + court map fold into one chip (a tap opens them for a look between points; they start folded on every visit and fold again when the next rally starts, because open they cover part of the table on a phone), control buttons are see-through. Portrait = `data-fit="stack"`: the panels are grid rows over the picture (z -1), the middle row is an open window. Check (`qa/overlay-layout.mjs`, Chromium): portrait picture >= 95 % of the screen with every panel on it, landscape >= 80 % of the picture uncovered, 0 points of the calibrated table under a panel, and while calibrating no panel over the picture (portrait) or a tap spot (all).
5. `*` **Everything fits the VISIBLE viewport.** The shell is `100dvh` (never `100vh`) so it tracks Safari's bars; measured at 393x852 and 393x659. Check: no element outside the viewport, no horizontal overflow, no panel overlapping another panel, in 393x852, 393x659, 852x393 and 1920x1080.
6. **Primary actions where a thumb reaches.** Start/stop and calibrate sit on the bottom edge (portrait, tv) or the right edge (landscape).
7. **Toolbar stays small.** At most 5 controls in the live bar; everything else lives in the settings popover or the history sheet.

### Readability at 2 to 4 m

8. **Glance numbers are the largest thing on screen.** RALLY TIME / RALLY COUNT / SHOT SPEED render at 24 px on a portrait phone (three panels across 393 px), 36 px landscape, 72 px tv; everything else is 12 or 20 px. The tv layout is the from-the-couch mode; the phone is read up close between points.
9. **HUD contrast over camera video.** HUD text sits on a navy panel (0.7 alpha, `--c-panel`) and reaches >= 4.5:1; bright values carry a 1 px hard text shadow.
10. **One pixel family, readable Hangul.** Galmuri (bundled, OFL) everywhere: Galmuri11 for labels, numbers and titles, Galmuri9 at 20 px for Korean sentences and buttons with a 28 px line height. Nothing below 12 px.
11. `*` **Bitmap fonts only on their integer grid.** Galmuri11's em is 12 px, Galmuri9's is 10 px (100 font units per bitmap pixel), so sizes are 12 / 24 / 36 / 48 / 72 and 20 / 40 - never rem, never a fraction. The 11 / 18.33 / 33 px sizes of the first build put 2.75 or 8.25 device pixels under each bitmap pixel and smeared every glyph on a 3x iPhone. Check: every rendered `font-size` is a multiple of its face's em; canvas text uses the same sizes (`data-fonts` on the overlay).
12. **Few sizes and weights.** The running HUD uses 12 and 24 px (36/72 for the glance in landscape/tv) in regular and bold; dialogs add 20 px.
13. **Units always shown.** km/h, m, degrees ("35°"), and rally time as 00:12.40. SHOT SPEED carries "추정".

### Color, dark style, icons

14. **Never color alone.** Each end has a colour AND a name plate ("블루 · <player>" linked, "블루 사이드" alone); the court-map legend pairs a swatch with 블루 / 레드; the LOCK box says LOCK.
15. **Color means one thing.** blue / red = the table's blue / red end (fixed; the players move between them, as on the tournament cards), orange = the primary action and the calibration call to action, gold = speed / LOCK / VS, red = recording / destructive. No coloured side stripes, no accent outlines as decoration.
16. **Dark by design.** The app is dark because it sits over video; `color-scheme: dark` is declared.
17. **Icons have labels.** Every bar button shows an icon and a Korean label; icon-only buttons (close) carry `aria-label`.
18. **Icon style is consistent.** One SVG set, 24 px grid, 2 px square-capped strokes.
19. `*` **Crisp pixels on a 3x screen.** The overlay canvas backing store is CSS px x devicePixelRatio, boxes and text land on integer CSS px, line widths are 1 or 2 px, `image-rendering: pixelated` on scaled bitmaps (loupe), and the bitmap-font grid of item 11.

### One app, way back, labels (2026-10-30)

39. `*` **A way back on every screen.** A 44 px back at the top left on every camera screen (start, loading, error, HUD, calibration) and every tournament screen; the browser's back does the same. Back closes what is open first (settings, history, 점수 고치기, calibration), then leaves. Check: `qa/back-nav.mjs`.
40. **Leaving asks only when it loses something.** One confirm while recording, none otherwise. Leaving stops the camera, waits for rally uploads and score writes (at most 8 s), then opens 모드 고르기.
41. `*` **The mode and the screen are always named.** Violet 카메라, gold 심판, green 관전, each with its name; the screen name beside the back (`[data-screen-name]`). Check: `qa/theme-audit.mjs`.
42. `*` **One-line labels fit.** No button, chip or tab label is clipped, wrapped, or within 2 px of its frame, on four device shapes. Check: `qa/theme-audit.mjs` column 글자 안 맞음.
43. `*` **Every press does something.** Each button is either a change, a dialog, already selected, or visibly disabled. Check: `qa/every-button.mjs`.
44. **Portrait strip wraps.** A second strip row costs no picture (the 16:9 video has bands above and below); a chip is never cut off.

### Motion and feedback

20. **Reduce motion is honored.** Under `prefers-reduced-motion: reduce` animations collapse to 0 s; data (trail, meters) still shows.
21. **No flashing.** Nothing flashes more than 3 times per second.
22. **Every tap gets feedback.** Buttons press in (2 px translate, shadow collapses); a calibration tap drops a numbered marker in the same frame.
23. **Recording state is unmistakable.** Status strip: red square + 기록 중 mm:ss while running; 정지됨 / 준비됨 otherwise.
24. **Loading is shown.** Model loading shows text and a striped progress bar.
25. `*` **Tracking problems are explained in place.** The strip's tracking chip says 코트 보정 필요 / 탁구대 안 보임 / 폰 흔들림 (orange) / 공 찾는 중 / LOCK (gold); a calibration issue sentence appears as a gold-framed banner and the 코트 보정 button takes the gold frame until it is fixed. No modal.

### Privacy and permissions

26. **Camera asked only after an explanation and a tap.** 27. **Denied permission has recovery steps.** 28. **State where data goes** ("영상은 폰 밖으로 나가지 않아요" on the intro and in settings). Unchanged from the first build.

### Modality, alerts, controls

29. **Few alerts** (inline confirm for 비우기 only). 30. **Destructive actions are confirmable.** 31. **Sheets with a clear exit** (닫기 + X >= 44 px). 32. **No modal over live tracking** except the user-opened settings popover. 33. **Segmented controls** for hand and screen choice (equal widths, check glyph + wash for the selected one). 34. **Toggles apply at once.** 35. **Settings fit one screen.**

### Full screen and video

36. **Controls are always reachable** (the bar never auto-hides). 37. **Screen stays awake** (Wake Lock while running). 38. **Review shows familiar data** (history rows: time, length, shots, top speed, mini court map).

### Writing and onboarding

39. **Short, plain Korean** (button labels <= 6 Hangul; no jargon). 40. **Same word for the same thing** (보정, 기록, 시작/정지). 41. **Onboarding is one screen.** 42. **Calibration guides one step at a time** (which corner next, numbered markers, 되돌리기 / 다시, drag with a loupe). 43. **Restore state on relaunch** (calibration, hands, history in localStorage). 44. **Screen readers get the summary** (one `aria-live` region, rally end only).

### Added in r2 (mobile-device feedback)

45. `*` **The LOCK box exists only while the engine is locked.** Gold bracket corners on the ball plus "LOCK <side>" / "~27 km/h" appear from `state.ball.lock` only and vanish the frame it becomes null; the status chip says LOCK at the same time. Check: `data-lock` on the overlay equals `!!state.ball.lock` in every running sample, plus an isolated `drawHud` call with and without a lock.
46. **Movement is visible per player.** MOVE is an HP-style bar with the metres beside it; both players' bars share one scale (6 m, growing in 6 m steps with the leader) so they compare at a glance; VS sits between the two blocks.
47. **Portrait camera streams are first-class.** `getUserMedia` on an iPhone in portrait returns 720x1280; it fills the portrait screen (cover by default, the 맞춤/채움 switch shows it whole). Checked with a 720x1280 test clip as well as the 1280x720 clip.
48. `*` **Values are computed, never fixtures.** Every captured number comes from the real app processing the clip (fps > 0, live rally time / trail / skeleton); local QA fixtures are not shipped in the public repo and are never used for measurement.

## B. Persona and user journey

**Persona: 민수, 41, amateur club player and the app's owner.** Plays twice a week at a local 탁구장, intermediate level, curious about his speed and footwork. He sets his iPhone on a small tripod beside the table, 2 to 4 m away, often in portrait at home (720x1280 camera) and in landscape at the club. Between points he glances over for 1 to 2 seconds, sweating, sometimes holding a racket. Reads Korean, grew up on arcade fighting games, and will give up if setup takes more than a minute.

| Step | What he does | What could feel broken |
|---|---|---|
| 1. Setup on tripod | Opens the URL in Safari, mounts the phone | Safari bars hide the control bar; panels sit on top of the picture; text looks smeared |
| 2. Permission | Reads why the camera is needed, taps to allow | Denial leads to a black screen; unclear whether video is uploaded |
| 3. Calibrate | Taps the 4 table corners on a still frame | Not told which corner is next; the video keeps playing under the taps; markers too small |
| 4. Play | Taps start, plays, glances between points | Cannot tell whether the ball is locked or the app is guessing; panels cover the table; numbers too small or blurry |
| 5. Problem | Table out of frame, phone bumped | A silent HUD that invents shots instead of saying 탁구대 안 보임 / 폰 흔들림 and asking for 코트 보정 |
| 6. Stop and review | Taps stop, opens 기록 | Stop button too small or next to delete; history gone after reload |

## Fetched URLs

Apple HIG pages read for the first build (through `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`): accessibility, color, dark-mode, layout, typography, motion, privacy, writing, images, icons, onboarding, launching, loading, feedback, modality, settings, going-full-screen, live-viewing-apps, playing-video, buttons, toolbars, sheets, alerts, progress-indicators, segmented-controls, toggles, labels, designing-for-ios - all under `https://developer.apple.com/design/human-interface-guidelines/`.
