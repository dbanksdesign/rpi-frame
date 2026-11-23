#!/usr/bin/env bash
# Offline tests for pi/prepare-handoff.sh (plain bash; macOS and Linux; no
# root, no network). Every run happens in a temp sandbox: FRAME_DATA_DIR always
# points at it and nmcli/tailscale/systemctl/journalctl/sync are stubs that
# only record their argv. Nothing here can reach the real /data.
# shellcheck disable=SC2016  # stub bodies and literal $ text are deliberately single-quoted
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="$(cd "$HERE/.." && pwd)"
SCRIPT="$PI/prepare-handoff.sh"
ROOT="$(mktemp -d)"
[[ -n "$ROOT" && -d "$ROOT" ]] || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok; else bad "$3: expected [$2] got [$1]"; fi; }
assert_contains() { if [[ "$1" == *"$2"* ]]; then ok; else bad "$3: output lacks [$2]"; fi; }
assert_not_contains() { if [[ "$1" != *"$2"* ]]; then ok; else bad "$3: output unexpectedly contains [$2]"; fi; }
present() { if [[ -e "$1" || -L "$1" ]]; then ok; else bad "$2 (missing: $1)"; fi; }
absent() { if [[ -e "$1" || -L "$1" ]]; then bad "$2 (still there: $1)"; else ok; fi; }

# ---- stubs --------------------------------------------------------------------
BIN="$ROOT/bin"
mkdir -p "$BIN"
make_stub() { # <name> <body>
  printf '#!/usr/bin/env bash\n{ printf "%%s" "%s"; for a in "$@"; do printf " [%%s]" "$a"; done; echo; } >> "$STUB_LOG"\n%s\n' "$1" "$2" > "$BIN/$1"
  chmod +x "$BIN/$1"
}
make_stub nmcli '
if [[ "$1" == "-t" && "$3" == "UUID,TYPE,NAME" && "$4" == connection && "$5" == show ]]; then
  [[ -f "$STUB_STATE/nm-profiles" ]] && cat "$STUB_STATE/nm-profiles"
  exit 0
fi
if [[ "$1" == connection && "$2" == delete && "$3" == uuid ]]; then
  grep -v "^$4:" "$STUB_STATE/nm-profiles" > "$STUB_STATE/nm.new" || true
  mv "$STUB_STATE/nm.new" "$STUB_STATE/nm-profiles"
  exit 0
fi
exit 0'
make_stub tailscale '
case "$1" in
  status)
    [[ -f "$STUB_STATE/ts-hang" ]] && exec sleep 30
    [[ -f "$STUB_STATE/ts-loggedin" ]] && exit 0; exit 1 ;;
  logout)
    if [[ -n "${STUB_HUP_PIDFILE:-}" ]]; then kill -HUP "$(cat "$STUB_HUP_PIDFILE")"; sleep 1; fi
    rm -f "$STUB_STATE/ts-loggedin"; exit 0 ;;
  set) [[ -f "$STUB_STATE/ts-set-fails" ]] && exit 1; exit 0 ;;
esac
exit 0'
make_stub systemctl 'exit 0'
# STUB_INT_PGID_FILE: emulate Ctrl-C (SIGINT to the whole foreground process group)
make_stub journalctl '
if [[ -n "${STUB_INT_PGID_FILE:-}" && "$1" == --rotate ]]; then kill -INT -- "-$(cat "$STUB_INT_PGID_FILE")"; sleep 1; fi
exit 0'
make_stub sync 'exit 0'

UUID_A=11111111-1111-4111-8111-111111111111
UUID_H=33333333-3333-4333-8333-333333333333
UUID_E=44444444-4444-4444-8444-444444444444
UUID_Q=55555555-5555-4555-8555-555555555555

# new_sandbox: a fresh frame data tree under $SB. Sets SB DATA OUTSIDE.
new_sandbox() {
  SB="$(mktemp -d "$ROOT/sb.XXXXXX")"
  [[ -n "$SB" && -d "$SB" && "$SB" == "$ROOT"/* ]] || { echo "sandbox creation failed" >&2; exit 1; }
  DATA="$SB/data"
  OUTSIDE="$SB/outside"
  export STUB_LOG="$SB/calls.log" STUB_STATE="$SB/state"
  mkdir -p "$STUB_STATE" "$OUTSIDE" "$DATA"/{uploads/sub,data,log,releases/v1.0.0,system/tailscale,system/NetworkManager}
  : > "$STUB_LOG"
  ln -s releases/v1.0.0 "$DATA/current"
  echo "release" > "$DATA/releases/v1.0.0/index.js"
  echo "precious" > "$OUTSIDE/keep.txt"
  echo "photo" > "$DATA/uploads/a.jpg"
  echo "photo" > "$DATA/uploads/.hidden"
  echo "photo" > "$DATA/uploads/sub/b.jpg"
  ln -s "$OUTSIDE/keep.txt" "$DATA/uploads/filelink"
  ln -s "$OUTSIDE" "$DATA/uploads/dirlink"
  echo '[{"id":"x"}]' > "$DATA/data/images.json"
  echo '[{"id":"c"}]' > "$DATA/data/collections.json"
  echo '{"currentImageId":"x","duration":5,"activeCollectionId":"c"}' > "$DATA/data/slideshow-state.json"
  echo '{"state":"success"}' > "$DATA/update-status.json"
  echo "t,w" > "$DATA/log/power-log.csv"
  echo "t,w" > "$DATA/log/power-log.csv.1"
  echo "keepme" > "$DATA/log/other.log"
  echo "tskey-SECRET" > "$DATA/system/tailscale/tailscaled.state"
  mkdir -p "$DATA/system/tailscale/certs"
  echo "cert" > "$DATA/system/tailscale/certs/c.crt"
  printf '[connection]\nid=Home\ntype=wifi\nuuid=%s\n[wifi-security]\npsk=hunter2\n' "$UUID_A" > "$DATA/system/NetworkManager/Home.nmconnection"
  printf '[connection]\nid=Hotspot\ntype=wifi\nuuid=%s\n' "$UUID_H" > "$DATA/system/NetworkManager/Hotspot.nmconnection"
  printf '[connection]\nid=Wired\ntype=ethernet\nuuid=%s\n' "$UUID_E" > "$DATA/system/NetworkManager/Wired.nmconnection"
  # terse nmcli output: UUID:TYPE:NAME, with ':' and '\' escaped in NAME
  {
    printf '%s:802-11-wireless:Home\n' "$UUID_A"
    printf '%s:802-11-wireless:Hotspot\n' "$UUID_H"
    printf '%s:802-3-ethernet:Wired\n' "$UUID_E"
    printf '%s:wifi:My "Cafe"; net\\:5G $(touch pwned)\n' "$UUID_Q"
  } > "$STUB_STATE/nm-profiles"
  : > "$STUB_STATE/ts-loggedin"
}

# run_ph <args...>: runs the script inside the sandbox. Sets OUT (stdout+stderr), RC.
run_ph() {
  [[ "$DATA" == "$ROOT"/*/data ]] || { echo "refusing to run outside the sandbox: [$DATA]" >&2; exit 1; }
  OUT="$(cd "$SB" && env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$SB/handoff.log" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" "$@" 2>&1 < /dev/null)"
  RC=$?
}

tree() { (cd "$SB" && find . -path ./calls.log -prune -o -print | LC_ALL=C sort); (cd "$SB" && find data outside -type f -exec cksum {} + | LC_ALL=C sort); }
calls() { cat "$STUB_LOG"; }
# mutating_calls: everything except the read-only probes (unit exists, list profiles).
mutating_calls() { grep -v -F -e "systemctl [cat]" -e "nmcli [-t]" "$STUB_LOG" || true; }
line_of() { calls | grep -n -F -- "$1" | head -1 | cut -d: -f1; }

echo "prepare-handoff.sh tests"

# ---- 0. the script exists, parses, is executable -----------------------------
if [[ -f "$SCRIPT" ]] && bash -n "$SCRIPT"; then ok; else bad "prepare-handoff.sh missing or does not parse"; fi
if [[ -x "$SCRIPT" ]]; then ok; else bad "prepare-handoff.sh not executable"; fi

# ---- 1. argument validation ----------------------------------------------------
new_sandbox
before="$(tree)"
run_ph --yes
assert_eq "$RC" 2 "neither photo flag"
run_ph --yes --clear-photos --keep-photos
assert_eq "$RC" 2 "both photo flags"
run_ph --yes --keep-photos --bogus
assert_eq "$RC" 2 "unknown flag"
for bad_dir in "" "/" "relative/path" "$DATA/../etc" "//"; do
  OUT="$(cd "$SB" && env FRAME_DATA_DIR="$bad_dir" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --dry-run --yes --keep-photos --no-shutdown 2>&1 < /dev/null)"
  assert_eq "$?" 2 "bad FRAME_DATA_DIR [$bad_dir]"
done
OUT="$(cd "$SB" && env -u FRAME_DATA_DIR FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
  bash "$SCRIPT" --dry-run --yes --keep-photos --no-shutdown 2>&1 < /dev/null)"
assert_eq "$?" 2 "test override refuses the default /data"
assert_eq "$(calls)" "" "argument errors run no commands"
run_ph --clear-photos --no-shutdown
assert_eq "$RC" 1 "non-TTY without --yes aborts"
assert_contains "$OUT" "--yes" "non-TTY message mentions --yes"
assert_eq "$(mutating_calls)" "" "non-TTY abort ran no mutating commands"
assert_eq "$(tree)" "$before" "argument errors and non-TTY abort change nothing"
# not root and no test override
if [[ $EUID -ne 0 ]]; then
  : > "$STUB_LOG"
  OUT="$(cd "$SB" && env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$SB/handoff.log" PATH="$BIN:$PATH" bash "$SCRIPT" --yes --keep-photos 2>&1 < /dev/null)"
  assert_eq "$?" 4 "non-root real run refused"
  assert_eq "$(calls)" "" "non-root refusal ran no commands"
fi
# not installer-built
mv "$DATA/current" "$SB/current.aside"
run_ph --yes --keep-photos --no-shutdown
assert_eq "$RC" 3 "missing current refused without --force"
assert_eq "$(mutating_calls)" "" "refusal ran no mutating commands"
mv "$SB/current.aside" "$DATA/current"

# ---- 2. dry run -----------------------------------------------------------------
new_sandbox
before="$(tree)"
run_ph --dry-run --clear-photos
assert_eq "$RC" 0 "dry-run exit"
for n in 1 2 3 4 5 6 7; do assert_contains "$OUT" "[$n/7]" "dry-run step $n"; done
order_ok=1
prev=0
for pat in "[1/7]" "[2/7]" "[3/7]" "[4/7]" "[5/7]" "[6/7]" "[7/7]"; do
  rest="${OUT#*"$pat"}"
  pos=$((${#OUT} - ${#rest}))
  if [[ "$OUT" != *"$pat"* || $pos -le $prev ]]; then order_ok=0; fi
  prev=$pos
done
assert_eq "$order_ok" 1 "dry-run steps appear in order"
ts_pos="${OUT%%tailscale logout*}"
nm_pos="${OUT%%nmcli connection delete*}"
po_pos="${OUT%%systemctl poweroff*}"
if [[ ${#ts_pos} -lt ${#nm_pos} && ${#nm_pos} -lt ${#po_pos} ]]; then ok; else bad "dry-run: tailscale logout < nmcli delete < poweroff"; fi
assert_contains "$OUT" "SSH session" "dry-run warns that SSH over WiFi drops"
assert_contains "$OUT" "systemctl start tailscaled" "dry-run restarts tailscaled after clearing its state"
assert_contains "$OUT" "tailscale set --operator=frame" "dry-run re-asserts the Tailscale operator"
assert_eq "$(calls)" "" "dry-run runs no commands at all"
assert_eq "$(tree)" "$before" "dry-run changes nothing"
run_ph --dry-run --keep-photos --no-shutdown
assert_eq "$RC" 0 "dry-run keep-photos exit"
assert_contains "$OUT" "Keeping photos" "dry-run keep-photos"
assert_not_contains "$OUT" "systemctl poweroff" "dry-run --no-shutdown has no poweroff command"
run_ph --dry-run
assert_eq "$RC" 2 "dry-run still validates arguments"

# ---- 3. real run, --clear-photos --------------------------------------------------
new_sandbox
run_ph --yes --clear-photos
assert_eq "$RC" 0 "clear-photos exit (output: $OUT)"
if [[ -d "$DATA/uploads" ]]; then ok; else bad "uploads directory kept"; fi
assert_eq "$(find "$DATA/uploads" -mindepth 1 | wc -l | tr -d ' ')" 0 "uploads emptied (incl. dotfile, subdir, symlinks)"
present "$OUTSIDE/keep.txt" "symlink target outside the root survives"
present "$OUTSIDE" "directory symlink target outside the root survives"
assert_eq "$(cat "$DATA/data/images.json")" "[]" "images.json reset"
assert_eq "$(cat "$DATA/data/collections.json")" "[]" "collections.json reset"
state="$(cat "$DATA/data/slideshow-state.json")"
assert_eq "$state" '{
  "currentImageId": null,
  "duration": 120000,
  "activeCollectionId": null
}' "slideshow state reset to the server default"
absent "$DATA/update-status.json" "update-status.json removed"
absent "$DATA/log/power-log.csv" "power-log.csv removed"
absent "$DATA/log/power-log.csv.1" "rotated power log removed"
present "$DATA/log/other.log" "other logs untouched"
if [[ -d "$DATA/system/tailscale" ]]; then ok; else bad "tailscale directory kept"; fi
assert_eq "$(find "$DATA/system/tailscale" -mindepth 1 | wc -l | tr -d ' ')" 0 "tailscale state emptied"
absent "$DATA/system/NetworkManager/Home.nmconnection" "wifi keyfile removed"
absent "$DATA/system/NetworkManager/Hotspot.nmconnection" "hotspot keyfile removed"
present "$DATA/system/NetworkManager/Wired.nmconnection" "ethernet keyfile kept"
present "$DATA/releases/v1.0.0/index.js" "releases untouched"
if [[ -L "$DATA/current" && "$(readlink "$DATA/current")" == releases/v1.0.0 ]]; then ok; else bad "current symlink untouched"; fi
for u in "$UUID_A" "$UUID_H" "$UUID_Q"; do
  n="$(calls | grep -c -F -x "nmcli [connection] [delete] [uuid] [$u]")"
  assert_eq "$n" 1 "wifi $u deleted exactly once via uuid"
done
assert_not_contains "$(calls)" "$UUID_E" "ethernet profile never touched"
assert_not_contains "$(calls)" "Cafe" "profile names never reach argv"
absent "$SB/pwned" "profile name is not executed"
absent "$SB/state/pwned" "profile name is not executed (state)"
assert_eq "$(grep -c . "$STUB_STATE/nm-profiles")" 1 "only the ethernet profile remains"
assert_contains "$OUT" "Home" "profile names are printed"
assert_contains "$OUT" 'My "Cafe"; net:5G' "odd profile name printed (unescaped)"
assert_not_contains "$OUT" "hunter2" "no wifi password printed"
assert_not_contains "$OUT" "tskey-SECRET" "no tailscale key printed"
assert_contains "$OUT" "Tailscale admin" "reminder to delete the machine in the Tailscale admin console"
assert_contains "$OUT" "Safe to unplug" "final message"
l_logout="$(line_of "tailscale [logout]")"
l_tsstop="$(line_of "systemctl [stop] [tailscaled")"
l_del="$(line_of "nmcli [connection] [delete]")"
l_sync="$(line_of "sync")"
l_off="$(line_of "systemctl [poweroff]")"
l_srv="$(line_of "systemctl [stop] [photo-frame-server.service]")"
last_call="$(calls | tail -1)"
assert_eq "$last_call" "systemctl [poweroff]" "poweroff is the last recorded call"
if [[ -n "$l_srv" && -n "$l_logout" && -n "$l_tsstop" && -n "$l_del" && -n "$l_sync" && -n "$l_off" \
  && "$l_srv" -lt "$l_logout" && "$l_logout" -lt "$l_tsstop" && "$l_tsstop" -lt "$l_del" && "$l_del" -lt "$l_sync" && "$l_sync" -lt "$l_off" ]]; then
  ok
else
  bad "call order: server stop < ts logout < tailscaled stop < nmcli delete < sync < poweroff ($l_srv $l_logout $l_tsstop $l_del $l_sync $l_off)"
fi
# the cleared Tailscale state held the operator pref: start tailscaled, re-set it, stop again
l_tsstart="$(line_of "systemctl [start] [tailscaled]")"
l_oper="$(line_of "tailscale [set] [--operator=frame]")"
l_tsstop2="$(calls | grep -n -F "systemctl [stop] [tailscaled]" | sed -n 2p | cut -d: -f1)"
if [[ -n "$l_tsstart" && -n "$l_oper" && -n "$l_tsstop2" \
  && "$l_tsstop" -lt "$l_tsstart" && "$l_tsstart" -lt "$l_oper" && "$l_oper" -lt "$l_tsstop2" && "$l_tsstop2" -lt "$l_del" ]]; then
  ok
else
  bad "operator re-assert: tailscaled stop < start < set --operator=frame < stop < nmcli delete ($l_tsstop $l_tsstart $l_oper $l_tsstop2 $l_del)"
fi
# last nmcli list (verification) comes after the deletes
last_list="$(calls | grep -n -F "nmcli [-t]" | tail -1 | cut -d: -f1)"
last_del="$(calls | grep -n -F "nmcli [connection] [delete]" | tail -1 | cut -d: -f1)"
if [[ "$last_list" -gt "$last_del" ]]; then ok; else bad "deletion is verified by a final listing"; fi
assert_contains "$(calls)" "journalctl [--rotate]" "journal rotated"
assert_contains "$(calls)" "journalctl [--vacuum-time=1s]" "journal vacuumed"

# second run: harmless no-op that still shuts down
: > "$STUB_LOG"
run_ph --yes --clear-photos
assert_eq "$RC" 0 "second run exit"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "second run still powers off"
assert_not_contains "$(calls)" "[delete]" "second run deletes no wifi profile"
assert_not_contains "$(calls)" "[logout]" "second run does not log out again"
present "$DATA/system/NetworkManager/Wired.nmconnection" "ethernet kept after second run"
present "$OUTSIDE/keep.txt" "outside file survives second run"

# ---- 4. real run, --keep-photos ------------------------------------------------------
new_sandbox
run_ph --yes --keep-photos
assert_eq "$RC" 0 "keep-photos exit (output: $OUT)"
assert_contains "$OUT" "Keeping photos" "keep-photos message"
present "$DATA/uploads/a.jpg" "photo kept"
present "$DATA/uploads/.hidden" "dotfile photo kept"
present "$DATA/uploads/sub/b.jpg" "nested photo kept"
assert_eq "$(cat "$DATA/data/images.json")" '[{"id":"x"}]' "images.json untouched"
assert_eq "$(cat "$DATA/data/collections.json")" '[{"id":"c"}]' "collections.json untouched"
assert_contains "$(cat "$DATA/data/slideshow-state.json")" '"currentImageId":"x"' "slideshow state untouched"
absent "$DATA/update-status.json" "update-status removed with --keep-photos"
absent "$DATA/log/power-log.csv" "power log removed with --keep-photos"
assert_eq "$(find "$DATA/system/tailscale" -mindepth 1 | wc -l | tr -d ' ')" 0 "tailscale cleared with --keep-photos"
absent "$DATA/system/NetworkManager/Home.nmconnection" "wifi removed with --keep-photos"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "poweroff last"

# ---- 5. --no-shutdown ------------------------------------------------------------------
new_sandbox
run_ph --yes --keep-photos --no-shutdown
assert_eq "$RC" 0 "no-shutdown exit"
assert_not_contains "$(calls)" "poweroff" "--no-shutdown records no poweroff"
assert_contains "$OUT" "Safe to unplug" "final message also with --no-shutdown"
assert_contains "$(calls)" "[delete]" "--no-shutdown still clears wifi"

# ---- 5b. losing the terminal must not stop the run ----------------------------------------
# (a) stdout becomes a closed pipe right after the log announcement
new_sandbox
{ env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$SB/handoff.log" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --yes --clear-photos < /dev/null 2>&1; echo $? > "$SB/rc"; } \
  | { while IFS= read -r l; do [[ "$l" == *handoff.log* ]] && break; done; } > /dev/null
assert_eq "$(cat "$SB/rc" 2> /dev/null)" 0 "closed stdout: exit 0"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "closed stdout: poweroff still last"
assert_contains "$(cat "$SB/handoff.log" 2> /dev/null)" "Safe to unplug" "closed stdout: run continues in the log"
assert_not_contains "$(cat "$SB/handoff.log" 2> /dev/null)" "hunter2" "log has no wifi password"
assert_not_contains "$(cat "$SB/handoff.log" 2> /dev/null)" "tskey-SECRET" "log has no tailscale key"
absent "$DATA/system/NetworkManager/Home.nmconnection" "closed stdout: wifi still wiped"
# (b) SIGHUP during the tailscale step
new_sandbox
( cd "$SB" && STUB_HUP_PIDFILE="$SB/pid" exec env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$SB/handoff.log" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --yes --clear-photos > "$SB/out.txt" 2>&1 < /dev/null ) &
hp=$!
echo "$hp" > "$SB/pid"
wait "$hp"
assert_eq "$?" 0 "SIGHUP during run: exit 0"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "SIGHUP: poweroff still last"
assert_contains "$(calls)" "[delete]" "SIGHUP: wifi deleted"
# (b2) Ctrl-C after the confirmation: SIGINT to the script's whole process group
new_sandbox
set -m # the run gets its own process group, with SIGINT not pre-ignored
( cd "$SB" && STUB_INT_PGID_FILE="$SB/pgid" exec env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$SB/handoff.log" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --yes --clear-photos > "$SB/out.txt" 2>&1 < /dev/null ) &
ip=$!
set +m
echo "$ip" > "$SB/pgid"
wait "$ip"
assert_eq "$?" 0 "SIGINT during run: exit 0"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "SIGINT: poweroff still recorded last"
assert_contains "$(calls)" "[delete]" "SIGINT: wifi deleted"
# (b3) a stale log from an earlier run in the same boot is not replayed, and the log is private
new_sandbox
printf 'STALE-EARLIER-RUN\n' > "$SB/handoff.log"
chmod 644 "$SB/handoff.log"
run_ph --yes --keep-photos
assert_eq "$RC" 0 "stale log: exit"
assert_not_contains "$OUT" "STALE-EARLIER-RUN" "stale log is not shown by the follower"
assert_not_contains "$(cat "$SB/handoff.log")" "STALE-EARLIER-RUN" "log truncated when logging starts"
assert_contains "$(cat "$SB/handoff.log")" "Safe to unplug" "new run logged"
assert_eq "$(stat -c %a "$SB/handoff.log" 2> /dev/null || stat -f %Lp "$SB/handoff.log")" 600 "log is mode 600"
# (b4) a hung tailscaled must not block the run (status is bounded by a timeout)
new_sandbox
: > "$STUB_STATE/ts-hang"
export FRAME_HANDOFF_TAILSCALE_TIMEOUT=1
t0=$SECONDS
run_ph --yes --keep-photos
unset FRAME_HANDOFF_TAILSCALE_TIMEOUT
assert_eq "$RC" 0 "hung tailscale status: exit 0"
if [[ $((SECONDS - t0)) -lt 20 ]]; then ok; else bad "hung tailscale status blocked the run for $((SECONDS - t0)) s"; fi
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "hung tailscale status: poweroff still last"
for tv in 0 abc 012 -1; do
  OUT="$(cd "$SB" && env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_TAILSCALE_TIMEOUT="$tv" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --dry-run --yes --keep-photos 2>&1 < /dev/null)"
  assert_eq "$?" 2 "bad FRAME_HANDOFF_TAILSCALE_TIMEOUT [$tv]"
done
# (c) the log may never live on the persistent partition
new_sandbox
for lp in "$DATA/h.log" "/data/h.log" "relative.log" ""; do
  OUT="$(cd "$SB" && env FRAME_DATA_DIR="$DATA" FRAME_HANDOFF_LOG="$lp" FRAME_HANDOFF_TEST_ALLOW_NONROOT=1 PATH="$BIN:$PATH" \
    bash "$SCRIPT" --dry-run --yes --keep-photos 2>&1 < /dev/null)"
  assert_eq "$?" 2 "bad FRAME_HANDOFF_LOG [$lp]"
done

# ---- 5c. the operator re-assert is best effort ---------------------------------------------
new_sandbox
: > "$STUB_STATE/ts-set-fails"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"; chmod +x "$BIN/sleep"
run_ph --yes --keep-photos
rm -f "$BIN/sleep"
assert_eq "$(calls | grep -c -F "tailscale [set] [--operator=frame]")" 10 "operator re-assert retried 10 times"
assert_eq "$RC" 0 "operator re-assert failing: still exit 0 (output: $OUT)"
assert_contains "$(cat "$SB/handoff.log")" "could not set the Tailscale operator" "operator failure is reported"
assert_eq "$(calls | tail -1)" "systemctl [poweroff]" "operator failure: poweroff still last"
assert_eq "$(calls | grep -c -F "systemctl [stop] [tailscaled]")" 2 "operator failure: tailscaled stopped again"

# ---- 6. safety: unsafe layouts and failures ----------------------------------------------
new_sandbox
rm -rf "$DATA/uploads"
ln -s "$OUTSIDE" "$DATA/uploads"
run_ph --yes --clear-photos --no-shutdown
if [[ "$RC" -ne 0 ]]; then ok; else bad "uploads symlinked outside the root must be refused"; fi
present "$OUTSIDE/keep.txt" "files behind a symlinked uploads dir survive"
assert_eq "$(calls)" "" "unsafe layout is refused before any command runs"

new_sandbox
rm -rf "$DATA/system/tailscale"
ln -s "$OUTSIDE" "$DATA/system/tailscale"
run_ph --yes --keep-photos --no-shutdown
if [[ "$RC" -ne 0 ]]; then ok; else bad "tailscale dir symlinked outside the root must be refused"; fi
present "$OUTSIDE/keep.txt" "files behind a symlinked tailscale dir survive"

# a wifi profile that cannot be deleted: no poweroff, non-zero exit
new_sandbox
make_stub_nmcli_orig="$(cat "$BIN/nmcli")"
printf '#!/usr/bin/env bash\n{ printf "nmcli"; for a in "$@"; do printf " [%%s]" "$a"; done; echo; } >> "$STUB_LOG"\nif [[ "$1" == connection ]]; then exit 1; fi\ncat "$STUB_STATE/nm-profiles"\n' > "$BIN/nmcli"
run_ph --yes --keep-photos
if [[ "$RC" -ne 0 ]]; then ok; else bad "failed wifi deletion must fail the run"; fi
assert_not_contains "$(calls)" "poweroff" "no poweroff when a wifi profile survived"
printf '%s\n' "$make_stub_nmcli_orig" > "$BIN/nmcli"

# ---- 7. install.sh summary ---------------------------------------------------------------------
INSTALL="$PI/install.sh"
summary_text="$(sed -n '/^summary() {/,/^}/p' "$INSTALL")"
assert_contains "$summary_text" 'http://$NAME.local/' "install summary prints the port-80 admin URL"
assert_not_contains "$summary_text" ':3000' "install summary no longer mentions :3000"
assert_contains "$summary_text" "sudo ./pi/prepare-handoff.sh --clear-photos|--keep-photos" "install summary points at prepare-handoff"

echo "prepare-handoff tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
