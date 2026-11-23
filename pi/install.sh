#!/usr/bin/env bash
# install.sh -- turns stock Raspberry Pi OS (bookworm, 64-bit, with desktop)
# on a Raspberry Pi 5 into a plug-and-play photo frame. See pi/README.md.
#
#   ./pi/install.sh --owner-key <file-or-key> [--name photoframe]
#                   [--data-partition auto|<device>|none]
#                   [--release-dir <dir> --tag vX.Y.Z] [--tag vX.Y.Z]
#                   [--dry-run] [--writable]
#
# Run it as your normal (sudo-capable) user from a checkout of the repo; it
# calls sudo itself. `sudo ./pi/install.sh` also works ($SUDO_USER is used).
# A root login without $SUDO_USER is refused: the owner key is installed for
# the invoking user, and password SSH is only disabled once that user has a
# key, so "the invoking user" must be a real login user.
#
# Idempotent: re-run it to repair or upgrade a frame. Every change goes
# through the helpers below, which print what they do; --dry-run prints the
# same plan without changing anything and without needing root.
#
# Exit codes: 0 ok; 1 a step failed; 2 bad arguments or refused to run;
#   10, 11, 12 are passed through from frame-update (download/verify failed,
#   health check failed and rolled back, another update running).
set -euo pipefail

# ---- constants ---------------------------------------------------------------
REPO_SLUG="dbanksdesign/rpi-frame"
LATEST_URL="https://api.github.com/repos/$REPO_SLUG/releases/latest"
FRAME_USER="frame"
FRAME_GROUPS="video audio input render netdev"
DATA="/data"
DATA_LABEL="FRAMEDATA"
LIB_DIR="/usr/local/lib/photo-frame"
UPDATER="/usr/local/sbin/frame-update"
SUDOERS_FILE="/etc/sudoers.d/photo-frame-update"
SERVER_UNIT="photo-frame-server.service"
XSESSION="LXDE-pi-x"
# The release workflow builds with Node 20, so the frame runs Node 20 too.
NODE_MAJOR=20
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
NODESOURCE_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
NODESOURCE_KEYRING="/etc/apt/keyrings/nodesource.gpg"
TAILSCALE_KEY_URL="https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg"
TAILSCALE_FPR="2596A99EAAB33821893C0A79458CA832957F5868"
TAILSCALE_KEYRING="/usr/share/keyrings/tailscale-archive-keyring.gpg"
# sudo's secure_path on Debian: this is how `sudo systemd-run` gets resolved.
SECURE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
NAME_RE='^[a-z][a-z0-9-]{0,30}$'
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [ -~]*)?$'
MIN_DATA_SECTORS=$((2 * 1024 * 1024 * 2)) # 2 GiB in 512-byte sectors
TOTAL_STEPS=14
SAFE_WORD_RE='^[][A-Za-z0-9_./:=@%+,#*-]+$' # printed unquoted by qcmd

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# ---- state (set by parse_args / the steps) -----------------------------------
DRY=0
WRITABLE=0
NAME="photoframe"
DATA_PART="auto"
RELEASE_DIR=""
RELEASE_SRC=""   # directory that holds frame-<tag>.tar.gz(.sha256)
TAG=""
OWNER_KEY_ARG=""
OWNER_KEY=""     # normalised "type blob [comment]"
INSTALL_USER=""
INSTALL_HOME=""
DATA_IS_PARTITION=0
OVERLAY_ACTIVE=0
SKIP_TO_OVERLAY=0

# ---- output helpers ----------------------------------------------------------
step() { printf '\n[%s/%s] %s\n' "$1" "$TOTAL_STEPS" "$2"; }
say() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*"; }
die() { # <message> [exit code]
  printf 'install.sh: %s\n' "$1" >&2
  exit "${2:-1}"
}
usage_error() {
  printf 'install.sh: %s\n' "$1" >&2
  printf 'Run ./pi/install.sh --help for usage.\n' >&2
  exit 2
}

# qcmd <args...>: shell-quoted rendering of a command line (stable across
# bash versions, unlike printf %q).
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

as_root() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

# run <cmd...>: print, then (unless dry-run) execute as root.
run() {
  printf '    $ %s\n' "$(qcmd "$@")"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  as_root "$@"
}

# show_content: indent stdin for the log.
show_content() { sed 's/^/      | /'; }

# install_tmp <tmp> <dest> <mode> <owner:group>: atomic install of a temp file.
install_tmp() {
  local tmp=$1 dest=$2 mode=$3 owner=$4
  as_root install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$dest.photo-frame-new"
  as_root mv -f "$dest.photo-frame-new" "$dest"
}

# write_file <dest> <mode> <owner:group>: content on stdin (always ends with
# exactly one newline).
write_file() {
  local dest=$1 mode=$2 owner=$3 content tmp
  content="$(cat)"
  printf '    write %s (%s %s)\n' "$dest" "$owner" "$mode"
  printf '%s\n' "$content" | show_content
  if [[ $DRY -eq 1 ]]; then return 0; fi
  tmp="$(mktemp)"
  printf '%s\n' "$content" > "$tmp"
  install_tmp "$tmp" "$dest" "$mode" "$owner"
  rm -f "$tmp"
}

# copy_file <src> <dest> <mode> <owner:group> [show]
copy_file() {
  local src=$1 dest=$2 mode=$3 owner=$4 show=${5:-}
  printf '    install %s -> %s (%s %s)\n' "${src#"$REPO"/}" "$dest" "$owner" "$mode"
  if [[ "$show" == show ]]; then show_content < "$src"; fi
  if [[ $DRY -eq 1 ]]; then return 0; fi
  install_tmp "$src" "$dest" "$mode" "$owner"
}

# ensure_dir <path> <mode> <owner:group>: never follows a symlink.
ensure_dir() {
  local path=$1 mode=$2 owner=$3
  printf '    dir %s (%s %s)\n' "$path" "$owner" "$mode"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  if [[ -L "$path" ]]; then die "$path is a symlink; refusing to use it (move it aside and re-run)"; fi
  if [[ -e "$path" && ! -d "$path" ]]; then die "$path exists and is not a directory"; fi
  as_root install -d -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$path"
}

# fstab_ensure <mountpoint> <line>: the installer owns the fstab entry for each
# mount point it manages; any other entry for that mount point is replaced.
fstab_ensure() {
  local mnt=$1 line=$2 tmp
  printf '    fstab: %s\n' "$line"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  if [[ ! -e /etc/fstab.photo-frame.orig ]]; then as_root cp -p /etc/fstab /etc/fstab.photo-frame.orig; fi
  tmp="$(mktemp)"
  awk -v mnt="$mnt" '/^[[:space:]]*#/ || NF < 2 || $2 != mnt { print }' /etc/fstab > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  if ! cmp -s "$tmp" /etc/fstab; then install_tmp "$tmp" /etc/fstab 0644 root:root; fi
  rm -f "$tmp"
}

# ---- pure helpers (also used by the tests) -----------------------------------

# sudoers_text <systemd-run path>: the sudoers drop-in, exactly one rule.
sudoers_text() {
  cat << EOF
# Installed by pi/install.sh -- overwritten on every run; do not edit.
# The photo-frame server (user ${FRAME_USER}) may start exactly one root command:
# the updater, as a detached transient unit (server/update/updateService.ts
# runs: sudo -n systemd-run --collect --unit=frame-update ${UPDATER} <tag>).
#
# Residual surface: in sudoers a '*' also matches spaces, so this permits
# "frame-update v<digit><anything>", including extra arguments. systemd-run
# stops parsing its own options at the command path, so extra words can only
# reach frame-update, which exits 2 before doing anything unless it gets exactly
# one argument matching ^v[0-9]+\\.[0-9]+\\.[0-9]+\$. Environment variables cannot
# be passed (env_reset, no SETENV), and the transient unit gets a clean
# environment from systemd, so the updater's FRAME_* overrides are unreachable.
${FRAME_USER} ALL=(root) NOPASSWD: $1 --collect --unit=frame-update ${UPDATER} v[0-9]*
EOF
}

# plan_new_partition <root start sector> <sfdisk --dump> <sfdisk -F>: decide
# where a new data partition can go without touching any existing partition.
# Prints "START SIZE" in 512-byte sectors, or a reason on stderr + returns 1.
plan_new_partition() {
  local root_start=$1 dump=$2 free=$3
  local label ssize line s z t nparts=0 max_start=-1 root_end=""
  local fstart fend astart size
  label="$(printf '%s\n' "$dump" | awk -F': *' '/^label:/ { print $2; exit }')"
  ssize="$(printf '%s\n' "$dump" | awk -F': *' '/^sector-size:/ { print $2; exit }')"
  if [[ -z "$ssize" ]]; then ssize=512; fi
  if [[ "$ssize" != 512 ]]; then echo "unsupported sector size $ssize" >&2; return 1; fi
  if [[ "$label" != dos && "$label" != gpt ]]; then echo "unknown partition table '$label'" >&2; return 1; fi
  while IFS= read -r line; do
    case "$line" in *" : start="*) ;; *) continue ;; esac
    s="$(printf '%s\n' "$line" | sed -E 's/.*start= *([0-9]+).*/\1/')"
    z="$(printf '%s\n' "$line" | sed -E 's/.*size= *([0-9]+).*/\1/')"
    t="$(printf '%s\n' "$line" | sed -E 's/.*type= *([^, ]+).*/\1/')"
    nparts=$((nparts + 1))
    if [[ "$label" == dos ]] && [[ "$t" == 5 || "$t" == f || "$t" == 85 ]]; then
      echo "extended partitions are not supported" >&2; return 1
    fi
    if [[ "$s" -gt "$max_start" ]]; then max_start=$s; fi
    if [[ "$s" == "$root_start" ]]; then root_end=$((s + z - 1)); fi
  done <<< "$dump"
  if [[ -z "$root_end" ]]; then echo "root partition not found in the partition table" >&2; return 1; fi
  if [[ "$max_start" != "$root_start" ]]; then echo "the root partition is not the last partition" >&2; return 1; fi
  if [[ "$label" == dos && "$nparts" -ge 4 ]]; then echo "the MBR partition table is full" >&2; return 1; fi
  while read -r fstart fend _ _; do
    [[ "$fstart" =~ ^[0-9]+$ && "$fend" =~ ^[0-9]+$ ]] || continue
    if [[ "$fstart" -le "$root_end" ]]; then continue; fi
    astart=$(( (fstart + 2047) / 2048 * 2048 ))
    size=$(( (fend - astart + 1) / 2048 * 2048 ))
    if [[ "$size" -ge "$MIN_DATA_SECTORS" ]]; then
      echo "$astart $size"
      return 0
    fi
  done <<< "$free"
  echo "less than 2 GiB of unallocated space after the root partition" >&2
  return 1
}

# Kernel cmdline helpers for the read-only overlay. raspi-config's
# enable_overlayfs prepends a plain "overlayroot=tmpfs", and overlayroot's
# init-bottom script then defaults to recurse=1, which also rewrites every
# other fstab mount -- /data and the bind mounts -- as a read-only lower layer
# plus a tmpfs upper, i.e. all photos, WiFi and Tailscale state would live in
# RAM. recurse=0 overlays only /. raspi-config's disable_overlayfs only strips
# the plain token ("overlayroot=tmpfs " followed by a space), so stripping is
# done here for every variant.
OVERLAY_TOKEN="overlayroot=tmpfs:recurse=0"

is_overlay_token() { [[ "$1" == overlayroot=tmpfs || "$1" == overlayroot=tmpfs:* ]]; }

# cmdline_overlay_strip <cmdline>: drop every overlayroot=tmpfs[:...] token.
cmdline_overlay_strip() {
  local out="" t
  local -a toks=()
  read -r -a toks <<< "$1" || true
  for t in ${toks[@]+"${toks[@]}"}; do
    if is_overlay_token "$t"; then continue; fi
    out="$out${out:+ }$t"
  done
  printf '%s\n' "$out"
}

# cmdline_overlay_enable <cmdline>: exactly one token, overlayroot=tmpfs:recurse=0, first.
cmdline_overlay_enable() {
  local rest
  rest="$(cmdline_overlay_strip "$1")"
  printf '%s\n' "$OVERLAY_TOKEN${rest:+ $rest}"
}

# cmdline_has_overlay <cmdline>: any overlayroot=tmpfs[:...] token present.
cmdline_has_overlay() {
  local t
  local -a toks=()
  read -r -a toks <<< "$1" || true
  for t in ${toks[@]+"${toks[@]}"}; do
    if is_overlay_token "$t"; then return 0; fi
  done
  return 1
}

# cmdline_overlay_ok <cmdline>: the overlay is on AND will not recurse into /data.
cmdline_overlay_ok() {
  local t n=0 good=0
  local -a toks=()
  read -r -a toks <<< "$1" || true
  for t in ${toks[@]+"${toks[@]}"}; do
    if is_overlay_token "$t"; then
      n=$((n + 1))
      if [[ "$t" == "$OVERLAY_TOKEN" ]]; then good=1; fi
    fi
  done
  [[ "$n" -eq 1 && "$good" -eq 1 ]]
}

# file_meta <path>: mode, owner and group as ls shows them (portable).
file_meta() { as_root ls -ldn "$1" | awk '{ print $1, $3, $4 }'; }

# remove_copied_originals <src dir> <dst dir>: after the first-time copy to
# /data, delete each original under src (on the root filesystem, hidden by the
# bind mount afterwards) ONLY if dst holds an identical copy: same content,
# mode and owner. Anything else is kept and reported. Never touches dst, never
# runs when src is already a mount point, and is safe to repeat.
remove_copied_originals() {
  local src=$1 dst=$2 f rel kept=0
  printf '    delete originals under %s that have an identical copy (content, mode, owner) in %s\n' "$src" "$dst"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  if command -v mountpoint > /dev/null 2>&1 && mountpoint -q "$src"; then
    die "$src is already a mount point; not deleting anything there"
  fi
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    if as_root test -f "$dst/$rel" && ! as_root test -L "$dst/$rel" \
      && as_root cmp -s "$f" "$dst/$rel" \
      && [[ "$(file_meta "$f")" == "$(file_meta "$dst/$rel")" ]]; then
      as_root rm -f "$f"
    else
      kept=$((kept + 1))
      warn "kept $f: no identical copy in $dst (check it and delete it by hand if it is yours)"
    fi
  done < <(as_root find "$src" -mindepth 1 -type f -print0)
  as_root find "$src" -mindepth 1 -depth -type d -empty -delete
  if [[ "$kept" -eq 0 ]]; then say "no originals left under $src"; fi
}

print_partition_howto() {
  say "To get a separate data partition (needed for the read-only overlay):"
  say "  1. Power off, put the SD card in another Linux machine (or boot the Pi"
  say "     from USB) and open it in GParted."
  say "  2. Shrink the root partition (the big ext4 one) to leave at least 2 GiB"
  say "     (ideally most of the card, for photos) unallocated after it."
  say "  3. Either create an ext4 partition there with the label $DATA_LABEL, or"
  say "     leave the space unallocated (the installer then creates it)."
  say "  4. Boot the Pi and re-run this installer with --data-partition auto."
  say "  (CLI equivalent: e2fsck -f /dev/sdX2; resize2fs /dev/sdX2 16G;"
  say "   parted /dev/sdX resizepart 2 17GiB; mkfs.ext4 -L $DATA_LABEL /dev/sdX3"
  say "   after creating partition 3 in the freed space.)"
}

usage() {
  cat << EOF
Usage: ./pi/install.sh --owner-key <file-or-key> [options]

  --owner-key <file|key>   owner's SSH PUBLIC key (a .pub file or the key line); required
  --name <hostname>        frame name / hostname (default: photoframe) -> <name>.local
  --data-partition <mode>  auto (default): use the ext4 partition labelled $DATA_LABEL or
                           create one from >= 2 GiB unallocated space after root;
                           <device>: use that partition; none: plain /data directory
  --tag vX.Y.Z             release to install (default: latest published release)
  --release-dir <dir>      install the release from a local directory (needs --tag);
                           holds frame-<tag>.tar.gz + .sha256, directly or in <tag>/
  --writable               maintenance mode: disable the read-only overlay filesystem
  --dry-run                print the plan; change nothing (no root needed)
  -h, --help               this help
EOF
}

# ---- argument handling -------------------------------------------------------
need_value() { if [[ $# -lt 2 ]]; then usage_error "$1 needs a value"; fi; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --owner-key) need_value "$@"; OWNER_KEY_ARG=$2; shift 2 ;;
      --owner-key=*) OWNER_KEY_ARG=${1#*=}; shift ;;
      --name) need_value "$@"; NAME=$2; shift 2 ;;
      --name=*) NAME=${1#*=}; shift ;;
      --data-partition) need_value "$@"; DATA_PART=$2; shift 2 ;;
      --data-partition=*) DATA_PART=${1#*=}; shift ;;
      --release-dir) need_value "$@"; RELEASE_DIR=$2; shift 2 ;;
      --release-dir=*) RELEASE_DIR=${1#*=}; shift ;;
      --tag) need_value "$@"; TAG=$2; shift 2 ;;
      --tag=*) TAG=${1#*=}; shift ;;
      --dry-run) DRY=1; shift ;;
      --writable) WRITABLE=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
}

# load_owner_key: validates --owner-key without ever printing its content.
load_owner_key() {
  local raw lines n
  if [[ -z "$OWNER_KEY_ARG" ]]; then
    usage_error "--owner-key is required (the owner's SSH public key file or key line)"
  fi
  if [[ -f "$OWNER_KEY_ARG" ]]; then
    if [[ "$(wc -c < "$OWNER_KEY_ARG")" -gt 16384 ]]; then usage_error "--owner-key file is too large to be a public key"; fi
    raw="$(cat "$OWNER_KEY_ARG")"
  else
    raw="$OWNER_KEY_ARG"
  fi
  if [[ "$raw" == *"PRIVATE KEY"* ]]; then
    usage_error "--owner-key is a private key. Never copy a private key to the frame; pass the .pub file instead"
  fi
  lines="$(printf '%s\n' "$raw" | tr -d '\r' | grep -v -E '^[[:space:]]*(#|$)' || true)"
  n="$(printf '%s' "$lines" | grep -c '' || true)"
  if [[ "$n" -ne 1 ]]; then usage_error "--owner-key must contain exactly one public key line"; fi
  if ! [[ "$lines" =~ $KEY_RE ]]; then
    if [[ ! -f "$OWNER_KEY_ARG" && "$OWNER_KEY_ARG" != *" "* ]]; then
      usage_error "--owner-key: no such file, and not a public key line: $OWNER_KEY_ARG"
    fi
    usage_error "--owner-key is not an SSH public key line (ssh-ed25519/ssh-rsa/ecdsa-*/sk-*, no options)"
  fi
  if command -v ssh-keygen > /dev/null 2>&1; then
    if ! printf '%s\n' "$lines" | ssh-keygen -l -f - > /dev/null 2>&1; then
      usage_error "--owner-key: ssh-keygen does not accept this public key"
    fi
  fi
  OWNER_KEY="$lines"
}

validate_args() {
  load_owner_key
  if ! [[ "$NAME" =~ $NAME_RE ]] || [[ "$NAME" == *- ]]; then
    usage_error "--name must match ^[a-z][a-z0-9-]{0,30}\$ and not end with '-' (got '$NAME')"
  fi
  case "$DATA_PART" in
    auto | none) ;;
    /dev/*)
      if ! [[ "$DATA_PART" =~ ^/dev/[A-Za-z0-9._/-]+$ ]] || [[ "$DATA_PART" == *..* ]]; then
        usage_error "--data-partition: invalid device path '$DATA_PART'"
      fi ;;
    *) usage_error "--data-partition must be auto, none or a /dev/... partition" ;;
  esac
  if [[ -n "$TAG" ]] && ! [[ "$TAG" =~ $TAG_RE ]]; then usage_error "--tag must look like vX.Y.Z (got '$TAG')"; fi
  if [[ -n "$RELEASE_DIR" ]]; then
    if [[ -z "$TAG" ]]; then usage_error "--release-dir needs --tag vX.Y.Z"; fi
    if [[ ! -d "$RELEASE_DIR" ]]; then usage_error "--release-dir: not a directory: $RELEASE_DIR"; fi
    RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd)"
    if [[ -f "$RELEASE_DIR/$TAG/frame-$TAG.tar.gz" && -f "$RELEASE_DIR/$TAG/frame-$TAG.tar.gz.sha256" ]]; then
      RELEASE_SRC="$RELEASE_DIR/$TAG"
    elif [[ -f "$RELEASE_DIR/frame-$TAG.tar.gz" && -f "$RELEASE_DIR/frame-$TAG.tar.gz.sha256" ]]; then
      RELEASE_SRC="$RELEASE_DIR"
    else
      usage_error "--release-dir must contain frame-$TAG.tar.gz and frame-$TAG.tar.gz.sha256 (directly or in $TAG/)"
    fi
  fi
}

resolve_user() {
  if [[ $EUID -eq 0 ]]; then INSTALL_USER="${SUDO_USER:-}"; else INSTALL_USER="$(id -un)"; fi
  if [[ -z "$INSTALL_USER" || "$INSTALL_USER" == root ]]; then
    if [[ $DRY -eq 0 ]]; then
      die "run this as your normal user (it uses sudo), or via sudo from it -- not from a root login: the owner key is installed for that user so you are not locked out" 2
    fi
    INSTALL_USER="${INSTALL_USER:-root}"
    say "NOTE: a real run would refuse to run from a root login (no \$SUDO_USER)."
  fi
  if [[ "$INSTALL_USER" == "$FRAME_USER" ]]; then die "run the installer as your own user, not as '$FRAME_USER'" 2; fi
  if command -v getent > /dev/null 2>&1 && getent passwd "$INSTALL_USER" > /dev/null 2>&1; then
    INSTALL_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
  else
    INSTALL_HOME="~$INSTALL_USER"
  fi
}

# ---- step 1: preflight -------------------------------------------------------
os_field() { awk -F= -v k="$1" '$1 == k { gsub(/"/, "", $2); print $2 }' /etc/os-release 2> /dev/null; }

step_preflight() {
  step 1 "Preflight"
  say "frame name: $NAME   data partition: $DATA_PART   writable: $([[ $WRITABLE -eq 1 ]] && echo yes || echo no)"
  say "installing user: $INSTALL_USER (owner key: $(printf '%s' "$OWNER_KEY" | awk '{ print $1, ($3 == "" ? "(no comment)" : $3) }'))"
  if [[ $DRY -eq 1 ]]; then
    say "dry run: no changes will be made. A real run checks:"
    say "  check: /etc/os-release is Debian/Raspberry Pi OS 12 (bookworm)"
    say "  check: dpkg architecture is arm64"
    say "  check: systemd is PID 1 and NetworkManager is active"
    say "  check: not inside a container (systemd-detect-virt --container)"
    say "  check: raspi-config, lightdm and /usr/share/xsessions/$XSESSION.desktop exist (desktop image)"
    say "  check: the read-only overlay is not active (else: --writable, reboot, re-run)"
    say "  check: sudo works for $INSTALL_USER"
    return 0
  fi
  local id codename arch
  id="$(os_field ID)"
  codename="$(os_field VERSION_CODENAME)"
  if ! [[ "$id" == debian || "$id" == raspbian ]] || [[ "$codename" != bookworm ]]; then
    die "needs Raspberry Pi OS / Debian 12 (bookworm); this is '${id:-unknown} ${codename:-unknown}'"
  fi
  arch="$(dpkg --print-architecture 2> /dev/null || true)"
  [[ "$arch" == arm64 ]] || die "needs the 64-bit OS (arm64); this is '${arch:-unknown}'"
  [[ -d /run/systemd/system ]] || die "systemd is not running as init"
  if command -v systemd-detect-virt > /dev/null 2>&1 && systemd-detect-virt --container --quiet; then
    die "running inside a container; the installer needs a real Raspberry Pi (use --dry-run to preview)"
  fi
  systemctl is-active --quiet NetworkManager || die "NetworkManager is not active (Raspberry Pi OS bookworm uses it by default)"
  command -v raspi-config > /dev/null 2>&1 || die "raspi-config is missing; use Raspberry Pi OS (64-bit, with desktop)"
  [[ -d /etc/lightdm && -f "/usr/share/xsessions/$XSESSION.desktop" ]] \
    || die "the desktop session $XSESSION is missing; use Raspberry Pi OS with desktop (not Lite)"
  for f in "$REPO/start.sh" "$HERE/updater/frame-update.sh" "$HERE/units/$SERVER_UNIT"; do
    [[ -f "$f" ]] || die "missing $f; run the installer from a complete checkout"
  done
  if cmdline_has_overlay "$(cat /proc/cmdline)"; then
    OVERLAY_ACTIVE=1
    if [[ $WRITABLE -eq 0 ]]; then
      die "the read-only overlay filesystem is active, so changes would be lost at reboot. Run './pi/install.sh --writable ...', reboot, then re-run."
    fi
    SKIP_TO_OVERLAY=1
    say "overlay filesystem is active: only step 14 (disable it) will run; reboot, then re-run."
  fi
  if [[ $EUID -ne 0 ]]; then sudo -v || die "sudo is required"; fi
  say "ok: $id $codename arm64, systemd, NetworkManager"
}

skipped() { say "skipped: the root filesystem is the read-only overlay (reboot after this run, then re-run)"; }

# ---- step 2: packages --------------------------------------------------------
# apt_repo <name> <key url> <fingerprint> <keyring> <armored 0|1> <sources line>
apt_repo() {
  local name=$1 url=$2 fpr=$3 keyring=$4 armored=$5 src=$6
  say "$name repo: download $url, require exactly one key with fingerprint $fpr"
  if [[ $DRY -eq 0 ]]; then
    local dl key gh pubs got
    dl="$(mktemp)"; key="$(mktemp)"; gh="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dl" "$url" || die "could not download the $name signing key"
    pubs="$(GNUPGHOME="$gh" gpg --batch --show-keys --with-colons "$dl" 2> /dev/null | grep -c '^pub:' || true)"
    got="$(GNUPGHOME="$gh" gpg --batch --show-keys --with-colons "$dl" 2> /dev/null | awk -F: '/^fpr:/ { print $10; exit }')"
    if [[ "$pubs" != 1 || "$got" != "$fpr" ]]; then die "the $name signing key has an unexpected fingerprint ($got); refusing"; fi
    if [[ "$armored" == 1 ]]; then GNUPGHOME="$gh" gpg --batch --yes --dearmor -o "$key" "$dl"; else cp "$dl" "$key"; fi
    rm -rf "$gh"
  fi
  printf '    install %s key -> %s (root:root 0644)\n' "$name" "$keyring"
  if [[ $DRY -eq 0 ]]; then
    as_root install -d -m 0755 -o root -g root "$(dirname "$keyring")"
    install_tmp "$key" "$keyring" 0644 root:root
    rm -f "$dl" "$key"
  fi
  write_file "/etc/apt/sources.list.d/$name.list" 0644 root:root <<< "$src"
}

step_packages() {
  step 2 "Packages"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  local apt=(env DEBIAN_FRONTEND=noninteractive apt-get)
  run "${apt[@]}" update
  run "${apt[@]}" install -y ca-certificates curl gnupg
  # Debian 12 ships nodejs 18, so Node 20 comes from NodeSource's node_20.x repo
  # (key fingerprint pinned above, plus an apt pin so Debian's nodejs never wins).
  apt_repo nodesource "$NODESOURCE_KEY_URL" "$NODESOURCE_FPR" "$NODESOURCE_KEYRING" 1 \
    "deb [signed-by=$NODESOURCE_KEYRING] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main"
  write_file /etc/apt/preferences.d/photo-frame-nodejs 0644 root:root << EOF
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
  # Tailscale's official bookworm repo (the same files its install script uses).
  apt_repo tailscale "$TAILSCALE_KEY_URL" "$TAILSCALE_FPR" "$TAILSCALE_KEYRING" 0 \
    "deb [signed-by=$TAILSCALE_KEYRING] https://pkgs.tailscale.com/stable/debian bookworm main"
  run "${apt[@]}" update
  # chromium (Raspberry Pi archive) ships /usr/bin/chromium-browser, which start.sh calls.
  run "${apt[@]}" install -y nodejs chromium unclutter x11-xserver-utils avahi-daemon \
    curl tar util-linux fdisk e2fsprogs python3 openssh-server tailscale \
    dnsmasq-base overlayroot
  if [[ $DRY -eq 1 ]]; then
    say "check: node --version is v${NODE_MAJOR}.x; chromium-browser is on PATH"
  else
    local v
    v="$(/usr/bin/node --version 2> /dev/null || true)"
    [[ "$v" == "v${NODE_MAJOR}."* ]] || die "expected Node ${NODE_MAJOR} at /usr/bin/node, got '${v:-none}'"
    command -v chromium-browser > /dev/null 2>&1 || warn "chromium-browser not found; start.sh needs it"
    say "ok: node $v"
  fi
  run systemctl enable --now tailscaled.service
}

# ---- step 3: users -----------------------------------------------------------
tailscale_operator() {
  printf '    $ %s\n' "$(qcmd tailscale set "--operator=$FRAME_USER")"
  if [[ $DRY -eq 1 ]]; then return 0; fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if as_root tailscale set "--operator=$FRAME_USER" 2> /dev/null; then return 0; fi
    sleep 2
  done
  die "tailscale set --operator=$FRAME_USER failed (is tailscaled running?)"
}

step_users() {
  step 3 "Users"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  if [[ $DRY -eq 1 ]] || ! id "$FRAME_USER" > /dev/null 2>&1; then
    if [[ $DRY -eq 1 ]]; then say "(if user $FRAME_USER does not exist yet)"; fi
    run useradd --create-home --home-dir "/home/$FRAME_USER" --shell /bin/bash --user-group "$FRAME_USER"
  else
    say "user $FRAME_USER exists"
  fi
  # Locked password: the account only ever logs in through LightDM autologin.
  run passwd -l "$FRAME_USER"
  local g groups=""
  for g in $FRAME_GROUPS; do
    if [[ $DRY -eq 1 ]] || getent group "$g" > /dev/null 2>&1; then groups="$groups${groups:+,}$g"; fi
  done
  run usermod -aG "$groups" "$FRAME_USER"
  tailscale_operator
}

# ---- step 4: data partition --------------------------------------------------
data_fstab_line() { echo "LABEL=$DATA_LABEL $DATA ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2"; }

# find the one partition labelled FRAMEDATA (refuses duplicates)
labelled_device() {
  local devs n
  devs="$(as_root blkid -t "LABEL=$DATA_LABEL" -o device 2> /dev/null || true)"
  n="$(printf '%s' "$devs" | grep -c '' || true)"
  if [[ "$n" -gt 1 ]]; then die "more than one partition is labelled $DATA_LABEL: $(printf '%s ' "$devs"); remove the extra label"; fi
  printf '%s' "$devs"
}

fs_type() { as_root blkid -o value -s TYPE "$1" 2> /dev/null || true; }

# create_partition: makes a new partition from unallocated space after root
# and sets NEW_DEV, or leaves NEW_DEV empty (reason printed) when that is not
# possible. Called as a plain statement -- never in $(...) or an `if` -- so
# its log reaches the terminal and set -e / die() stay in force.
NEW_DEV=""
create_partition() {
  local rootsrc rootname disk dump free rootstart plan start size dev
  NEW_DEV=""
  rootsrc="$(findmnt -n -o SOURCE /)"
  rootname="$(basename "$rootsrc")"
  disk="/dev/$(lsblk -n -o PKNAME "$rootsrc" | awk 'NR == 1')"
  if [[ ! -b "$disk" || ! -r "/sys/class/block/$rootname/start" ]]; then
    say "not creating a partition: cannot identify the disk of $rootsrc"
    return 0
  fi
  rootstart="$(cat "/sys/class/block/$rootname/start")"
  dump="$(as_root sfdisk --dump "$disk")"
  free="$(as_root sfdisk -F "$disk")"
  if ! plan="$(plan_new_partition "$rootstart" "$dump" "$free" 2>&1)"; then
    say "not creating a partition: $plan"
    return 0
  fi
  start="${plan% *}"; size="${plan#* }"
  say "creating a partition on $disk: start=$start size=$size sectors (unallocated space only)"
  printf 'start=%s, size=%s, type=L\n' "$start" "$size" | run sfdisk --append --no-reread "$disk"
  dump="$(as_root sfdisk --dump "$disk")"
  dev="$(printf '%s\n' "$dump" | awk -v s="$start" -F' : ' '$2 ~ "start= *"s"," { print $1 }')"
  [[ -n "$dev" ]] || die "the new partition did not appear in the partition table of $disk"
  run partx --add --nr "${dev##*[!0-9]}" "$disk" || true
  run udevadm settle || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -b "$dev" ]] && break; sleep 1; done
  [[ -b "$dev" ]] || die "$dev did not appear; reboot and re-run the installer"
  if [[ -n "$(as_root wipefs -n "$dev" 2> /dev/null | tail -n +2)" ]]; then
    die "$dev (new, in previously unallocated space) contains an old filesystem signature; refusing to format it. If you are sure, run 'sudo wipefs -a $dev' and re-run."
  fi
  run mkfs.ext4 -q -L "$DATA_LABEL" "$dev"
  NEW_DEV="$dev"
}

# prepare_device <dev>: label (non-destructively) or format an EMPTY partition.
prepare_device() {
  local dev=$1 type label other
  [[ -b "$dev" ]] || die "--data-partition: $dev is not a block device"
  [[ "$(lsblk -n -d -o TYPE "$dev")" == part ]] || die "--data-partition: $dev is not a partition"
  for other in / /boot/firmware /boot; do
    if [[ "$(findmnt -n -o SOURCE "$other" 2> /dev/null || true)" == "$dev" ]]; then die "--data-partition: $dev is mounted at $other"; fi
  done
  if findmnt -n -S "$dev" > /dev/null 2>&1 && [[ "$(findmnt -n -o TARGET -S "$dev" | awk 'NR == 1')" != "$DATA" ]]; then
    die "--data-partition: $dev is mounted elsewhere ($(findmnt -n -o TARGET -S "$dev" | awk 'NR == 1'))"
  fi
  type="$(fs_type "$dev")"
  case "$type" in
    ext4)
      label="$(as_root blkid -o value -s LABEL "$dev" 2> /dev/null || true)"
      if [[ "$label" != "$DATA_LABEL" ]]; then
        other="$(labelled_device)"
        if [[ -n "$other" && "$other" != "$dev" ]]; then die "$other is already labelled $DATA_LABEL"; fi
        run e2label "$dev" "$DATA_LABEL"
      fi ;;
    "")
      if [[ -n "$(as_root wipefs -n "$dev" 2> /dev/null | tail -n +2)" ]]; then
        die "--data-partition: $dev has signatures blkid does not recognise; refusing to format it"
      fi
      run mkfs.ext4 -q -L "$DATA_LABEL" "$dev" ;;
    *) die "--data-partition: $dev holds a $type filesystem; refusing to touch it (use an empty or ext4 partition)" ;;
  esac
}

mount_data() { # <dev>
  local dev=$1
  if [[ $DRY -eq 0 ]] && ! mountpoint -q "$DATA" && [[ -d "$DATA" && -n "$(ls -A "$DATA" 2> /dev/null)" ]]; then
    die "$DATA is a non-empty directory on the root filesystem; mounting $dev over it would hide it. Move it aside (sudo mv $DATA $DATA.old), re-run, then copy uploads/ and data/ back into $DATA."
  fi
  fstab_ensure "$DATA" "$(data_fstab_line)"
  run systemctl daemon-reload
  ensure_dir "$DATA" 0755 root:root
  if [[ $DRY -eq 1 ]]; then
    run mount "$DATA"
    return 0
  fi
  if mountpoint -q "$DATA"; then say "$DATA already mounted"; else run mount "$DATA"; fi
  [[ "$(readlink -f "$(findmnt -n -o SOURCE "$DATA")")" == "$(readlink -f "$dev")" ]] \
    || die "$DATA is mounted, but not from $dev"
  DATA_IS_PARTITION=1
}

step_data_partition() {
  step 4 "Data partition"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  local dev=""
  if [[ $DRY -eq 1 ]]; then
    case "$DATA_PART" in
      auto)
        say "look for the ext4 partition labelled $DATA_LABEL (blkid -t LABEL=$DATA_LABEL; refuse duplicates)"
        say "else: if >= 2 GiB is unallocated after the root partition (and root is the last"
        say "  partition), create one there (sfdisk --append), then mkfs.ext4 -L $DATA_LABEL"
        say "else: $DATA becomes a plain directory, the overlay filesystem will NOT be enabled,"
        say "  and the manual steps to add a partition are printed"
        say "then (when a partition is used):"
        mount_data "<the $DATA_LABEL partition>" ;;
      none)
        say "$DATA will be a plain directory on the root filesystem"
        say "the overlay filesystem will NOT be enabled (it needs a separate $DATA partition)"
        print_partition_howto ;;
      *)
        say "use $DATA_PART: ext4 -> label it $DATA_LABEL (e2label); empty -> mkfs.ext4 -L $DATA_LABEL;"
        say "  anything else (or mounted elsewhere, or the root/boot partition) -> refuse"
        mount_data "$DATA_PART" ;;
    esac
    return 0
  fi
  case "$DATA_PART" in
    none) ;;
    auto)
      dev="$(labelled_device)"
      if [[ -n "$dev" ]]; then
        [[ "$(fs_type "$dev")" == ext4 ]] || die "$dev is labelled $DATA_LABEL but is not ext4"
        say "found $DATA_LABEL: $dev"
      else
        create_partition
        dev="$NEW_DEV"
      fi ;;
    *) prepare_device "$DATA_PART"; dev="$DATA_PART" ;;
  esac
  if [[ -n "$dev" ]]; then
    mount_data "$dev"
    say "ok: $DATA is mounted from $dev"
  else
    if grep -qE "^[^#]*[[:space:]]${DATA}[[:space:]]" /etc/fstab; then
      warn "/etc/fstab still has an entry for $DATA; leaving it alone"
    fi
    say "$DATA will be a plain directory on the root filesystem"
    say "the overlay filesystem will NOT be enabled (it needs a separate $DATA partition)"
    print_partition_howto
  fi
}

# ---- step 5: data layout -----------------------------------------------------
step_layout() {
  step 5 "Data layout and ownership"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  # The updater refuses a releases dir that is a symlink or not root-owned;
  # the frame user owns ONLY uploads/ and data/.
  ensure_dir "$DATA" 0755 root:root
  ensure_dir "$DATA/releases" 0755 root:root
  ensure_dir "$DATA/system" 0755 root:root
  ensure_dir "$DATA/log" 0755 root:root
  ensure_dir "$DATA/uploads" 0755 "$FRAME_USER:$FRAME_USER"
  ensure_dir "$DATA/data" 0755 "$FRAME_USER:$FRAME_USER"
  say "$DATA/current: root-owned symlink, created by frame-update in step 13"
  say "$DATA/update-status.json: written by frame-update (root, 0644)"
  if [[ $DRY -eq 0 ]]; then
    if [[ -e "$DATA/current" && ! -L "$DATA/current" ]]; then die "$DATA/current exists but is not a symlink"; fi
    if [[ -L "$DATA/current" ]]; then run chown -h root:root "$DATA/current"; fi
  fi
}

# ---- step 6: persistence -----------------------------------------------------
# bind_line <source> <target> <service>: nofail drops the mount's ordering
# before local-fs.target, so order it explicitly before the service that reads
# the directory (ordering only: if /data is missing the service still starts).
bind_line() { echo "$1 $2 none bind,nofail,x-systemd.requires-mounts-for=$DATA,x-systemd.before=$3 0 0"; }

# needs_bind <target>: true when the bind mount still has to be set up (always
# true in a dry run, which prints the whole first-install plan).
needs_bind() {
  if [[ $DRY -eq 1 ]]; then say "(if $1 is not bind-mounted yet)"; return 0; fi
  if mountpoint -q "$1"; then say "$1 already bind-mounted"; return 1; fi
  return 0
}

step_persistence() {
  step 6 "Persistence for the read-only root"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  local nm=/etc/NetworkManager/system-connections ts=/var/lib/tailscale
  ensure_dir "$DATA/system/NetworkManager" 0700 root:root
  ensure_dir "$DATA/system/tailscale" 0700 root:root
  fstab_ensure "$nm" "$(bind_line "$DATA/system/NetworkManager" "$nm" NetworkManager.service)"
  fstab_ensure "$ts" "$(bind_line "$DATA/system/tailscale" "$ts" tailscaled.service)"
  run systemctl daemon-reload
  # NetworkManager profiles (0600 root) are merged in, never overwritten.
  if needs_bind "$nm"; then
    ensure_dir "$nm" 0700 root:root
    run cp -an "$nm/." "$DATA/system/NetworkManager/"
    # The originals (e.g. the owner's WiFi PSK) must not stay on root under the
    # bind mount. NetworkManager keeps running from memory until the reload.
    remove_copied_originals "$nm" "$DATA/system/NetworkManager"
    run mount "$nm"
    run nmcli connection reload
  fi
  # Tailscale state is copied only into an empty destination. tailscaled is
  # stopped only for this first-time move, never on a re-run (which may be
  # coming in over Tailscale).
  if needs_bind "$ts"; then
    ensure_dir "$ts" 0700 root:root
    run systemctl stop tailscaled.service
    if [[ $DRY -eq 1 ]]; then
      say "(only if $DATA/system/tailscale is empty)"
      run cp -a "$ts/." "$DATA/system/tailscale/"
    elif [[ -z "$(as_root ls -A "$DATA/system/tailscale")" ]]; then
      run cp -a "$ts/." "$DATA/system/tailscale/"
    fi
    remove_copied_originals "$ts" "$DATA/system/tailscale"
    run mount "$ts"
    run systemctl start tailscaled.service
    tailscale_operator
  fi
  # Saved clock (fake-hwclock) lives on /data too.
  if [[ $DRY -eq 1 ]]; then
    say "(if fake-hwclock is installed)"
    run cp -p /etc/fake-hwclock.data "$DATA/system/fake-hwclock.data"
    run ln -sfn "$DATA/system/fake-hwclock.data" /etc/fake-hwclock.data
  elif [[ "$(readlink /etc/fake-hwclock.data 2> /dev/null || true)" == "$DATA/system/fake-hwclock.data" ]]; then
    say "/etc/fake-hwclock.data already points into $DATA/system"
  elif [[ -f /etc/fake-hwclock.data || -f /lib/systemd/system/fake-hwclock.service ]]; then
    if [[ -f /etc/fake-hwclock.data && ! -L /etc/fake-hwclock.data && ! -e "$DATA/system/fake-hwclock.data" ]]; then
      run cp -p /etc/fake-hwclock.data "$DATA/system/fake-hwclock.data"
    fi
    run ln -sfn "$DATA/system/fake-hwclock.data" /etc/fake-hwclock.data
  else
    say "fake-hwclock not installed; skipping"
  fi
  if [[ $DRY -eq 1 || -f /lib/systemd/system/fake-hwclock.service ]]; then
    ensure_dir /etc/systemd/system/fake-hwclock.service.d 0755 root:root
    copy_file "$HERE/templates/fake-hwclock-photo-frame.conf" /etc/systemd/system/fake-hwclock.service.d/photo-frame.conf 0644 root:root
  fi
  say "power log: $DATA/log/power-log.csv (directory from step 5)"
}

# ---- step 7: updater ---------------------------------------------------------
resolve_systemd_run() {
  local p
  p="$(PATH="$SECURE_PATH" command -v systemd-run 2> /dev/null || true)"
  if [[ -z "$p" ]]; then
    if [[ $DRY -eq 1 ]]; then p=/usr/bin/systemd-run; else die "systemd-run not found"; fi
  fi
  printf '%s' "$p"
}

step_updater() {
  step 7 "Updater"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  copy_file "$HERE/updater/frame-update.sh" "$UPDATER" 0755 root:root
  local srun content tmp
  srun="$(resolve_systemd_run)"
  say "systemd-run as sudo resolves it (secure_path): $srun"
  content="$(sudoers_text "$srun")"
  printf '    write %s (%s %s), validated with visudo -cf before it is moved into place\n' "$SUDOERS_FILE" root:root 0440
  printf '%s\n' "$content" | show_content
  if [[ $DRY -eq 1 ]]; then
    say "\$ visudo -cf <new file>; on failure: remove it and abort"
    return 0
  fi
  tmp="$(mktemp)"
  printf '%s\n' "$content" > "$tmp"
  # A name with a '.' is ignored by #includedir, so the staged file is inert.
  as_root install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE.photo-frame-new"
  rm -f "$tmp"
  if ! as_root visudo -cf "$SUDOERS_FILE.photo-frame-new"; then
    as_root rm -f "$SUDOERS_FILE.photo-frame-new"
    die "the generated sudoers file failed visudo -cf; nothing was installed"
  fi
  as_root mv -f "$SUDOERS_FILE.photo-frame-new" "$SUDOERS_FILE"
  if ! as_root visudo -c > /dev/null; then
    as_root rm -f "$SUDOERS_FILE"
    die "sudo configuration invalid after installing $SUDOERS_FILE; removed it"
  fi
  say "ok: sudoers validated"
}

# ---- step 8: systemd units ---------------------------------------------------
step_units() {
  step 8 "systemd units"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  ensure_dir "$LIB_DIR" 0755 root:root
  copy_file "$HERE/units/$SERVER_UNIT" "/etc/systemd/system/$SERVER_UNIT" 0644 root:root
  copy_file "$HERE/power-log.sh" "$LIB_DIR/power-log.sh" 0755 root:root
  copy_file "$HERE/units/power-log.service" /etc/systemd/system/power-log.service 0644 root:root
  ensure_dir /etc/systemd/system.conf.d 0755 root:root
  copy_file "$HERE/watchdog.conf" /etc/systemd/system.conf.d/watchdog.conf 0644 root:root
  # The earlier display service is retired (lxsession launches start.sh).
  if [[ $DRY -eq 1 ]] || systemctl list-unit-files photo-frame-display.service 2> /dev/null | grep photo-frame-display > /dev/null; then
    [[ $DRY -eq 1 ]] && say "(if the retired photo-frame-display.service exists)"
    run systemctl disable --now photo-frame-display.service
  fi
  run systemctl daemon-reload
  run systemctl daemon-reexec
  # Started by frame-update in step 13 (there is no release yet on a first run).
  run systemctl enable "$SERVER_UNIT"
  run systemctl enable --now power-log.service
}

# ---- step 9: NetworkManager --------------------------------------------------
step_network() {
  step 9 "NetworkManager captive portal and permissions"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  ensure_dir /etc/NetworkManager/dnsmasq-shared.d 0755 root:root
  copy_file "$HERE/templates/photo-frame-captive.conf" /etc/NetworkManager/dnsmasq-shared.d/photo-frame-captive.conf 0644 root:root show
  # netdev alone is not enough for a service outside a login session; see the rule.
  ensure_dir /etc/polkit-1/rules.d 0755 root:root
  copy_file "$HERE/polkit/50-photo-frame-networkmanager.rules" /etc/polkit-1/rules.d/50-photo-frame-networkmanager.rules 0644 root:root
}

# ---- step 10: SSH ------------------------------------------------------------
key_id() { printf '%s' "$1" | awk '{ print $1, $2 }'; }

step_ssh() {
  step 10 "SSH"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  run systemctl enable --now ssh.service
  local grp ssh_dir ak have=0 existing tmp shell
  grp="$(id -gn "$INSTALL_USER" 2> /dev/null || echo "$INSTALL_USER")"
  ssh_dir="$INSTALL_HOME/.ssh"
  ak="$ssh_dir/authorized_keys"
  ensure_dir "$ssh_dir" 0700 "$INSTALL_USER:$grp"
  printf '    append owner key (%s) to %s (%s:%s 0600) unless already present\n' \
    "$(printf '%s' "$OWNER_KEY" | awk '{ print $1 }')" "$ak" "$INSTALL_USER" "$grp"
  if [[ $DRY -eq 0 ]]; then
    existing="$(as_root cat "$ak" 2> /dev/null || true)"
    if printf '%s\n' "$existing" | awk -v k="$(key_id "$OWNER_KEY")" '($1" "$2) == k || ($2" "$3) == k { f = 1 } END { exit !f }'; then
      say "owner key already present"
    else
      tmp="$(mktemp)"
      if [[ -n "$existing" ]]; then printf '%s\n' "$existing" > "$tmp"; fi
      printf '%s\n' "$OWNER_KEY" >> "$tmp"
      install_tmp "$tmp" "$ak" 0600 "$INSTALL_USER:$grp"
      rm -f "$tmp"
    fi
    shell="$(getent passwd "$INSTALL_USER" | cut -d: -f7)"
    if as_root grep -qF "$(key_id "$OWNER_KEY")" "$ak" && [[ "$shell" != */nologin && "$shell" != */false ]]; then have=1; fi
  fi
  if [[ $DRY -eq 1 ]]; then
    say "(only once the key is in place for $INSTALL_USER, a login-capable user)"
    have=1
  fi
  if [[ $have -ne 1 ]]; then
    warn "no key is installed for a login-capable user, so password SSH stays ENABLED (not locking you out)"
    return 0
  fi
  copy_file "$HERE/templates/sshd-photo-frame.conf" /etc/ssh/sshd_config.d/photo-frame.conf 0644 root:root show
  if [[ $DRY -eq 1 ]]; then
    say "\$ sshd -t (on failure: remove the file and abort)"
  else
    if ! as_root sshd -t; then
      as_root rm -f /etc/ssh/sshd_config.d/photo-frame.conf
      die "sshd rejected the configuration; removed /etc/ssh/sshd_config.d/photo-frame.conf"
    fi
    # (grep without -q: with pipefail, -q's early exit could SIGPIPE sshd)
    if ! as_root sshd -T 2> /dev/null | grep -x 'passwordauthentication no' > /dev/null; then
      warn "another sshd setting overrides PasswordAuthentication; check /etc/ssh/sshd_config.d/"
    fi
  fi
  run systemctl reload ssh.service
}

# ---- step 11: kiosk ----------------------------------------------------------
step_kiosk() {
  step 11 "Kiosk (X11 autologin + start.sh)"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  # W1 = X11 (Openbox); on bookworm raspi-config maps it to the LXDE-pi-x session.
  run raspi-config nonint do_wayland W1
  run systemctl set-default graphical.target
  # lightdm.conf may name another autologin user; our drop-in names frame.
  if [[ $DRY -eq 1 ]] || grep -q '^autologin-user=' /etc/lightdm/lightdm.conf 2> /dev/null; then
    run sed -i -e 's/^autologin-user=.*/#autologin-user=/' /etc/lightdm/lightdm.conf
  fi
  ensure_dir /etc/lightdm/lightdm.conf.d 0755 root:root
  copy_file "$HERE/templates/lightdm-50-photo-frame.conf" /etc/lightdm/lightdm.conf.d/50-photo-frame.conf 0644 root:root show
  ensure_dir "$LIB_DIR" 0755 root:root
  copy_file "$REPO/start.sh" "$LIB_DIR/start.sh" 0755 root:root
  local home="/home/$FRAME_USER" fu="$FRAME_USER:$FRAME_USER"
  ensure_dir "$home/.config" 0755 "$fu"
  ensure_dir "$home/.config/lxsession" 0755 "$fu"
  ensure_dir "$home/.config/lxsession/LXDE-pi" 0755 "$fu"
  write_file "$home/.config/lxsession/LXDE-pi/autostart" 0644 "$fu" <<< "@$LIB_DIR/start.sh"
}

# ---- step 12: hostname -------------------------------------------------------
step_hostname() {
  step 12 "Hostname and mDNS"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  run hostnamectl set-hostname "$NAME"
  local hosts
  if [[ $DRY -eq 1 ]]; then
    say "/etc/hosts: replace the 127.0.1.1 line (or add one) with: 127.0.1.1	$NAME"
  else
    hosts="$(awk -v n="$NAME" '
      /^127\.0\.1\.1[[:space:]]/ { if (!done) print "127.0.1.1\t" n; done = 1; next }
      { print }
      END { if (!done) print "127.0.1.1\t" n }' /etc/hosts)"
    if [[ "$hosts" != "$(cat /etc/hosts)" ]]; then
      write_file /etc/hosts 0644 root:root <<< "$hosts"
    else
      say "/etc/hosts already maps 127.0.1.1 to $NAME"
    fi
  fi
  run systemctl enable avahi-daemon.service
  run systemctl restart avahi-daemon.service
}

# ---- step 13: first release --------------------------------------------------
latest_tag() {
  local json tag
  json="$(curl -fsSL --proto '=https' --max-time 20 -H 'Accept: application/vnd.github+json' "$LATEST_URL" 2> /dev/null || true)"
  tag="$(printf '%s' "$json" | python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("tag_name", "") if not d.get("draft") and not d.get("prerelease") else "")
except Exception:
    print("")' 2> /dev/null || true)"
  printf '%s' "$tag"
}

step_release() {
  step 13 "First release"
  if [[ $SKIP_TO_OVERLAY -eq 1 ]]; then skipped; return 0; fi
  local tag="$TAG" stage="" rc base_env=()
  if [[ -z "$tag" ]]; then
    printf '    latest release: %s (tag must match %s)\n' "$LATEST_URL" "$TAG_RE"
    if [[ $DRY -eq 1 ]]; then
      tag="<latest>"
    else
      tag="$(latest_tag)"
      if ! [[ "$tag" =~ $TAG_RE ]]; then
        die "no published release of $REPO_SLUG found (or it is not vX.Y.Z). Publish one (git tag vX.Y.Z && git push --tags) and re-run, or install from a local build: --release-dir <dir> --tag vX.Y.Z"
      fi
      say "latest release: $tag"
    fi
  fi
  if [[ $DRY -eq 0 && -L "$DATA/current" ]] \
    && [[ "$(tr -d '[:space:]' < "$DATA/current/VERSION" 2> /dev/null || true)" == "$tag" ]] \
    && curl -fsS --max-time 3 http://localhost:3000/api/health > /dev/null 2>&1; then
    say "$tag is already installed and healthy; not reinstalling"
    return 0
  fi
  [[ $DRY -eq 1 ]] && say "(skipped if $tag is already installed and the server is healthy)"
  if [[ -n "$RELEASE_SRC" ]]; then
    # frame-update fetches <base>/<tag>/frame-<tag>.tar.gz: link the local dir in.
    if [[ $DRY -eq 1 ]]; then
      stage="<temp dir>"
      say "stage: $stage/$tag -> $RELEASE_SRC"
    else
      stage="$(as_root mktemp -d /tmp/photo-frame-release.XXXXXX)"
      run ln -s "$RELEASE_SRC" "$stage/$tag"
    fi
    base_env=("FRAME_RELEASE_BASE_URL=file://$stage")
  fi
  set +e
  run env ${base_env[@]+"${base_env[@]}"} "FRAME_DATA_DIR=$DATA" "$UPDATER" "$tag"
  rc=$?
  set -e
  if [[ $DRY -eq 0 && -n "$stage" ]]; then
    as_root rm -f "$stage/$tag"
    as_root rmdir "$stage"
  fi
  case "$rc" in
    0) [[ $DRY -eq 1 ]] || say "ok: $tag installed; the server passed its health check" ;;
    2) die "frame-update refused its arguments or the data layout (exit 2)" 2 ;;
    10) die "frame-update could not download/verify $tag (exit 10); nothing was changed" 10 ;;
    11) die "the server did not become healthy on $tag; frame-update rolled back (exit 11). Check: journalctl -u $SERVER_UNIT" 11 ;;
    12) die "another update is already running (exit 12); wait and re-run" 12 ;;
    *) die "frame-update failed (exit $rc)" "$rc" ;;
  esac
}

# ---- step 14: overlay filesystem (LAST) --------------------------------------
# Same test as raspi-config's get_bootro_conf.
boot_ro_configured() {
  grep -E '[[:space:]]/boot(/firmware)?[[:space:]]' /etc/fstab 2> /dev/null | grep -E 'defaults.*,ro[ ,]' > /dev/null
}

# Where raspi-config edits the kernel cmdline (same rule as raspi-config).
boot_dir() { if [[ -e /boot/firmware/config.txt ]]; then echo /boot/firmware; else echo /boot; fi; }
cmdline_path() {
  local prefix=""
  if [[ -e /proc/device-tree/chosen/os_prefix ]]; then prefix="$(tr -d '\0' < /proc/device-tree/chosen/os_prefix)"; fi
  echo "$(boot_dir)/${prefix}cmdline.txt"
}

# set_cmdline_first_line <file> <line>: replace line 1 (the only line the
# firmware reads), keep any others; temporarily remounts the boot partition
# rw if it is mounted ro. No chown/chmod: it is vfat.
set_cmdline_first_line() {
  local file=$1 line=$2 tmp bdir was_ro=0
  bdir="$(boot_dir)"
  tmp="$(mktemp)"
  { printf '%s\n' "$line"; awk 'NR > 1' "$file"; } > "$tmp"
  if findmnt -n -o OPTIONS "$bdir" 2> /dev/null | tr ',' '\n' | grep -x ro > /dev/null; then
    was_ro=1
    run mount -o remount,rw "$bdir"
  fi
  as_root cp "$tmp" "$file.photo-frame-new"
  as_root mv -f "$file.photo-frame-new" "$file"
  rm -f "$tmp"
  if [[ $was_ro -eq 1 ]]; then run mount -o remount,ro "$bdir" || warn "could not remount $bdir read-only"; fi
}

step_overlay() {
  step 14 "Overlay filesystem (read-only root)"
  local cmdline cur new
  if [[ $WRITABLE -eq 1 ]]; then
    run raspi-config nonint disable_overlayfs
    if [[ $DRY -eq 1 ]]; then
      say "then remove every overlayroot=tmpfs token (plain, :recurse=0 or any other options)"
      say "  from /boot/firmware/cmdline.txt, re-read it, and abort loudly if one is left"
      say "(if the overlay is not active right now)"
      run raspi-config nonint disable_bootro
    else
      cmdline="$(cmdline_path)"
      IFS= read -r cur < "$cmdline" || true
      new="$(cmdline_overlay_strip "$cur")"
      if [[ "$new" != "$cur" ]]; then
        say "remove every overlayroot=tmpfs token from $cmdline"
        set_cmdline_first_line "$cmdline" "$new"
      fi
      IFS= read -r cur < "$cmdline" || true
      if cmdline_has_overlay "$cur"; then
        die "$cmdline still contains an overlayroot=tmpfs token after disabling; fix it by hand before rebooting, or the frame stays read-only"
      fi
      say "ok: $cmdline has no overlayroot token"
      if [[ $OVERLAY_ACTIVE -eq 0 ]] && boot_ro_configured; then
        run raspi-config nonint disable_bootro
      fi
    fi
    say "maintenance mode: the root filesystem will be writable after a reboot."
    say "reboot now (sudo reboot), make your changes, then re-run without --writable."
    return 0
  fi
  if [[ $DRY -eq 1 ]]; then
    if [[ "$DATA_PART" == none ]]; then
      say "the overlay filesystem will NOT be enabled: $DATA is not a separate partition"
      return 0
    fi
    say "(only if $DATA is a separate mounted partition; otherwise it is NOT enabled)"
    say "(boot partition read-only: only if /etc/fstab does not already say so)"
    run raspi-config nonint enable_bootro
    run raspi-config nonint enable_overlayfs
    say "then rewrite the token in /boot/firmware/cmdline.txt to $OVERLAY_TOKEN (overlayroot"
    say "  defaults to recurse=1, which would put $DATA and the bind mounts in RAM), re-read"
    say "  it, and abort if it is not exactly one $OVERLAY_TOKEN token"
    return 0
  fi
  if [[ $DATA_IS_PARTITION -ne 1 ]]; then
    say "the overlay filesystem will NOT be enabled: $DATA is not a separate partition"
    print_partition_howto
    return 0
  fi
  if ! boot_ro_configured; then
    run raspi-config nonint enable_bootro
  fi
  run raspi-config nonint enable_overlayfs
  cmdline="$(cmdline_path)"
  IFS= read -r cur < "$cmdline" || true
  new="$(cmdline_overlay_enable "$cur")"
  if [[ "$new" != "$cur" ]]; then
    say "rewrite the overlay token in $cmdline to $OVERLAY_TOKEN (keeps $DATA out of the overlay)"
    set_cmdline_first_line "$cmdline" "$new"
  fi
  IFS= read -r cur < "$cmdline" || true
  if cmdline_overlay_ok "$cur"; then
    say "ok: the overlay filesystem ($OVERLAY_TOKEN) is enabled from the next boot"
  else
    die "$cmdline does not contain exactly one $OVERLAY_TOKEN token after enabling the overlay; refusing to continue (run with --writable to undo)"
  fi
}

summary() {
  printf '\nDone%s.\n' "$([[ $DRY -eq 1 ]] && echo ' (dry run: nothing was changed)')"
  say "Frame: $NAME   admin page: http://$NAME.local:3000/ (or its Tailscale name)"
  say "SSH:   ssh $INSTALL_USER@$NAME.local (key only), also over Tailscale once shared"
  say "Before giving the frame away, remove your own traces (they live on $DATA, which survives"
  say "the overlay, so these deletions are permanent):"
  say "  WiFi:      nmcli -t -f NAME,TYPE connection show   then   sudo nmcli connection delete '<name>'"
  say "  Tailscale: sudo tailscale logout   (only if you logged the frame in yourself)"
  say "  test photos: delete them on the admin page (they are stored in $DATA/uploads)"
  if [[ $DRY -eq 0 ]]; then
    say "Reboot now to start the kiosk: sudo reboot   (the installer never reboots by itself)"
  else
    say "A real run ends with: reboot now (sudo reboot); it never reboots by itself."
  fi
}

main() {
  parse_args "$@"
  validate_args
  resolve_user
  if [[ $DRY -eq 1 ]]; then printf 'photo-frame installer: dry run, no changes will be made\n'; fi
  step_preflight
  step_packages
  step_users
  step_data_partition
  step_layout
  step_persistence
  step_updater
  step_units
  step_network
  step_ssh
  step_kiosk
  step_hostname
  step_release
  step_overlay
  summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
