#!/usr/bin/env bash
# One-time setup on your PC (Linux, macOS, or Windows through WSL). Safe to run again.
#   bash install.sh
# 1. checks the tools it needs (bun, git, curl, unzip, sha256sum or shasum)
# 2. bun install, then the pose models into public/models/ (sha256-checked)
# 3. writes your settings file from deploy.env.example if you have none yet
# 4. starts the server once on 127.0.0.1 and checks /healthz answers 200, then stops it
# 5. tells you the next step: start.sh (Linux, systemd) or a manual start plus tailscale serve
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
DEPLOY_ENV="${PPV_DEPLOY_ENV:-$HOME/.config/pingpong-vision/deploy.env}"
say() { printf '\n== %s\n' "$*"; }

say "1/4 tools"
missing=0
need() {
  if command -v "$1" >/dev/null 2>&1; then printf '  ok  %s\n' "$1"; else printf '  MISSING  %s: %s\n' "$1" "$2"; missing=1; fi
}
need bun "curl -fsSL https://bun.sh/install | bash   (then open a new terminal)"
need git "install git from your package manager"
need curl "install curl from your package manager"
need unzip "install unzip from your package manager"
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
  echo "  ok  sha256sum/shasum"
else
  echo "  MISSING  sha256sum: install coreutils"; missing=1
fi
[[ "$missing" == 0 ]] || { echo; echo "Install what is missing above, then run: bash install.sh"; exit 1; }

say "2/4 dependencies and pose models"
bun install
bash scripts/fetch-models.sh

say "3/4 settings: $DEPLOY_ENV"
if [[ -f "$DEPLOY_ENV" ]]; then
  echo "  kept your existing file"
else
  mkdir -p "$(dirname "$DEPLOY_ENV")"
  install -m 600 deploy.env.example "$DEPLOY_ENV"
  echo "  created from deploy.env.example (edit it if port 8791 is taken)"
fi
# shellcheck disable=SC1090
source "$DEPLOY_ENV"
PORT="${PORT:-8791}"

say "4/4 test run on http://127.0.0.1:${PORT}/vision/"
if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "  something already answers on port ${PORT} (the app's service, or another program)."
  echo "  If it is not this app, set another PORT in $DEPLOY_ENV and run bash install.sh again."
else
  LOG="$(mktemp)"
  PORT="$PORT" bun server.js >"$LOG" 2>&1 &
  pid=$!
  ok=0
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then ok=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [[ "$ok" == 1 ]]; then
    echo "  /healthz 200: the server works."
    rm -f "$LOG"
  else
    echo "  the server did not answer. Its output:"; sed 's/^/    /' "$LOG"; rm -f "$LOG"; exit 1
  fi
fi

say "next"
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "  Tailscale is installed and logged in."
else
  echo "  Tailscale is not installed or not logged in on this PC: https://tailscale.com/download"
  echo "  (Windows with WSL: install Tailscale on Windows itself, not inside WSL.)"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "  Start it and keep it running after reboots:   ./start.sh"
else
  echo "  Start it:   bun server.js"
  echo "  Then, in a second terminal:"
  echo "    tailscale serve --bg --https=${FUNNEL_PORT:-443} --set-path=/vision http://127.0.0.1:${PORT}/vision"
fi
echo "  Then open https://<your PC's Tailscale name>/vision/ on your phone (README: Install on your PC)."
