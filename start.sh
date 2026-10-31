#!/usr/bin/env bash
# Runs the static app as a systemd user service and mounts it at /vision on a Tailscale Funnel
# port. It only adds the /vision path mapping and never touches "/" of that port, so another
# app can keep the root. Host-specific values (FUNNEL_PORT, PORT, PPV_TOURNAMENT_URL) live outside
# the repo in ${PPV_DEPLOY_ENV:-~/.config/pingpong-vision/deploy.env}, e.g.:
#   FUNNEL_PORT=443
#   PORT=8791
#   PPV_TOURNAMENT_URL=http://127.0.0.1:<scoreboard port>   # PIN check for PC save; "off" turns it off
#   PPV_TS_MODE=serve                                       # serve (tailnet only) or funnel (default)
#   ./start.sh            start (idempotent)
#   ./start.sh --restart  deploy the checkout's committed HEAD and restart (URL unchanged)
# The service never reads this checkout: each deploy copies the committed HEAD (git archive)
# into releases/<sha> under DEPLOY_ROOT and points current at it, so editing files or switching
# branches here changes nothing live until the next deploy. Uncommitted edits are never deployed.
# Roll back: ln -sfn releases/<old sha> "$DEPLOY_ROOT/current" && systemctl --user restart pingpong-vision
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ENV="${PPV_DEPLOY_ENV:-$HOME/.config/pingpong-vision/deploy.env}"
for tool in systemctl tailscale; do
  command -v "$tool" >/dev/null || { echo "start.sh needs $tool (Linux with systemd and Tailscale). Otherwise run bun server.js and tailscale serve by hand (README: Install on your PC)." >&2; exit 1; }
done
# shellcheck disable=SC1090
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
# Checked before anything is copied or switched. No default: the scoreboard app's address differs per host.
PPV_TOURNAMENT_URL="${PPV_TOURNAMENT_URL:?set PPV_TOURNAMENT_URL (the scoreboard app that checks the PIN for PC save, e.g. http://127.0.0.1:<port>, or off) in $DEPLOY_ENV or the environment}"
[[ "$PPV_TOURNAMENT_URL" == off ]] && PPV_TOURNAMENT_URL=""
# serve: only your tailnet's devices can open it; funnel: anyone with the link.
TS_MODE="${PPV_TS_MODE:-funnel}"
[[ "$TS_MODE" == serve || "$TS_MODE" == funnel ]] || { echo "PPV_TS_MODE must be serve or funnel, not $TS_MODE" >&2; exit 2; }
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/.local/share/pingpong-vision}"
REV="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
REL="$DEPLOY_ROOT/releases/$REV"
if [[ ! -f "$REL/server.js" ]]; then
  rm -rf "$REL.tmp" && mkdir -p "$REL.tmp"
  git -C "$ROOT" archive HEAD | tar -x -C "$REL.tmp"
  # Dependencies and the gitignored pose models: hard links, so a later bun install or model
  # fetch in the checkout does not change the running release.
  cp -al "$ROOT/node_modules" "$REL.tmp/node_modules"
  mkdir -p "$REL.tmp/public/models"
  for f in "$ROOT"/public/models/*.task "$ROOT"/public/models/*.onnx; do [[ -e "$f" ]] && cp -al "$f" "$REL.tmp/public/models/"; done
  # The bench still frame is a dataset frame kept out of the public repo (.gitignore).
  if [[ -e "$ROOT/public/bench/frame.jpg" && ! -e "$REL.tmp/public/bench/frame.jpg" ]]; then
    mkdir -p "$REL.tmp/public/bench" && cp -al "$ROOT/public/bench/frame.jpg" "$REL.tmp/public/bench/"
  fi
  mv "$REL.tmp" "$REL"
fi
ln -sfn "releases/$REV" "$DEPLOY_ROOT/current.tmp" && mv -T "$DEPLOY_ROOT/current.tmp" "$DEPLOY_ROOT/current"
# Keep the five newest releases besides the current one.
ls -1dt "$DEPLOY_ROOT"/releases/*/ 2>/dev/null | tail -n +6 | while read -r old; do [[ "$(readlink -f "$old")" != "$(readlink -f "$DEPLOY_ROOT/current")" ]] && rm -rf "$old"; done
PORT="${PORT:-8791}"
# No default: Funnel ports are shared per host, so the wrong guess could expose another app.
FUNNEL_PORT="${FUNNEL_PORT:?set FUNNEL_PORT (443, 8443 or 10000) in $DEPLOY_ENV or the environment}"
MOUNT="/vision"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/pingpong-vision.service" <<EOF
[Unit]
Description=Pingpong vision web app (port ${PORT})
After=network-online.target

[Service]
WorkingDirectory=${DEPLOY_ROOT}/current
Environment=PORT=${PORT}
Environment=PPV_TOURNAMENT_URL=${PPV_TOURNAMENT_URL}
ExecStart=${BUN} ${DEPLOY_ROOT}/current/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable pingpong-vision.service >/dev/null 2>&1
echo "release: $REV ($REL)"
if [[ "${1:-}" == "--restart" ]]; then
  systemctl --user restart pingpong-vision.service
else
  systemctl --user start pingpong-vision.service
fi

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null || { echo "app did not start: journalctl --user -u pingpong-vision -n 50" >&2; exit 1; }

tailscale "$TS_MODE" --bg --https="${FUNNEL_PORT}" --set-path="${MOUNT}" "http://127.0.0.1:${PORT}${MOUNT}" >/dev/null
DNS="$(tailscale status --json | "$BUN" -e 'const j=await Bun.stdin.json();console.log(j.Self.DNSName.replace(/\.$/,""))')"
URL="https://${DNS}:${FUNNEL_PORT}${MOUNT}/"
printf '%s\n' "$URL" > "$ROOT/public-url.txt"
echo "URL: $URL"
echo "undo: tailscale ${TS_MODE} --https=${FUNNEL_PORT} --set-path=${MOUNT} off ; systemctl --user disable --now pingpong-vision"
