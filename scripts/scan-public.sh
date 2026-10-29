#!/usr/bin/env bash
# Leak check for a tree that is about to be (or already is) public.
#   scripts/scan-public.sh <dir> [--git]
# Runs gitleaks (dir mode, or git-history mode with --git) and a regex sweep over every text
# file, this script included: private IPs, keys and tokens, e-mail addresses, the local upload
# key / setup link, forbidden paths, plus host-specific patterns (host, account and tailnet
# names, people's names) read from a local file that is never committed:
#   ${PPV_SCAN_PATTERNS:-~/.config/pingpong-vision/scan-patterns}, one PCRE per line.
# Prints one count per check and exits 1 if any count is not 0.
set -uo pipefail

DIR="${1:?usage: scan-public.sh <dir> [--git]}"
MODE="${2:-}"
DIR="$(cd "$DIR" && pwd)"
PATTERNS="${PPV_SCAN_PATTERNS:-$HOME/.config/pingpong-vision/scan-patterns}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

count() {
  local n
  n=$(grep -c . "$2" 2>/dev/null || true)
  printf '%-22s %s\n' "$1" "${n:-0}"
  if [[ "${n:-0}" != 0 ]]; then sed 's/^/    /' "$2" | head -20; fail=1; fi
}

if command -v gitleaks >/dev/null; then
  if [[ "$MODE" == "--git" ]]; then
    gitleaks git "$DIR" --no-banner --redact --report-format json --report-path "$TMP/gl.json" >/dev/null 2>&1
  else
    gitleaks dir "$DIR" --no-banner --redact --report-format json --report-path "$TMP/gl.json" >/dev/null 2>&1
  fi
  bun -e 'const j=await Bun.file(process.argv[1]).json().catch(()=>[]);for(const f of j)console.log(`${f.File}:${f.StartLine} ${f.RuleID}`)' "$TMP/gl.json" > "$TMP/gitleaks"
  count gitleaks "$TMP/gitleaks"
else
  echo "gitleaks not installed: regex checks only"
fi

g() { grep -rInP --exclude-dir=.git --exclude-dir=node_modules "$@" "$DIR" | sed "s|^$DIR/||" ; }
g '\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b' | grep -vP '\b\d+\.\d+\.\d+\.\d+\.\d+' > "$TMP/ips"
g 'gh[pousr]_[A-Za-z0-9]{20,}|github_pa[t]_|\bsk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-|-----BEGIN [A-Z ]*PRIVATE KEY|(?:discord|bot)[_-]?token\s*[:=]\s*\S{20,}' > "$TMP/keys"
g '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' | grep -vP 'git@github\.com|noreply\.github\.com|@example\.(?:com|org)|quiple@quiple\.dev' > "$TMP/emails"
: > "$TMP/local"
for f in "$HOME/.config/pingpong-vision/upload-key" "$HOME/.config/pingpong-vision/setup-link.txt"; do
  if [[ -s "$f" ]]; then
    v="$(tr -d '\n' < "$f")"
    v="${v##*#setup=}"; v="${v##*/}"
    [[ ${#v} -ge 16 ]] && grep -rIlF --exclude-dir=.git "$v" "$DIR" | sed "s|^$DIR/||;s|$| (local secret)|" >> "$TMP/local"
  fi
done
: > "$TMP/private"
if [[ -s "$PATTERNS" ]]; then
  [[ "$MODE" == "--git" ]] && git -C "$DIR" log --all -p --format='commit %H%n%an <%ae>%n%B' > "$TMP/log"
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    g -e "$p" >> "$TMP/private"
    [[ -f "$TMP/log" ]] && grep -nP -e "$p" "$TMP/log" | sed 's/^/git-log:/' >> "$TMP/private"
  done < "$PATTERNS"
  label="private-patterns($(grep -c . "$PATTERNS"))"
else
  label="private-patterns(none)"
  echo "no $PATTERNS: host, account and people's names are NOT checked"
fi
count private-ips "$TMP/ips"
count keys-tokens "$TMP/keys"
count emails "$TMP/emails"
count local-secrets "$TMP/local"
count "$label" "$TMP/private"

( cd "$DIR" && find . -path ./.git -prune -o -path ./node_modules -prune -o \( -name 'REPORT*.md' -o -name 'BRIEF*.md' -o -name '.omo' -o -path './reference' -o -path './evidence' -o -path './data' -o -name '*.mp4' -o -name '*.webm' -o -name '*.mov' -o -name '*.y4m' -o -name '*.task' -o -name '*.onnx' -o -name 'upload-key' -o -name 'setup-tokens.json' -o -name 'deploy.env' -o -name 'scan-patterns' -o -name 'public-url.txt' \) -print ) > "$TMP/paths"
count forbidden-paths "$TMP/paths"

exit $fail
