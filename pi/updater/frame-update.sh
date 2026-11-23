#!/usr/bin/env bash
# frame-update <tag> -- root-owned updater with rollback.
# Installed as /usr/local/sbin/frame-update (NOT part of any release).
# Runs as root with a tag that originates from a web request: be defensive.
#
# Exit codes: 0 ok, 2 usage/invalid tag, 10 download/verify/unpack failure,
#             11 health check failed (rolled back), 12 already running.
set -euo pipefail

# ---- 1. validate the tag before touching anything ---------------------------
if [[ $# -ne 1 ]] || ! [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: frame-update vX.Y.Z" >&2
  exit 2
fi
TAG="$1"

DATA="${FRAME_DATA_DIR:-/data}"
BASE="${FRAME_RELEASE_BASE_URL:-https://github.com/dbanksdesign/rpi-frame/releases/download}"
SERVICE="${FRAME_SERVICE:-photo-frame-server}"
HEALTH_URL="${FRAME_HEALTH_URL:-http://localhost:3000/api/health}"
HEALTH_TIMEOUT="${FRAME_HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${FRAME_HEALTH_INTERVAL:-2}"
KEEP="${FRAME_KEEP:-2}"

LOCK_FILE="${FRAME_LOCK_FILE:-/run/frame-update.lock}"

RELEASES="$DATA/releases"
STATUS="$DATA/update-status.json"
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

# Numeric env values are used in arithmetic: never let anything else through.
for _v in "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL" "$KEEP"; do
  if ! [[ "$_v" =~ ^[0-9]+$ ]]; then
    echo "frame-update: FRAME_HEALTH_TIMEOUT, FRAME_HEALTH_INTERVAL and FRAME_KEEP must be integers" >&2
    exit 2
  fi
done

# The releases directory must be a real directory owned by us (root in
# production), so a less-privileged user cannot redirect what we write/delete.
if [[ -L "$RELEASES" || ! -d "$RELEASES" ]]; then
  echo "frame-update: $RELEASES must be an existing real directory" >&2
  exit 2
fi
_owner="$(stat -c %u "$RELEASES" 2> /dev/null || stat -f %u "$RELEASES")"
if [[ "$_owner" != "$(id -u)" ]]; then
  echo "frame-update: $RELEASES is not owned by the invoking user" >&2
  exit 2
fi

# ---- 2. lock (fd based: released automatically if we die) -------------------
# The lock lives outside the data dir (root-owned /run) and is opened without
# truncation so it cannot be abused to clobber files.
exec 9>> "$LOCK_FILE"
if ! flock -n 9; then
  echo "another update is already running" >&2
  exit 12
fi

# ---- status file (contract with the server) ---------------------------------
STATE=""   # last state written by us
TMPDIR_DL=""
ASIDE=""

# Only fixed message strings and the validated tag are ever interpolated.
write_status() { # <state> <message>
  local tmp
  tmp="$(mktemp "$DATA/.update-status.XXXXXX")"
  printf '{"state":"%s","tag":"%s","message":"%s"}' "$1" "$TAG" "$2" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS"
  STATE="$1"
}

SWITCHED=0   # 1 once `current` points at the new release
ROLLED=0
PREVIOUS=""
SLEEP_PID=""

# Best-effort restore of the previous release; never fails the caller.
rollback() {
  ROLLED=1
  set +e
  if [[ -n "$ASIDE" && -d "$ASIDE" ]]; then
    # Re-install of an existing tag: put the old directory back.
    rm -rf "${RELEASES:?}/$TAG"
    mv "$ASIDE" "$RELEASES/$TAG"
    ASIDE=""
  fi
  if [[ -n "$PREVIOUS" ]]; then
    point_current_at "$PREVIOUS"
    systemctl restart "$SERVICE"
    write_status failed "The new version didn't start; restored the previous version"
  else
    systemctl restart "$SERVICE"
    write_status failed "The new version didn't start"
  fi
  return 0
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  [[ -n "$SLEEP_PID" ]] && kill "$SLEEP_PID" 2> /dev/null
  if [[ "$SWITCHED" -eq 1 && "$ROLLED" -eq 0 && "$STATE" == running ]]; then
    rollback
    rc=11
  fi
  if [[ -n "$TMPDIR_DL" && -d "$TMPDIR_DL" ]]; then rm -rf "$TMPDIR_DL"; fi
  if [[ "$STATE" == running ]]; then
    write_status failed "The update stopped unexpectedly"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

write_status running "Starting…"

fail_download() { # <message>
  write_status failed "$1"
  exit 10
}

# ---- helpers ----------------------------------------------------------------
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# resolve_inside <dir-of-link ("" for root)> <target>: succeeds iff the lexically
# normalised target stays inside the archive root.
resolve_inside() {
  local dir="$1" target="$2" path part
  local -a parts out=()
  [[ "$target" == /* ]] && return 1
  path="$target"
  [[ -n "$dir" ]] && path="$dir/$target"
  IFS=/ read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    case "$part" in
      "" | .) ;;
      ..)
        [[ ${#out[@]} -eq 0 ]] && return 1
        unset 'out[${#out[@]}-1]' ;;
      *) out+=("$part") ;;
    esac
  done
  return 0
}

# Refuse archives that could write outside the extraction directory.
archive_is_safe() { # <tarball>
  local tarball="$1" name vline ltype target dir part
  local -a names=() vlines=() comps links=()
  local ln
  while IFS= read -r name; do names+=("$name"); done < <(tar -tzf "$tarball")
  while IFS= read -r vline; do vlines+=("$vline"); done < <(tar -tvzf "$tarball")
  [[ ${#names[@]} -gt 0 && ${#names[@]} -eq ${#vlines[@]} ]] || return 1
  local i
  for i in "${!names[@]}"; do
    name="${names[$i]}"
    vline="${vlines[$i]}"
    [[ "$name" == /* || "$name" == *\\* ]] && return 1
    IFS=/ read -r -a comps <<< "$name"
    for part in "${comps[@]}"; do [[ "$part" == ".." ]] && return 1; done
    # No entry may be written beneath a symlink created earlier in the archive.
    for ln in ${links[@]+"${links[@]}"}; do
      [[ "$name" == "$ln"/* ]] && return 1
    done
    ltype="${vline:0:1}"
    [[ "$ltype" == l || "$ltype" == h ]] && links+=("${name%/}")
    case "$ltype" in
      - | d) ;;
      l | h)
        if [[ "$ltype" == l ]]; then
          [[ "$vline" == *"$name -> "* ]] || return 1
          target="${vline##*"$name -> "}"
          dir="${name%/*}"; [[ "$dir" == "$name" ]] && dir=""
          resolve_inside "$dir" "$target" || return 1
        else
          [[ "$vline" == *"$name link to "* ]] || return 1
          target="${vline##*"$name link to "}"
          resolve_inside "" "$target" || return 1
        fi ;;
      *) return 1 ;; # devices, FIFOs, anything unexpected
    esac
  done
  return 0
}

# Atomic symlink replacement: current.new -> current.
if mv --version 2> /dev/null | grep -q GNU; then
  MV_SWAP=(mv -Tf)
else
  MV_SWAP=(mv -fh) # BSD/macOS (test hosts)
fi
point_current_at() { # <relative target>
  ln -sfn "$1" "$DATA/current.new"
  "${MV_SWAP[@]}" "$DATA/current.new" "$DATA/current"
}

# ---- 3. download -------------------------------------------------------------
write_status running "Downloading…"
mkdir -p "$RELEASES"
TMPDIR_DL="$(mktemp -d "$RELEASES/.tmp-$TAG-XXXXXX")"
TARBALL="$TMPDIR_DL/frame-$TAG.tar.gz"
SUMFILE="$TARBALL.sha256"
URL="$BASE/$TAG/frame-$TAG.tar.gz"

# https only (plus file:// so the offline tests work); redirects must stay https.
CURL_DL=(curl -fsSL --retry 2 --connect-timeout 15 --max-time 600 --proto '=https,file' --proto-redir '=https')
"${CURL_DL[@]}" -o "$TARBALL" "$URL" || fail_download "Download failed; nothing was changed"
"${CURL_DL[@]}" -o "$SUMFILE" "$URL.sha256" || fail_download "Download failed; nothing was changed"

# ---- 4. verify ---------------------------------------------------------------
write_status running "Verifying…"
EXPECTED=""
read -r EXPECTED _ < "$SUMFILE" || true
EXPECTED="$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || fail_download "The download could not be verified; nothing was changed"
ACTUAL="$(sha256_of "$TARBALL")"
[[ "$ACTUAL" == "$EXPECTED" ]] || fail_download "The download could not be verified; nothing was changed"

# ---- 5. safe unpack ----------------------------------------------------------
write_status running "Installing…"
archive_is_safe "$TARBALL" || fail_download "The download could not be verified; nothing was changed"
mkdir "$TMPDIR_DL/unpack"
tar -xzf "$TARBALL" -C "$TMPDIR_DL/unpack" --no-same-owner --no-same-permissions \
  || fail_download "The download could not be verified; nothing was changed"
[[ -f "$TMPDIR_DL/unpack/dist/server/index.js" && -f "$TMPDIR_DL/unpack/VERSION" ]] \
  || fail_download "The download could not be verified; nothing was changed"
# Real-path check: every symlink must resolve inside the unpack dir (catches
# links that escape through other links, and dangling links to outside paths).
real_path() {
  realpath -m "$1" 2> /dev/null || readlink -f "$1" 2> /dev/null \
    || python3 -I -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"
}
UNPACK_REAL="$(real_path "$TMPDIR_DL/unpack")"
[[ -n "$UNPACK_REAL" ]] || fail_download "The download could not be verified; nothing was changed"
while IFS= read -r -d '' link; do
  resolved="$(real_path "$link" || true)"
  if [[ -z "$resolved" || ( "$resolved" != "$UNPACK_REAL" && "$resolved" != "$UNPACK_REAL"/* ) ]]; then
    fail_download "The download could not be verified; nothing was changed"
  fi
done < <(find "$TMPDIR_DL/unpack" -type l -print0)
VERSION_IN_ARCHIVE="$(tr -d '[:space:]' < "$TMPDIR_DL/unpack/VERSION")"
[[ "$VERSION_IN_ARCHIVE" == "$TAG" ]] \
  || fail_download "The download could not be verified; nothing was changed"

DEST="$RELEASES/$TAG"
if [[ -e "$DEST" ]]; then
  ASIDE="$RELEASES/$TAG.old-$$"
  mv "$DEST" "$ASIDE"
fi
if ! mv "$TMPDIR_DL/unpack" "$DEST"; then
  [[ -n "$ASIDE" ]] && mv "$ASIDE" "$DEST"
  fail_download "Download failed; nothing was changed"
fi

# ---- 6. switch, restart, health check, rollback ------------------------------
PREVIOUS="$(readlink "$DATA/current" 2> /dev/null || true)"
SWITCHED=1
point_current_at "releases/$TAG"

# From here on, any failure (including signals and failed status writes) is
# rolled back by the EXIT trap. A failed restart counts as unhealthy.
write_status running "Restarting…"
healthy=0
if systemctl restart "$SERVICE"; then
  write_status running "Checking the new version…"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    if curl -fsS --max-time 3 "$HEALTH_URL" > /dev/null 2>&1; then
      healthy=1
      break
    fi
    [[ $SECONDS -ge $deadline ]] && break
    sleep "$HEALTH_INTERVAL" &   # background + wait so signals interrupt it
    SLEEP_PID=$!
    wait "$SLEEP_PID" || true
    SLEEP_PID=""
  done
fi

if [[ "$healthy" -ne 1 ]]; then
  rollback
  exit 11
fi

write_status succeeded "Updated to $TAG"
[[ -n "$ASIDE" ]] && rm -rf "$ASIDE"

# ---- 7. prune ----------------------------------------------------------------
# Only vX.Y.Z directories are candidates; dot-prefixed temp dirs are never touched.
CURRENT_NAME="$(basename "$(readlink "$DATA/current")")"
PREVIOUS_NAME="$(basename "$PREVIOUS")"
kept=0
while IFS= read -r name; do
  [[ "$name" =~ $TAG_RE && -d "$RELEASES/$name" ]] || continue
  if [[ "$name" == "$CURRENT_NAME" || "$name" == "$PREVIOUS_NAME" ]]; then
    kept=$((kept + 1))
    continue
  fi
  if [[ $kept -lt $KEEP ]]; then
    kept=$((kept + 1))
    continue
  fi
  rm -rf "${RELEASES:?}/$name"
done < <(ls -1t "$RELEASES")

exit 0
