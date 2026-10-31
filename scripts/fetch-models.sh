#!/usr/bin/env bash
set -euo pipefail
# shasum (perl, on macOS and most Linux) when present: recent macOS also ships a BSD sha256sum that
# rejects --status. Otherwise GNU sha256sum.
if command -v shasum >/dev/null 2>&1; then sha256sum() { shasum -a 256 "$@"; }; fi
mkdir -p "$(dirname "$0")/../public/models"
cd "$(dirname "$0")/../public/models"

fetch() {
  local name="$1" url="$2" sum="$3"
  if [[ ! -f "$name" ]] || ! echo "$sum  $name" | sha256sum -c --status; then
    curl -sSfL -o "$name.part" "$url"
    mv "$name.part" "$name"
  fi
  echo "$sum  $name" | sha256sum -c
}

fetch_zip_onnx() {
  local name="$1" url="$2" sum="$3"
  if [[ -f "$name" ]] && echo "$sum  $name" | sha256sum -c --status; then
    echo "$sum  $name" | sha256sum -c
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  curl -sSfL -o "$tmp/m.zip" "$url"
  unzip -q -o "$tmp/m.zip" -d "$tmp"
  cp "$(find "$tmp" -name end2end.onnx | head -1)" "$name"
  rm -rf "$tmp"
  echo "$sum  $name" | sha256sum -c
}

fetch pose_landmarker_lite.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a
fetch pose_landmarker_full.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task 4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad
fetch_zip_onnx rtmpose-s.onnx https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip 9aeb635b83f86aea45cf45d85798f7eba1a162de8e0d721c44e54fe5eebaf47d
fetch_zip_onnx rtmpose-t.onnx https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-t_simcc-body7_pt-body7_420e-256x192-026a1439_20230504.zip a6c2f6a3896a4d51131d14d7a80a3d08b50f559af5a58a45d5b098aef510a70f
