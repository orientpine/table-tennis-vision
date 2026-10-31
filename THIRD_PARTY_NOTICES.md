# Third-party notices

The code in this repository is MIT licensed (see `LICENSE`). It ships or serves the
following third-party components under their own licenses.

| Component | Where | License | Notes |
|---|---|---|---|
| Galmuri fonts 2.40.3 (Galmuri11, Galmuri11-Bold, Galmuri9), (c) Lee Minseo | `public/fonts/*.woff2` (bundled) | SIL Open Font License 1.1 | Full text: `public/fonts/LICENSE-Galmuri-OFL.txt`. The fonts are unmodified copies from the `galmuri` npm package. |
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 1.2.0), (c) Google LLC | npm dependency; `server.js` serves its JS bundle and WASM to the browser under `/vision/vendor/mediapipe/` | Apache License 2.0 | Full text: `LICENSES/Apache-2.0.txt`. Modification: `server.js` serves `vision_bundle.mjs` with the usage-logger `flush()` turned into a no-op so the browser does not send timing stats to Google. |
| MediaPipe Pose Landmarker models (`pose_landmarker_lite.task`, `pose_landmarker_full.task`), (c) Google LLC | downloaded by `scripts/fetch-models.sh`, not committed | Apache License 2.0 | Model card: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker |
| ONNX Runtime Web (`onnxruntime-web` 1.31.1), (c) Microsoft Corporation | npm dependency; served under `/vision/vendor/ort/` for the pose benchmark page | MIT | https://github.com/microsoft/onnxruntime/blob/main/LICENSE |
| RTMPose-t / RTMPose-s ONNX models (OpenMMLab MMPose) | downloaded by `scripts/fetch-models.sh`, not committed; used only by `bench.html` | Apache License 2.0 | https://github.com/open-mmlab/mmpose |

## Data not included

- **OpenTTGames** (https://lab.osai.ai/, by OSAI) is licensed CC BY-NC-SA 4.0. No videos or
  annotations from it are in this repository. The README explains how to download it for the
  accuracy harness.

## Images under a different license

The images in `docs/img/` (`hero.gif`, `portrait-running.png`, `calibrate.png`, `history.png`,
`tv-running.png`, `social-preview.png`) are screen captures of this app running on frames of the
OpenTTGames `test_2` video. They are adapted from that dataset (cropped, scaled, the app's overlay
drawn on top) and are therefore licensed under **CC BY-NC-SA 4.0**
(https://creativecommons.org/licenses/by-nc-sa/4.0/), **not** under the MIT license that covers the
code. Attribution: OpenTTGames dataset, OSAI, https://lab.osai.ai/ (Voeikov, Falaleev, Baikulov,
"TTNet: Real-time temporal and spatial video analysis of table tennis", CVPR Workshops 2020).
Non-commercial use only for these images; replace them if you need a commercial build.
