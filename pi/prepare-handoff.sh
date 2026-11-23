#!/usr/bin/env bash
# prepare-handoff.sh -- returns a frame to its "first boot" state and powers it
# off, ready to give away. Run it once you have finished testing the frame on
# your own WiFi / Tailscale account / photos. See pi/README.md.
#
#   sudo ./pi/prepare-handoff.sh (--clear-photos | --keep-photos)
#                                [--yes] [--no-shutdown] [--force] [--dry-run]
#
# Exactly one of --clear-photos / --keep-photos is required: the photos may be
# the gift itself, or private test photos, so there is no default.
#
# What it removes (all under $FRAME_DATA_DIR, default /data):
#   - with --clear-photos: uploads/* and the image / collection / slideshow
#     state (reset to what the server creates on first run)
#   - update-status.json, the power log, the journal (best effort)
#   - the Tailscale login (tailscale logout, then state/ and certs wiped; the
#     operator setting the server needs is then set again on the fresh state)
#   - EVERY saved WiFi profile (including the Hotspot one) -- last, because it
#     drops an SSH session that runs over WiFi
# It keeps: your SSH authorized key, /data/releases, /data/current, sudoers,
# the kiosk setup and Ethernet profiles.
#
# Idempotent: a second run is a harmless no-op that still ends in shutdown.
# --dry-run runs no command at all, changes nothing and needs no root.
#
# Env: FRAME_DATA_DIR (default /data) -- the data root; tests point it at a
#   temp dir. Must be an absolute path without ".." and not "/".
#   FRAME_HANDOFF_LOG (default /run/prepare-handoff.log) -- after the confirmation
#   all output goes to this file (tmpfs, gone at shutdown) and HUP/PIPE are
#   ignored, so losing the terminal (SSH over WiFi drops when the WiFi profiles are
#   deleted) never stops the run before poweroff. It may not be under /data or
#   FRAME_DATA_DIR. A background `tail -f` keeps showing it while the terminal lives.
#   FRAME_HANDOFF_TAILSCALE_TIMEOUT (default 10) -- seconds one `tailscale status`
#   or `tailscale set` may take before it is treated as failed.
#   FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 (tests only) lets a non-root user run for
#   real; it is refused for the default /data.
#
# Exit codes: 0 ok; 1 aborted or a step failed (no shutdown); 2 bad arguments;
#   3 does not look like an installer-built frame (use --force); 4 not root.
set -euo pipefail

TOTAL_STEPS=7
SERVER_UNIT="photo-frame-server.service"
FRAME_USER="frame"
# Installed by install.sh; the server unit also runs it before every start.
OPERATOR_HELPER="/usr/local/lib/photo-frame/tailscale-operator.sh"
SAFE_WORD_RE='^[][A-Za-z0-9_./:=@%+,#*-]+$'
UUID_RE='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
SLIDESHOW_DEFAULT='{
  "currentImageId": null,
  "duration": 120000,
  "activeCollectionId": null
}'

PHOTOS=""        # clear | keep
YES=0
NO_SHUTDOWN=0
FORCE=0
DRY=0
DATA=""          # as given (normalised)
DATA_REAL=""     # physical path; every deletion must be strictly inside it
WIFI_UUIDS=()
WIFI_NAMES=()
WIFI_BAD=0
LOG="${FRAME_HANDOFF_LOG-/run/prepare-handoff.log}"
TAIL_PID=
# Seconds a single tailscale query may take (a hung daemon must not block the run).
TS_TIMEOUT="${FRAME_HANDOFF_TAILSCALE_TIMEOUT:-10}"
OPERATOR_TRIES=10

# ---- output helpers ----------------------------------------------------------
step() { printf '\n[%s/%s] %s\n' "$1" "$TOTAL_STEPS" "$2"; }
say() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*"; }
die() { # <message> [exit code]
  printf 'prepare-handoff.sh: %s\n' "$1" >&2
  exit "${2:-1}"
}
usage_error() {
  printf 'prepare-handoff.sh: %s\n' "$1" >&2
  printf 'Usage: sudo ./pi/prepare-handoff.sh (--clear-photos | --keep-photos) [--yes] [--no-shutdown] [--force] [--dry-run]\n' >&2
  exit 2
}
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

# qcmd <args...>: shell-quoted rendering of a command line.
qcmd() {
  local out="" a
  for a in "$@"; do
    if [[ "$a" =~ $SAFE_WORD_RE ]]; then
      out="$out$a "
    else
      out="$out'$(printf '%s' "$a" | sed "s/'/'\\\\''/g")' "
    fi
  done
  printf '%s' "${out% }"
}

# run <cmd...>: print, then (unless dry-run) execute.
run() {
  printf '    $ %s\n' "$(qcmd "$@")"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  "$@"
}
# soft <cmd...>: like run, but a failure is only a warning.
soft() {
  run "$@" || warn "failed (ignored): $(qcmd "$@")"
}

# with_timeout <seconds> <cmd...>
with_timeout() {
  local secs=$1 pid w rc=0
  shift
  if command -v timeout > /dev/null 2>&1; then timeout "$secs" "$@"; return; fi
  "$@" &
  pid=$!
  (
    i=0
    while [[ $i -lt $secs ]]; do
      sleep 1
      kill -0 "$pid" 2> /dev/null || exit 0
      i=$((i + 1))
    done
    kill "$pid" 2> /dev/null
  ) > /dev/null 2>&1 &
  w=$!
  wait "$pid" || rc=$?
  kill "$w" 2> /dev/null || true
  return "$rc"
}

# printable <text>: control characters stripped (profile names are untrusted).
printable() { printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177'; }

# ---- arguments -----------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --clear-photos)
        if [[ -n "$PHOTOS" && "$PHOTOS" != clear ]]; then usage_error "give only one of --clear-photos / --keep-photos"; fi
        PHOTOS=clear ;;
      --keep-photos)
        if [[ -n "$PHOTOS" && "$PHOTOS" != keep ]]; then usage_error "give only one of --clear-photos / --keep-photos"; fi
        PHOTOS=keep ;;
      --yes) YES=1 ;;
      --no-shutdown) NO_SHUTDOWN=1 ;;
      --force) FORCE=1 ;;
      --dry-run) DRY=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
    shift
  done
  if [[ -z "$PHOTOS" ]]; then
    usage_error "one of --clear-photos / --keep-photos is required (photos may be the gift itself, so there is no default)"
  fi
}

validate_data_dir() {
  if [[ -z "${FRAME_DATA_DIR+set}" ]]; then
    DATA="/data"
  else
    DATA="$FRAME_DATA_DIR"
  fi
  if [[ -z "$DATA" ]]; then usage_error "FRAME_DATA_DIR is empty"; fi
  if [[ "$DATA" != /* ]]; then usage_error "FRAME_DATA_DIR must be an absolute path (got '$DATA')"; fi
  case "/$DATA/" in */../*) usage_error "FRAME_DATA_DIR must not contain '..' components" ;; esac
  while [[ "$DATA" == */ && "$DATA" != / ]]; do DATA="${DATA%/}"; done
  if [[ "$DATA" == / ]]; then usage_error "FRAME_DATA_DIR must not be /"; fi
  if [[ -d "$DATA" ]]; then
    DATA_REAL="$(cd -P -- "$DATA" && pwd -P)"
  else
    DATA_REAL="$DATA"
  fi
  case "$DATA_REAL" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var)
      usage_error "FRAME_DATA_DIR resolves to a system directory ($DATA_REAL); refusing" ;;
  esac
  if [[ -z "$DATA_REAL" ]]; then usage_error "FRAME_DATA_DIR resolved to nothing"; fi
  if ! [[ "$TS_TIMEOUT" =~ ^[1-9][0-9]{0,2}$ ]]; then usage_error "FRAME_HANDOFF_TAILSCALE_TIMEOUT must be a whole number of seconds (1-999)"; fi
  if [[ "${FRAME_HANDOFF_TEST_ALLOW_NONROOT:-}" == 1 && "$DATA_REAL" == /data ]]; then
    usage_error "FRAME_HANDOFF_TEST_ALLOW_NONROOT must never be combined with the real /data"
  fi
}

validate_log_path() {
  if [[ -z "$LOG" || "$LOG" != /* ]]; then usage_error "FRAME_HANDOFF_LOG must be an absolute path"; fi
  case "/$LOG/" in */../*) usage_error "FRAME_HANDOFF_LOG must not contain '..' components" ;; esac
  case "$LOG" in
    /data | /data/* | "$DATA" | "$DATA"/* | "$DATA_REAL" | "$DATA_REAL"/*)
      usage_error "FRAME_HANDOFF_LOG must not be on the persistent data partition ($LOG)" ;;
  esac
}

# start_logging: from here on nothing is written to the terminal by this
# process, and HUP/PIPE cannot stop it.
stop_tail() {
  if [[ -n "$TAIL_PID" ]]; then
    sleep 1
    kill "$TAIL_PID" 2> /dev/null || true
    TAIL_PID=
  fi
}
start_logging() {
  # Truncate: a log left by an earlier run in this boot must not be replayed.
  ( umask 077; : > "$LOG" ) 2> /dev/null || die "cannot write the log $LOG; nothing was changed"
  chmod 600 "$LOG" 2> /dev/null || die "cannot make the log $LOG private; nothing was changed"
  printf '\nOutput continues in %s; the frame powers off by itself, even if this session drops.\n' "$LOG"
  printf 'Ctrl-C is ignored from here on.\n'
  # Ignore before anything else starts, so every child (tail too) inherits it.
  # INT too: a Ctrl-C meant to "stop watching" would otherwise leave the frame half-wiped.
  trap '' HUP PIPE INT
  tail -n +1 -f "$LOG" 2> /dev/null &
  TAIL_PID=$!
  trap stop_tail EXIT
  exec >> "$LOG" 2>&1 < /dev/null
}

# ---- path guards -----------------------------------------------------------------
# inside <path>: strictly below the (physical) data root, lexically.
inside() {
  [[ -n "$DATA_REAL" && -n "$1" ]] || return 1
  case "$1" in "$DATA_REAL"/?*) return 0 ;; esac
  return 1
}

# guard_dir <dir>: a real directory (not a symlink) that resolves strictly
# inside the data root. Prints its physical path.
guard_dir() {
  local d=$1 r
  [[ -n "$d" && -d "$d" && ! -L "$d" ]] || return 1
  r="$(cd -P -- "$d" && pwd -P)" || return 1
  inside "$r" || return 1
  [[ "$r" == "$d" ]] || return 1
  printf '%s' "$r"
}

# guard_file_parent <file>: the file's directory is the data root itself or a
# guarded directory inside it.
guard_file_parent() {
  local f=$1 p r
  [[ -n "$f" ]] || return 1
  p="$(dirname -- "$f")"
  [[ -d "$p" && ! -L "$p" ]] || return 1
  r="$(cd -P -- "$p" && pwd -P)" || return 1
  [[ "$r" == "$DATA_REAL" ]] || inside "$r" || return 1
  [[ "$r" == "$p" ]] || return 1
  inside "$f"
}

# unsafe_layout: the directories the script clears must not be symlinks that
# leave the data root. Checked before anything is touched.
check_layout() {
  local d
  for d in uploads data log system/tailscale system/NetworkManager; do
    if [[ -L "$DATA_REAL/$d" ]]; then die "$DATA_REAL/$d is a symlink; refusing (move it aside and re-run)" 2; fi
    if [[ -e "$DATA_REAL/$d" ]] && ! guard_dir "$DATA_REAL/$d" > /dev/null; then
      die "$DATA_REAL/$d does not resolve inside $DATA_REAL; refusing" 2
    fi
  done
  if [[ -L "$DATA_REAL/system" ]]; then die "$DATA_REAL/system is a symlink; refusing" 2; fi
}

# ---- state helpers ------------------------------------------------------------------
file_owner() { stat -c '%u:%g' "$1" 2> /dev/null || stat -f '%u:%g' "$1"; }
file_mode() { stat -c '%a' "$1" 2> /dev/null || stat -f '%Lp' "$1"; }

# write_json_atomic <file> <content>: temp file in the same directory, owner
# and mode copied from the old file (or the directory), then rename.
write_json_atomic() {
  local f=$1 content=$2 dir tmp ref mode owner
  printf '    write %s (atomic; owner and mode unchanged)\n' "$f"
  printf '%s\n' "$content" | sed 's/^/      | /'
  if [[ $DRY -eq 1 ]]; then return 0; fi
  guard_file_parent "$f" || die "refusing to write outside the data root: $f"
  if [[ -L "$f" ]]; then die "$f is a symlink; refusing"; fi
  dir="$(dirname -- "$f")"
  ref="$f"
  [[ -e "$f" ]] || ref="$dir"
  owner="$(file_owner "$ref")"
  if [[ "$ref" == "$f" ]]; then mode="$(file_mode "$f")"; else mode=644; fi
  tmp="$(mktemp "$dir/.handoff.XXXXXX")"
  printf '%s' "$content" > "$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f -- "$tmp" "$f"
}

# clear_dir_contents <dir> <label>: remove everything inside, keep the directory.
clear_dir_contents() {
  local d=$1 label=$2 real
  if [[ ! -e "$d" ]]; then say "$label: $d not present, nothing to do"; return 0; fi
  real="$(guard_dir "$d")" || die "refusing to clear $d: not a real directory inside $DATA_REAL"
  if [[ -z "$(find "$real" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    say "$label: $real is already empty"
    return 0
  fi
  run find "$real" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

# remove_file <file>: a file (or symlink, which is removed, never followed)
# directly inside the data root tree.
remove_file() {
  local f=$1
  if [[ ! -e "$f" && ! -L "$f" ]]; then return 0; fi
  guard_file_parent "$f" || die "refusing to delete outside the data root: $f"
  run rm -f -- "$f"
}

# ---- NetworkManager -------------------------------------------------------------------
# list_wifi: fills WIFI_UUIDS / WIFI_NAMES from the terse "UUID:TYPE:NAME"
# listing (':' and '\' are backslash-escaped inside NAME, which is last so it
# cannot confuse the split). Returns 1 when nmcli cannot list.
list_wifi() {
  local out line uuid rest type name
  WIFI_UUIDS=()
  WIFI_NAMES=()
  WIFI_BAD=0
  out="$(nmcli -t -f UUID,TYPE,NAME connection show 2> /dev/null)" || return 1
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    uuid=${line%%:*}
    rest=${line#*:}
    [[ "$rest" == *:* ]] || continue
    type=${rest%%:*}
    name=${rest#*:}
    case "$type" in 802-11-wireless | wifi) ;; *) continue ;; esac
    if [[ ! "$uuid" =~ $UUID_RE ]]; then WIFI_BAD=$((WIFI_BAD + 1)); continue; fi
    name=${name//\\:/:}
    WIFI_UUIDS+=("$uuid")
    WIFI_NAMES+=("$(printable "$name")")
  done <<< "$out"
}

# wifi_keyfiles: prints each regular *.nmconnection of type wifi.
wifi_keyfiles() {
  local dir="$DATA_REAL/system/NetworkManager" f
  [[ -d "$dir" && ! -L "$dir" ]] || return 0
  for f in "$dir"/*.nmconnection; do
    [[ -e "$f" || -L "$f" ]] || continue
    if [[ -L "$f" || ! -f "$f" ]]; then
      warn "skipping $(printable "$(basename -- "$f")"): not a regular file"
      continue
    fi
    if grep -Eq '^type=(wifi|802-11-wireless)[[:space:]]*$' -- "$f" 2> /dev/null; then printf '%s\n' "$f"; fi
  done
}

# (bounded: a hung tailscaled counts as "not logged in"; its state is wiped anyway)
tailscale_logged_in() { command -v tailscale > /dev/null 2>&1 && with_timeout "$TS_TIMEOUT" tailscale status > /dev/null 2>&1; }

# ---- steps -------------------------------------------------------------------------------
print_summary() {
  local i
  echo
  echo "This will prepare the frame for handoff and POWER IT OFF. It will:"
  if [[ "$PHOTOS" == clear ]]; then
    echo "  - DELETE all photos in $DATA_REAL/uploads and reset the slideshow, image and collection data"
  else
    echo "  - keep the photos (uploads and image data stay as they are)"
  fi
  echo "  - delete the update status, the power log and the system journal"
  echo "  - log out of Tailscale and delete its saved identity"
  if ((${#WIFI_UUIDS[@]} > 0)); then
    echo "  - delete these saved WiFi profiles:"
    for i in "${!WIFI_UUIDS[@]}"; do echo "      * ${WIFI_NAMES[$i]}"; done
  else
    echo "  - delete every saved WiFi profile (none found right now)"
  fi
  echo "    (an SSH session over WiFi will drop; the last steps need no connection)"
  echo "  It keeps your SSH key, the installed release, and Ethernet profiles."
  if [[ $NO_SHUTDOWN -eq 1 ]]; then echo "  It will NOT power off (--no-shutdown)."; fi
  echo
}

step_preflight() {
  step 1 "Preflight"
  say "data root: $DATA_REAL"
  if [[ "$PHOTOS" == clear ]]; then say "photos: will be CLEARED"; else say "photos: will be KEPT"; fi
  if [[ $DRY -eq 1 ]]; then
    say "dry run: no command is executed and root is not required"
    say "a real run also requires: root, $DATA_REAL/current and $SERVER_UNIT (or --force)"
    say "a real run asks you to type \"handoff\" first (skip with --yes)"
    if [[ ! -e "$DATA_REAL/current" && ! -L "$DATA_REAL/current" ]]; then
      warn "$DATA_REAL/current is missing: a real run would refuse without --force"
    fi
    if [[ -r /proc/cmdline ]] && grep -q 'overlayroot=' /proc/cmdline; then
      warn "the read-only overlay is active; $DATA_REAL is persistent either way"
    fi
    return 0
  fi
  if [[ $EUID -ne 0 && "${FRAME_HANDOFF_TEST_ALLOW_NONROOT:-}" != 1 ]]; then
    die "must run as root: sudo ./pi/prepare-handoff.sh ..." 4
  fi
  check_layout
  if [[ ! -d "$DATA_REAL" ]]; then die "$DATA_REAL does not exist" 3; fi
  if [[ $FORCE -eq 0 ]]; then
    if [[ ! -e "$DATA_REAL/current" && ! -L "$DATA_REAL/current" ]]; then
      die "$DATA_REAL/current is missing: this does not look like an installer-built frame (use --force to override)" 3
    fi
    if ! systemctl cat "$SERVER_UNIT" > /dev/null 2>&1; then
      die "$SERVER_UNIT is not installed: this does not look like an installer-built frame (use --force to override)" 3
    fi
    command -v nmcli > /dev/null 2>&1 || die "nmcli not found (use --force to continue without WiFi cleanup)" 3
  fi
  if [[ -r /proc/cmdline ]] && grep -q 'overlayroot=' /proc/cmdline; then
    warn "the read-only overlay is active; $DATA_REAL is persistent either way, so this is fine"
  fi
  if command -v nmcli > /dev/null 2>&1; then
    list_wifi || die "nmcli could not list the connections; is NetworkManager running?"
  fi
  print_summary
  if [[ $YES -eq 0 ]]; then
    if [[ ! -t 0 ]]; then die "stdin is not a terminal; re-run in a terminal or pass --yes" 1; fi
    local answer=""
    printf 'Type "handoff" to continue: '
    read -r answer || true
    if [[ "$answer" != handoff ]]; then die "aborted; nothing was changed" 1; fi
  fi
  start_logging
}

step_stop_server() {
  step 2 "Stop the photo frame server"
  if [[ $DRY -eq 0 ]]; then
    if ! run systemctl stop "$SERVER_UNIT"; then
      if [[ $FORCE -eq 1 ]]; then warn "could not stop $SERVER_UNIT; continuing (--force)"; else die "could not stop $SERVER_UNIT; nothing was deleted"; fi
    fi
  else
    run systemctl stop "$SERVER_UNIT"
  fi
}

step_photos() {
  step 3 "Photos"
  if [[ "$PHOTOS" == keep ]]; then say "Keeping photos"; return 0; fi
  clear_dir_contents "$DATA_REAL/uploads" "uploads"
  if [[ -e "$DATA_REAL/data" ]]; then
    guard_dir "$DATA_REAL/data" > /dev/null || die "refusing: $DATA_REAL/data is not a real directory inside $DATA_REAL"
    write_json_atomic "$DATA_REAL/data/images.json" "[]"
    write_json_atomic "$DATA_REAL/data/collections.json" "[]"
    write_json_atomic "$DATA_REAL/data/slideshow-state.json" "$SLIDESHOW_DEFAULT"
  else
    say "$DATA_REAL/data not present, nothing to reset"
  fi
}

step_state() {
  local f
  step 4 "Update status, power log and journal"
  remove_file "$DATA_REAL/update-status.json"
  if [[ -d "$DATA_REAL/log" ]]; then
    guard_dir "$DATA_REAL/log" > /dev/null || die "refusing: $DATA_REAL/log is not a real directory inside $DATA_REAL"
    for f in "$DATA_REAL"/log/power-log.csv*; do
      [[ -e "$f" || -L "$f" ]] || continue
      remove_file "$f"
    done
  fi
  soft journalctl --rotate
  soft journalctl --vacuum-time=1s
}

step_tailscale() {
  step 5 "Tailscale"
  if [[ $DRY -eq 1 ]]; then
    say "if 'tailscale status' shows a logged-in node:"
    run tailscale logout
  elif tailscale_logged_in; then
    printf '    $ tailscale logout\n'
    with_timeout 30 tailscale logout > /dev/null 2>&1 || warn "tailscale logout failed or timed out (ignored)"
  else
    say "Tailscale is not logged in; skipping logout"
  fi
  soft systemctl stop tailscaled
  clear_dir_contents "$DATA_REAL/system/tailscale" "tailscale state"
  reassert_operator
  say "REMINDER: delete this machine from your Tailscale admin console too"
  say "(https://login.tailscale.com/admin/machines); logout does not always remove it."
}

# reassert_operator: the cleared state held the `tailscale set --operator=frame`
# pref; without it the next owner's frame cannot run `tailscale up` as frame and
# the login QR never appears. Start tailscaled on the fresh (logged-out) state,
# set it again, stop it again. Best effort: never stops the handoff.
reassert_operator() {
  local i done=0
  say "set the Tailscale operator ($FRAME_USER) again on the fresh state, so the next owner can log in"
  if [[ $DRY -eq 1 ]]; then
    run systemctl start tailscaled
    run tailscale set "--operator=$FRAME_USER"
    run systemctl stop tailscaled
    return 0
  fi
  if ! command -v tailscale > /dev/null 2>&1; then
    warn "tailscale not found; operator not set (the server sets it again on every start)"
    return 0
  fi
  soft systemctl start tailscaled
  if [[ -x "$OPERATOR_HELPER" && ! -L "$OPERATOR_HELPER" ]]; then
    printf '    $ %s\n' "$OPERATOR_HELPER"
    with_timeout 30 "$OPERATOR_HELPER" && done=1
  else
    printf '    $ %s\n' "$(qcmd tailscale set "--operator=$FRAME_USER")"
    for ((i = 0; i < OPERATOR_TRIES; i++)); do
      if with_timeout "$TS_TIMEOUT" tailscale set "--operator=$FRAME_USER" > /dev/null 2>&1; then done=1; break; fi
      sleep 1
    done
  fi
  if [[ $done -ne 1 ]]; then warn "could not set the Tailscale operator (ignored; the server tries again on every start)"; fi
  soft systemctl stop tailscaled
}

step_wifi() {
  local i left f
  step 6 "WiFi profiles (last destructive step)"
  warn "an SSH session over WiFi will drop now; the frame powers off by itself"
  if [[ $DRY -eq 1 ]]; then
    say "for every saved WiFi profile (including Hotspot), once each:"
    run nmcli connection delete uuid "<uuid>"
    say "then list the connections again and fail (no shutdown) if any WiFi profile is left"
  elif ! command -v nmcli > /dev/null 2>&1; then
    warn "nmcli not found; skipping WiFi profile deletion (--force)"
  else
    list_wifi || die "nmcli could not list the connections; WiFi profiles NOT deleted, not shutting down"
    if ((${#WIFI_UUIDS[@]} == 0)); then say "no saved WiFi profiles"; fi
    for i in "${!WIFI_UUIDS[@]}"; do
      say "deleting WiFi profile: ${WIFI_NAMES[$i]}"
      run nmcli connection delete uuid "${WIFI_UUIDS[$i]}" || warn "could not delete profile: ${WIFI_NAMES[$i]}"
    done
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    say "leftover WiFi profile file: $(printable "$(basename -- "$f")")"
    remove_file "$f"
  done < <(wifi_keyfiles)
  if [[ $DRY -eq 0 ]] && command -v nmcli > /dev/null 2>&1; then
    list_wifi || die "could not verify the WiFi profiles were deleted; not shutting down"
    left=${#WIFI_UUIDS[@]}
    if ((left > 0 || WIFI_BAD > 0)); then
      for i in "${!WIFI_UUIDS[@]}"; do warn "still present: ${WIFI_NAMES[$i]}"; done
      die "$((left + WIFI_BAD)) WiFi profile(s) could not be deleted; NOT shutting down" 1
    fi
    say "verified: no WiFi profiles remain"
  fi
}

step_shutdown() {
  step 7 "Sync and power off"
  run sync
  if [[ $NO_SHUTDOWN -eq 1 ]]; then
    say "--no-shutdown: not powering off ($SERVER_UNIT and tailscaled stay stopped until reboot)"
  else
    run systemctl poweroff
  fi
  printf '\nSafe to unplug once the green LED stops flashing.\n'
  if [[ $DRY -eq 1 ]]; then printf '(dry run: nothing was changed)\n'; fi
}

main() {
  parse_args "$@"
  validate_data_dir
  validate_log_path
  if [[ $DRY -eq 1 ]]; then printf 'photo-frame handoff: dry run, no changes will be made\n'; fi
  step_preflight
  step_stop_server
  step_photos
  step_state
  step_tailscale
  step_wifi
  step_shutdown
}

main "$@"
