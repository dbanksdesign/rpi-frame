#!/usr/bin/env bash
# Offline tests for pi/updater/frame-update.sh. Works on macOS and Linux:
# curl (health only), systemctl and (if missing) flock are stubbed on PATH.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../frame-update.sh"
REAL_CURL="$(command -v curl)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok; else bad "$3: expected [$2] got [$1]"; fi; }
assert_true() { if "${@:2}"; then ok; else bad "$1"; fi; }

# ---- stubs -----------------------------------------------------------------
STUBS="$ROOT/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/curl.log"
if [[ ! -e "$STUB_STATE/first_curl" ]]; then
  : > "$STUB_STATE/first_curl"
  cp -f "$FRAME_DATA_DIR/update-status.json" "$STUB_STATE/status-at-first-curl.json" 2>/dev/null || true
fi
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  http://health.test/*)
    [[ "$(cat "$STUB_STATE/health")" == ok ]] && exit 0
    exit 22 ;;
esac
exec "$REAL_CURL" "$@"
STUB
cat > "$STUBS/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/systemctl.log"
STUB
if ! command -v flock > /dev/null 2>&1; then
  cat > "$STUBS/flock" <<'STUB'
#!/usr/bin/env bash
# test-only shim: flock -n <fd>
[[ "$1" == "-n" ]] || exit 64
exec python3 -I -c 'import fcntl,sys
try:
    fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)' "$2"
STUB
fi
chmod +x "$STUBS"/*

# ---- helpers ---------------------------------------------------------------
sha_of() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

new_sandbox() {
  SB="$(mktemp -d "$ROOT/sb.XXXXXX")"
  export FRAME_DATA_DIR="$SB/data"
  export STUB_STATE="$SB/state"
  export REAL_CURL
  mkdir -p "$STUB_STATE" "$SB/srv"
  echo ok > "$STUB_STATE/health"
  export FRAME_RELEASE_BASE_URL="file://$SB/srv"
  export FRAME_HEALTH_URL="http://health.test/api/health"
  export FRAME_HEALTH_TIMEOUT=2
  export FRAME_HEALTH_INTERVAL=1
  export FRAME_KEEP=2
  export FRAME_SERVICE=photo-frame-server
}

# publish_release <tag> [version-in-file]  -> good tarball + checksum
publish_release() {
  local tag="$1" ver="${2:-$1}" src="$SB/src-$1"
  rm -rf "$src"; mkdir -p "$src/dist/server" "$SB/srv/$tag"
  echo "// server" > "$src/dist/server/index.js"
  echo "$ver" > "$src/VERSION"
  tar -C "$src" -czf "$SB/srv/$tag/frame-$tag.tar.gz" .
  echo "$(sha_of "$SB/srv/$tag/frame-$tag.tar.gz")  frame-$tag.tar.gz" > "$SB/srv/$tag/frame-$tag.tar.gz.sha256"
}

# publish_raw_tar <tag> <tarfile>: serve an arbitrary tar with a matching checksum
publish_raw_tar() {
  mkdir -p "$SB/srv/$1"
  cp "$2" "$SB/srv/$1/frame-$1.tar.gz"
  echo "$(sha_of "$2")  frame-$1.tar.gz" > "$SB/srv/$1/frame-$1.tar.gz.sha256"
}

# old_release <tag> <touch -t stamp>
old_release() {
  mkdir -p "$FRAME_DATA_DIR/releases/$1/dist/server"
  echo "$1" > "$FRAME_DATA_DIR/releases/$1/VERSION"
  touch -t "$2" "$FRAME_DATA_DIR/releases/$1"
}

run_update() {
  OUT="$SB/out.txt"
  PATH="$STUBS:$PATH" bash "$SCRIPT" "$@" > "$OUT" 2>&1
  RC=$?
}

status_json() { cat "$FRAME_DATA_DIR/update-status.json" 2>/dev/null; }
calls() { local n; n=$(grep -c . "$STUB_STATE/systemctl.log" 2>/dev/null) || n=0; echo "$n"; }
cur() { readlink "$FRAME_DATA_DIR/current" 2>/dev/null; }
no_tmp_left() { ! compgen -G "$FRAME_DATA_DIR/releases/.tmp-*" > /dev/null; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# ---- tests -----------------------------------------------------------------
t_success() {
  new_sandbox
  old_release v0.0.1 202401010000; old_release v0.0.2 202401020000; old_release v0.0.3 202401030000
  ln -s releases/v0.0.3 "$FRAME_DATA_DIR/current"
  publish_release v1.0.0
  run_update v1.0.0
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(cur)" releases/v1.0.0 "current"
  assert_eq "$(status_json)" '{"state":"succeeded","tag":"v1.0.0","message":"Updated to v1.0.0"}' "status"
  assert_eq "$(ls "$FRAME_DATA_DIR/releases" | tr '\n' ' ')" "v0.0.3 v1.0.0 " "pruned to newest 2"
  assert_eq "$(calls)" 1 "systemctl restart calls"
  assert_eq "$(cat "$STUB_STATE/systemctl.log")" "restart photo-frame-server" "systemctl args"
  assert_true "no temp dir left" no_tmp_left
  assert_eq "$(file_mode "$FRAME_DATA_DIR/update-status.json")" 644 "status mode"
}

t_bad_checksum() {
  new_sandbox
  old_release v0.0.1 202401010000; ln -s releases/v0.0.1 "$FRAME_DATA_DIR/current"
  publish_release v1.0.0
  echo "$(printf '0%.0s' {1..64})  frame-v1.0.0.tar.gz" > "$SB/srv/v1.0.0/frame-v1.0.0.tar.gz.sha256"
  run_update v1.0.0
  assert_eq "$RC" 10 "exit code"
  assert_eq "$(cur)" releases/v0.0.1 "current unchanged"
  assert_true "no temp dir left" no_tmp_left
  assert_true "release not installed" test ! -e "$FRAME_DATA_DIR/releases/v1.0.0"
  assert_eq "$(status_json)" '{"state":"failed","tag":"v1.0.0","message":"The download could not be verified; nothing was changed"}' "status"
  assert_eq "$(calls)" 0 "service not restarted"
}

t_garbage_tarball() {
  new_sandbox
  old_release v0.0.1 202401010000; ln -s releases/v0.0.1 "$FRAME_DATA_DIR/current"
  head -c 3000 /dev/urandom > "$SB/garbage.bin"
  publish_raw_tar v1.0.0 "$SB/garbage.bin"
  run_update v1.0.0
  assert_eq "$RC" 10 "garbage exit"
  assert_eq "$(cur)" releases/v0.0.1 "current unchanged (garbage)"
  assert_true "no temp left (garbage)" no_tmp_left
  publish_release v1.0.1
  head -c 100 "$SB/srv/v1.0.1/frame-v1.0.1.tar.gz" > "$SB/trunc.tgz"
  publish_raw_tar v1.0.1 "$SB/trunc.tgz"
  run_update v1.0.1
  assert_eq "$RC" 10 "truncated exit"
  assert_eq "$(cur)" releases/v0.0.1 "current unchanged (truncated)"
  assert_eq "$(calls)" 0 "service not restarted"
}

t_health_rollback() {
  new_sandbox
  old_release v0.0.1 202401010000; ln -s releases/v0.0.1 "$FRAME_DATA_DIR/current"
  publish_release v1.0.0
  echo fail > "$STUB_STATE/health"
  run_update v1.0.0
  assert_eq "$RC" 11 "exit code"
  assert_eq "$(cur)" releases/v0.0.1 "rolled back"
  assert_eq "$(calls)" 2 "restart twice"
  assert_eq "$(status_json)" '{"state":"failed","tag":"v1.0.0","message":"The new version didn'"'"'t start; restored the previous version"}' "status"
  assert_true "no temp left" no_tmp_left
}

t_concurrent() {
  new_sandbox
  mkdir -p "$FRAME_DATA_DIR"
  local sentinel='{"state":"running","tag":"v0.9.9","message":"Downloading…"}'
  printf '%s' "$sentinel" > "$FRAME_DATA_DIR/update-status.json"
  python3 -I -c 'import fcntl,sys,time
f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX)
open(sys.argv[2],"w").close(); time.sleep(30)' "$FRAME_DATA_DIR/.update.lock" "$SB/held" &
  local holder=$! i
  for i in $(seq 1 50); do [[ -e "$SB/held" ]] && break; sleep 0.1; done
  publish_release v1.0.0
  run_update v1.0.0
  kill "$holder" 2> /dev/null; wait "$holder" 2> /dev/null
  assert_eq "$RC" 12 "exit code"
  assert_eq "$(status_json)" "$sentinel" "status untouched"
  assert_eq "$(calls)" 0 "no restart"
}

t_invalid_tags() {
  new_sandbox
  publish_release v1.2.3
  local t
  for t in "" v1 v1.2.3.4 1.2.3 'v1.2.3; rm -rf /' $'v1.2.3\n' ../v1.2.3 'v1.2.3 ' 'v1.2.3/../x'; do
    run_update "$t"
    assert_eq "$RC" 2 "invalid tag [$t]"
    assert_true "nothing created for [$t]" test ! -e "$FRAME_DATA_DIR"
  done
  run_update v1.2.3 v1.2.4
  assert_eq "$RC" 2 "two args"
  run_update
  assert_eq "$RC" 2 "no args"
  assert_true "nothing created" test ! -e "$FRAME_DATA_DIR"
}

t_malicious() {
  new_sandbox
  old_release v0.0.1 202401010000; ln -s releases/v0.0.1 "$FRAME_DATA_DIR/current"
  local evil="$SB/evil-target"
  python3 -I - "$SB" "$evil" <<'PY'
import tarfile, io, sys
sb, evil = sys.argv[1], sys.argv[2]
def mk(name, entries):
    with tarfile.open(f"{sb}/{name}.tgz", "w:gz") as t:
        for ent in entries:
            t.addfile(*ent)
def f(path, data=b"x"):
    ti = tarfile.TarInfo(path); ti.size = len(data); return (ti, io.BytesIO(data))
def sym(path, target):
    ti = tarfile.TarInfo(path); ti.type = tarfile.SYMTYPE; ti.linkname = target; return (ti,)
def good(): return [f("dist/server/index.js"), f("VERSION", b"v1.0.0\n")]
mk("abs", good() + [f(evil)])
mk("dots", good() + [f("../evil-dots")])
mk("dots2", good() + [f("dist/../../evil-dots2")])
mk("symabs", good() + [sym("lnk", "/etc")])
mk("symup", good() + [sym("lnk", "../../outside")])
PY
  local n
  for n in abs dots dots2 symabs symup; do
    publish_raw_tar v1.0.0 "$SB/$n.tgz"
    run_update v1.0.0
    assert_eq "$RC" 10 "malicious $n exit"
    assert_eq "$(cur)" releases/v0.0.1 "current unchanged ($n)"
    assert_true "no temp ($n)" no_tmp_left
  done
  assert_true "abs entry not extracted" test ! -e "$evil"
  assert_true "dots not extracted" test ! -e "$SB/evil-dots" -a ! -e "$FRAME_DATA_DIR/evil-dots" -a ! -e "$FRAME_DATA_DIR/releases/evil-dots"
  assert_eq "$(calls)" 0 "never restarted"
}

t_safe_internal_symlink() {
  new_sandbox
  local src="$SB/src"; mkdir -p "$src/dist/server" "$src/node_modules/pkg/bin" "$src/node_modules/.bin"
  echo js > "$src/dist/server/index.js"; echo v1.0.0 > "$src/VERSION"; echo x > "$src/node_modules/pkg/bin/cli"
  ln -s ../pkg/bin/cli "$src/node_modules/.bin/cli"
  tar -C "$src" -czf "$SB/ok.tgz" .
  publish_raw_tar v1.0.0 "$SB/ok.tgz"
  run_update v1.0.0
  assert_eq "$RC" 0 "internal relative symlink allowed"
}

t_first_status_running() {
  new_sandbox
  publish_release v1.0.0
  run_update v1.0.0
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(cat "$STUB_STATE/status-at-first-curl.json")" '{"state":"running","tag":"v1.0.0","message":"Downloading…"}' "status at first curl"
}

t_version_mismatch() {
  new_sandbox
  old_release v0.0.1 202401010000; ln -s releases/v0.0.1 "$FRAME_DATA_DIR/current"
  publish_release v1.0.0 v9.9.9
  run_update v1.0.0
  assert_eq "$RC" 10 "exit code"
  assert_eq "$(cur)" releases/v0.0.1 "current unchanged"
  assert_true "not installed" test ! -e "$FRAME_DATA_DIR/releases/v1.0.0"
  assert_true "no temp left" no_tmp_left
}

t_first_install_and_reinstall() {
  new_sandbox
  publish_release v1.0.0
  run_update v1.0.0
  assert_eq "$RC" 0 "first install exit"
  assert_eq "$(cur)" releases/v1.0.0 "first install current"
  run_update v1.0.0
  assert_eq "$RC" 0 "reinstall same tag exit"
  assert_eq "$(ls -A "$FRAME_DATA_DIR/releases" | tr '\n' ' ')" "v1.0.0 " "no leftovers after reinstall"
}

for t in t_success t_bad_checksum t_garbage_tarball t_health_rollback t_concurrent t_invalid_tags \
  t_malicious t_safe_internal_symlink t_first_status_running t_version_mismatch t_first_install_and_reinstall; do
  echo "== $t"
  "$t"
done

echo
echo "passed: $PASS, failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
