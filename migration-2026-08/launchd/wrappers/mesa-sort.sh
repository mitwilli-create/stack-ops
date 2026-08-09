#!/bin/bash
# QOS new sort runner. Fires the headless sort agent when new has items.
# Safe by design: agent never deletes (archives + git commit = reversible).
set -uo pipefail

# Headless launchd runs with a bare PATH. Put Homebrew + user bins on it so
# `node` (lifecycle hooks), `git`, `jq`, and the transcriber resolve.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# This machine has no /opt/homebrew/bin/claude; the CLI is nvm-managed. launchd's
# bare PATH can't see nvm, so the wrapper's `command -v claude` fails (rc 127).
# Add whichever nvm node bin actually carries claude (glob survives node upgrades).
for _d in "$HOME"/.nvm/versions/node/*/bin; do
  [ -x "$_d/claude" ] && export PATH="$_d:$PATH"
done
unset _d

# BILLING SAFETY (Mitchell's stack): launchd inherits ANTHROPIC_API_KEY, which
# outranks subscription OAuth and would silently bill this headless main-loop
# call per-token on every dropped note. Strip it so triage stays on the flat-rate
# subscription. CLAUDE_BIN below also points at the key-stripping wrapper.
unset ANTHROPIC_API_KEY

# Optional flag: write + load a launchd watcher plist for a given vault, then exit
# (does not run sort). Called by install.sh as `sort.sh --install-watcher <vault>`.
if [ "${1:-}" = "--install-watcher" ]; then
  WATCH_VAULT="${2:?usage: sort.sh --install-watcher <vault-abs-path>}"
  if [ "$(uname)" != Darwin ]; then
    echo "New watcher requires macOS (launchd). Skipping."; exit 0
  fi
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/com.mesa.sort.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mesa.sort</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WATCH_VAULT/.mesa/scripts/sort.sh</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>$WATCH_VAULT/new</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$WATCH_VAULT/.mesa/scripts/sort-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$WATCH_VAULT/.mesa/scripts/sort-launchd.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load "$PLIST"
  echo "New watcher installed: $PLIST"
  exit 0
fi

VAULT="${QOS_VAULT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$VAULT" || exit 1

CLAUDE_BIN="$HOME/.claude/bin/claude"
LOCK="$VAULT/.mesa/scripts/.sort.lock"
RUNLOG="$VAULT/.mesa/scripts/sort-runs.log"
STATUS="$VAULT/.mesa/scripts/sort-status.json"
RUNS_DIR="$VAULT/.mesa/runs"
RUN_ID="$(date +%s)"
RUN_FILE="$RUNS_DIR/$RUN_ID.jsonl"
SEQ=0

ts() { date '+%Y-%m-%d %H:%M:%S'; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Safe JSON string escape (jq if present, else printf fallback)
json_str() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  else
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    printf '"%s"' "$s"
  fi
}

# emit_event TYPE JSON_BODY
# JSON_BODY is the event's own fields as inner JSON ("k":v,...) or empty.
# Prepends seq/type/at and appends one canonical line to the run file.
emit_event() {
  local type="$1" body="${2:-}"
  mkdir -p "$RUNS_DIR"
  local head
  head=$(printf '"seq":%s,"type":"%s","at":"%s"' "$SEQ" "$type" "$(now_iso)")
  if [ -n "$body" ]; then
    printf '{%s,%s}\n' "$head" "$body" >> "$RUN_FILE"
  else
    printf '{%s}\n' "$head" >> "$RUN_FILE"
  fi
  SEQ=$((SEQ + 1))
}

emit_message() { emit_event message "$(printf '"message":%s' "$(json_str "$1")")"; }

write_status() {
  # args: state items current message
  local state="$1" items="${2:-0}" current="${3:-}" message="${4:-}"
  printf '{"state":"%s","updated":"%s","items":%s,"current":"%s","message":"%s","run_id":"%s"}\n' \
    "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$items" "$current" "$message" "$RUN_ID" \
    > "$STATUS"
}

# Count real items (ignore README, hidden, .DS_Store)
COUNT=$(find new -type f ! -name 'README.md' ! -name '.DS_Store' ! -name '.*' | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  echo "$(ts) idle: nothing to sort" >> "$RUNLOG"
  write_status "idle" 0 "" "new clear"
  exit 0
fi

# Prevent concurrent runs (debounce rapid file drops), but never wedge forever:
# a crashed run must not leave a lock that blocks every future run. The lock holds
# its PID; we steal it if that process is gone or the lock is older than 15 min.
if [ -f "$LOCK" ]; then
  lpid=$(cat "$LOCK" 2>/dev/null)
  stale=0
  [ -z "$lpid" ] && stale=1
  [ -n "$lpid" ] && ! kill -0 "$lpid" 2>/dev/null && stale=1
  if [ -n "$(find "$LOCK" -mmin +15 2>/dev/null)" ]; then stale=1; fi
  if [ "$stale" -eq 1 ]; then
    echo "$(ts) clearing stale lock (pid=$lpid)" >> "$RUNLOG"
    rm -f "$LOCK"
  else
    echo "$(ts) skip: locked (pid=$lpid running)" >> "$RUNLOG"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

write_status "received" "$COUNT" "" "received $COUNT item(s)"

emit_event run_started '"intent":"sort","harness":"shell"'

echo "$(ts) START sort of $COUNT item(s)" >> "$RUNLOG"

write_status "working" "$COUNT" "" "triaging $COUNT item(s)"

# Transcribe any audio drops to a sidecar .txt so the agent can read them.
# Tell the user the outcome — a silent loop that eats audio is a broken loop.
notify() { "$VAULT/.mesa/scripts/notify.sh" "$1" "$2"; }
while IFS= read -r af; do
  [ -z "$af" ] && continue
  name="${af##*/}"
  "$VAULT/.mesa/scripts/transcribe.sh" "$af" >> "$RUNLOG" 2>&1
  case $? in
    0) emit_message "Transcribed ${af#new/}";;
    3) emit_message "Silent recording ${af#new/} (no speech)"
       notify "Mesa" "'$name' had no speech. Filing it to archive." ;;
    2) emit_message "No transcriber for ${af#new/}"
       notify "Mesa needs you" "Couldn't read '$name' (no transcriber). Left in new." ;;
    *) emit_message "Could not transcribe ${af#new/}"
       notify "Mesa needs you" "Couldn't read '$name'. Left in new." ;;
  esac
done < <(find new -type f \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.wav' -o -iname '*.mp4' -o -iname '*.aac' -o -iname '*.caf' \) ! -name '.*')

# Snapshot new before the run so we can report what each item became.
BEFORE=$(find new -type f ! -name 'README.md' ! -name '.DS_Store' ! -name '.*' | sort)

"$CLAUDE_BIN" -p "$(cat "$VAULT/.mesa/scripts/sort-prompt.md")" \
  --dangerously-skip-permissions \
  >> "$RUNLOG" 2>&1
RC=$?

if [ "$RC" -eq 0 ]; then
  # One human-readable message per new item the agent cleared.
  AFTER=$(find new -type f ! -name 'README.md' ! -name '.DS_Store' ! -name '.*' | sort)
  FILED=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! printf '%s\n' "$AFTER" | grep -qxF "$f"; then
      emit_message "Filed ${f#new/}"
      FILED=$((FILED + 1))
    fi
  done <<< "$BEFORE"
  emit_event finished "$(printf '"result":%s' "$(json_str "Filed $FILED item(s)")")"
  # Rebuild summary.md so it reflects the new state.
  bash "$VAULT/.mesa/scripts/dashboard.sh" >> "$RUNLOG" 2>&1 || true
  write_status "done" "$COUNT" "" "sort complete"

  # Tell the user what happened. Held items (still in new) need their attention.
  HELD=$(printf '%s\n' "$AFTER" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$HELD" -gt 0 ]; then
    notify "Mesa needs you" "$HELD item(s) held in new — sensitive or unclear. Take a look."
  elif [ "$FILED" -gt 0 ]; then
    notify "Mesa" "Filed $FILED item(s). Tap summary.md to see what went where."
  fi
else
  emit_event error "$(printf '"message":%s' "$(json_str "sort failed (rc=$RC)")")"
  write_status "error" "$COUNT" "" "sort failed (rc=$RC)"
  notify "Mesa hit an error" "Sort failed. Your drops are untouched in new."
fi
echo "$(ts) END sort rc=$RC" >> "$RUNLOG"
