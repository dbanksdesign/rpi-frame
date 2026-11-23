#!/usr/bin/env bash
# Offline tests for scripts/make-release.sh. Works on macOS and Linux.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/make-release.sh"
UPDATER="$HERE/../pi/updater/frame-update.sh"
REAL_CURL="$(command -v curl)"
ROOT="$(mktemp -d)"
trap 'chmod -R u+rwX "$ROOT" 2>/dev/null; rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok; else bad "$3: expected [$2] got [$1]"; fi; }
assert_true() { if "${@:2}"; then ok; else bad "$1"; fi; }

sha_of() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# new_project: fake project dir + output dir
new_project() {
  SB="$(mktemp -d "$ROOT/sb.XXXXXX")"
  PROJ="$SB/proj"; OUTD="$SB/out"
  mkdir -p "$PROJ/dist/server" "$PROJ/dist/client" "$PROJ/uploads" "$PROJ/data" "$PROJ/.git" "$PROJ/.docs"
  echo "// server" > "$PROJ/dist/server/index.js"
  echo "<html></html>" > "$PROJ/dist/client/index.html"
  echo '{"name":"x"}' > "$PROJ/package.json"
  echo '{"lockfileVersion":3}' > "$PROJ/package-lock.json"
  echo secret > "$PROJ/uploads/photo.jpg"; echo secret > "$PROJ/data/settings.json"
  echo x > "$PROJ/.git/HEAD"; echo x > "$PROJ/.docs/plan.md"
  export FRAME_PROJECT_DIR="$PROJ" FRAME_RELEASE_OUT="$OUTD"
}

run_release() {
  OUT="$SB/run.txt"
  bash "$SCRIPT" "$@" > "$OUT" 2>&1
  RC=$?
}

t_contents() {
  new_project
  run_release v1.2.3 --skip-build --skip-install
  assert_eq "$RC" 0 "exit code"
  local tgz="$OUTD/frame-v1.2.3.tar.gz" sum="$OUTD/frame-v1.2.3.tar.gz.sha256"
  assert_true "tarball exists" test -f "$tgz"
  assert_true "sha256 exists" test -f "$sum"
  assert_eq "$(cat "$sum")" "$(sha_of "$tgz")  frame-v1.2.3.tar.gz" "sha256 file content"
  assert_true "sha256 format" grep -Eq '^[0-9a-f]{64}  frame-v1\.2\.3\.tar\.gz$' "$sum"
  local list e
  list="$(tar -tzf "$tgz")"
  for e in dist/server/index.js dist/client/index.html package.json package-lock.json VERSION; do
    assert_true "lists $e" grep -qx "$e" <<< "$list"
  done
  assert_true "no ./ prefix" test -z "$(grep '^\./' <<< "$list")"
  assert_true "no absolute paths" test -z "$(grep '^/' <<< "$list")"
  assert_true "no .. components" test -z "$(grep -E '(^|/)\.\.(/|$)' <<< "$list")"
  assert_true "no excluded entries" test -z "$(grep -E '(^|/)(uploads|data|\.git|\.docs|\.superpowers|\.claude)(/|$)|(^|/)\._' <<< "$list")"
  assert_true "skip-install omits node_modules" test -z "$(grep node_modules <<< "$list")"
  local x="$SB/x"; mkdir "$x"; tar -xzf "$tgz" -C "$x"
  assert_eq "$(cat "$x/VERSION")" v1.2.3 "VERSION content"
  assert_eq "$(ls "$OUTD" | wc -l | tr -d ' ')" 2 "only the two assets in out dir"
}

t_invalid_tags() {
  new_project
  local t
  for t in "" v1 v1.2 1.2.3 v1.2.3.4 'v1.2.3; rm -rf /' $'v1.2.3\n' '../v1.2.3' 'v1.2.3 '; do
    run_release "$t" --skip-build --skip-install
    assert_true "invalid tag [$t] rejected" test "$RC" -ne 0
    assert_true "nothing created for [$t]" test ! -e "$OUTD"
  done
  run_release
  assert_true "no args rejected" test "$RC" -ne 0
  assert_true "nothing created (no args)" test ! -e "$OUTD"
}

t_twice() {
  new_project
  run_release v1.2.3 --skip-build --skip-install
  run_release v1.2.3 --skip-build --skip-install
  assert_eq "$RC" 0 "second run exit"
  assert_eq "$(ls "$OUTD" | tr '\n' ' ')" "frame-v1.2.3.tar.gz frame-v1.2.3.tar.gz.sha256 " "outputs"
  assert_eq "$(cat "$OUTD/frame-v1.2.3.tar.gz.sha256")" "$(sha_of "$OUTD/frame-v1.2.3.tar.gz")  frame-v1.2.3.tar.gz" "sha matches after rerun"
}

t_missing_dist() {
  new_project
  rm -rf "$PROJ/dist/server"
  run_release v1.2.3 --skip-build --skip-install
  assert_true "missing dist/server/index.js rejected" test "$RC" -ne 0
}

# Run the real updater against the produced tarball.
t_updater_accepts() {
  new_project
  run_release v1.2.3 --skip-build --skip-install
  assert_eq "$RC" 0 "release exit"
  local stubs="$SB/stubs" data="$SB/data"
  mkdir -p "$stubs" "$data/releases" "$SB/lock" "$SB/srv/v1.2.3"
  cat > "$stubs/curl" <<'STUB'
#!/usr/bin/env bash
url=""; for a in "$@"; do url="$a"; done
case "$url" in http://health.test/*) exit 0 ;; esac
exec "$REAL_CURL" "$@"
STUB
  printf '#!/usr/bin/env bash\nexit 0\n' > "$stubs/systemctl"
  if ! command -v flock > /dev/null 2>&1; then
    cat > "$stubs/flock" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "-n" ]] || exit 64
exec python3 -I -c 'import fcntl,sys
try:
    fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)' "$2"
STUB
  fi
  chmod +x "$stubs"/*
  cp "$OUTD"/frame-v1.2.3.tar.gz "$OUTD"/frame-v1.2.3.tar.gz.sha256 "$SB/srv/v1.2.3/"
  (
    export REAL_CURL FRAME_DATA_DIR="$data" FRAME_LOCK_FILE="$SB/lock/frame-update.lock" \
      FRAME_RELEASE_BASE_URL="file://$SB/srv" FRAME_HEALTH_URL="http://health.test/api/health" \
      FRAME_HEALTH_TIMEOUT=2 FRAME_HEALTH_INTERVAL=1 FRAME_SERVICE=photo-frame-server
    PATH="$stubs:$PATH" bash "$UPDATER" v1.2.3 > "$SB/upd.txt" 2>&1
    echo $? > "$SB/upd.rc"
  )
  assert_eq "$(cat "$SB/upd.rc")" 0 "updater exit"
  assert_eq "$(readlink "$data/current")" releases/v1.2.3 "current points at new release"
  assert_true "installed index.js" test -f "$data/releases/v1.2.3/dist/server/index.js"
}

for t in t_contents t_invalid_tags t_twice t_missing_dist t_updater_accepts; do
  echo "== $t"
  "$t"
done

echo
echo "passed: $PASS, failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
