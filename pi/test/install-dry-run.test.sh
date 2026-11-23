#!/usr/bin/env bash
# Offline tests for pi/install.sh (plain bash; macOS and Linux; no root, no
# network). The installer itself only runs on a Raspberry Pi, so everything
# here goes through --dry-run or through the pure functions it exposes when
# sourced.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="$(cd "$HERE/.." && pwd)"
INSTALL="$PI/install.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
SKIP=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
skip() { SKIP=$((SKIP + 1)); echo "  SKIP: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok; else bad "$3: expected [$2] got [$1]"; fi; }
assert_contains() { if [[ "$1" == *"$2"* ]]; then ok; else bad "$3: output lacks [$2]"; fi; }
assert_not_contains() { if [[ "$1" != *"$2"* ]]; then ok; else bad "$3: output unexpectedly contains [$2]"; fi; }

# ---- fixtures ----------------------------------------------------------------
# A sandbox HOME, working directory and TMPDIR: the dry run must leave all
# three exactly as it found them.
SBX="$ROOT/sbx"
mkdir -p "$SBX/home" "$SBX/work" "$SBX/tmp"
FIX="$ROOT/fixtures"
mkdir -p "$FIX"

PUB_LINE='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFlPHVdc57etBMk7hSiK2jB7fdMD/ltOQk4HVcDkmT8V test@example'
printf '%s\n' "$PUB_LINE" > "$FIX/owner.pub"
# Not a real key; only its shape matters. The marker must never be echoed.
SECRET_MARK='b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\n%sSECRETSECRET\n-----END OPENSSH PRIVATE KEY-----\n' "$SECRET_MARK" > "$FIX/id_ed25519"
printf 'ssh-ed25519 not-base64!!\n' > "$FIX/garbage.pub"

# Release fixtures: nested (<dir>/<tag>/files) and flat (<dir>/files) layouts.
mkdir -p "$FIX/rel-nested/v1.2.3" "$FIX/rel-flat" "$FIX/rel-empty"
: > "$FIX/rel-nested/v1.2.3/frame-v1.2.3.tar.gz"
: > "$FIX/rel-nested/v1.2.3/frame-v1.2.3.tar.gz.sha256"
: > "$FIX/rel-flat/frame-v1.2.3.tar.gz"
: > "$FIX/rel-flat/frame-v1.2.3.tar.gz.sha256"

# run_install <args...>: runs the installer inside the sandbox.
# Sets OUT (stdout+stderr) and RC.
run_install() {
  OUT="$(cd "$SBX/work" && HOME="$SBX/home" TMPDIR="$SBX/tmp" bash "$INSTALL" "$@" 2>&1)"
  RC=$?
}

listing() {
  (cd "$SBX" && find . -print | LC_ALL=C sort)
  (cd "$PI/.." && git status --porcelain 2> /dev/null)
}

echo "install.sh dry-run tests"

# ---- 1. happy path: steps 1..14 in order, overlay last ----------------------
BEFORE="$(listing)"
run_install --dry-run --owner-key "$FIX/owner.pub"
assert_eq "$RC" 0 "dry-run exit code"
FIRST="$OUT"

STEPS="$(printf '%s\n' "$OUT" | sed -n -E 's/^\[([0-9]+)\/14\].*/\1/p' | tr '\n' ' ')"
assert_eq "$STEPS" "1 2 3 4 5 6 7 8 9 10 11 12 13 14 " "step order"
LAST_TITLE="$(printf '%s\n' "$OUT" | grep -E '^\[[0-9]+/14\]' | tail -n 1)"
assert_contains "$LAST_TITLE" "Overlay filesystem" "last step is the overlay filesystem"
# The overlay is switched on by the last command of the run.
LAST_CMD="$(printf '%s\n' "$OUT" | grep -E '^    \$ ' | tail -n 2 | tr '\n' ' ')"
assert_contains "$LAST_CMD" "raspi-config nonint enable_overlayfs" "enable_overlayfs is among the last commands"
L_OVL="$(printf '%s\n' "$OUT" | grep -n 'raspi-config nonint enable_overlayfs' | head -n 1 | cut -d: -f1)"
L_13="$(printf '%s\n' "$OUT" | grep -n '^\[13/14\]' | cut -d: -f1)"
if [[ -n "$L_OVL" && -n "$L_13" && "$L_OVL" -gt "$L_13" ]]; then ok; else bad "enable_overlayfs must come after step 13"; fi

for title in "Preflight" "Packages" "Users" "Data partition" "Data layout" "Persistence" \
  "Updater" "systemd units" "NetworkManager" "SSH" "Kiosk" "Hostname" "First release"; do
  assert_contains "$OUT" "$title" "step title $title"
done
assert_contains "$OUT" "dry run" "says it is a dry run"
assert_contains "$OUT" "/usr/local/sbin/frame-update" "installs the updater"
assert_contains "$OUT" "/etc/sudoers.d/photo-frame-update (root:root 0440)" "sudoers mode/owner"
assert_contains "$OUT" "visudo -cf" "sudoers validated"
assert_contains "$OUT" "photo-frame-server.service" "server unit"
assert_contains "$OUT" "address=/#/10.42.0.1" "captive DNS"
assert_contains "$OUT" "autologin-user=frame" "autologin"
assert_contains "$OUT" "autologin-session=LXDE-pi-x" "X11 session"
assert_contains "$OUT" "@/usr/local/lib/photo-frame/start.sh" "autostart line"
assert_contains "$OUT" "raspi-config nonint do_wayland W1" "X11 selected"
assert_contains "$OUT" "hostnamectl set-hostname photoframe" "hostname"
assert_contains "$OUT" "tailscale set --operator=frame" "tailscale operator"
assert_contains "$OUT" "PasswordAuthentication no" "sshd key-only"
assert_contains "$OUT" "/data/releases (root:root 0755)" "releases ownership"
assert_contains "$OUT" "/data/uploads (frame:frame 0755)" "uploads ownership"
assert_contains "$OUT" "/data/data (frame:frame 0755)" "data ownership"
assert_contains "$OUT" "api.github.com/repos/dbanksdesign/rpi-frame/releases/latest" "latest release lookup"
assert_contains "$OUT" "LABEL=FRAMEDATA /data ext4" "fstab by label"
assert_contains "$OUT" "nodesource" "NodeSource repo"
assert_contains "$OUT" "deb.nodesource.com/node_26.x nodistro main" "NodeSource Node 26 repo"
assert_contains "$OUT" "node --version is v26.x" "Node 26 check"
assert_not_contains "$OUT" "node_20.x" "no Node 20 repo"
assert_contains "$OUT" "pkgs.tailscale.com/stable/debian" "Tailscale repo"
assert_not_contains "$OUT" "djb" "no hard-coded djb"
assert_not_contains "$OUT" "photo-frame-display.service (root" "does not install the retired display unit"
assert_not_contains "$OUT" "| bash" "no curl | bash"
assert_not_contains "$OUT" "| sh" "no curl | sh"

# ---- 2. idempotent plan + no files created ----------------------------------
run_install --dry-run --owner-key "$FIX/owner.pub"
assert_eq "$RC" 0 "second dry-run exit code"
if [[ "$OUT" == "$FIRST" ]]; then ok; else bad "two dry runs differ"; fi
AFTER="$(listing)"
if [[ "$BEFORE" == "$AFTER" ]]; then ok; else
  bad "dry run created or changed files"
  diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | head -n 20
fi

# The key itself (not a file) is accepted too.
run_install --dry-run --owner-key "$PUB_LINE"
assert_eq "$RC" 0 "owner key given as a string"

# ---- 3. argument validation (exit 2) ----------------------------------------
run_install --dry-run
assert_eq "$RC" 2 "missing --owner-key"
assert_contains "$OUT" "--owner-key" "missing --owner-key message"

run_install --dry-run --owner-key "$FIX/garbage.pub"
assert_eq "$RC" 2 "invalid key file"
run_install --dry-run --owner-key "not a key"
assert_eq "$RC" 2 "invalid key string"
run_install --dry-run --owner-key "$FIX/does-not-exist.pub"
assert_eq "$RC" 2 "missing key file"
run_install --dry-run --owner-key 'command="/bin/sh" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFlPHVdc57etBMk7hSiK2jB7fdMD/ltOQk4HVcDkmT8V x'
assert_eq "$RC" 2 "authorized_keys options are refused"

run_install --dry-run --owner-key "$FIX/id_ed25519"
assert_eq "$RC" 2 "private key file"
assert_contains "$OUT" "private key" "private key message"
assert_not_contains "$OUT" "$SECRET_MARK" "private key content never printed"
run_install --dry-run --owner-key "$(cat "$FIX/id_ed25519")"
assert_eq "$RC" 2 "private key string"
assert_not_contains "$OUT" "$SECRET_MARK" "private key string never printed"

for n in "Photoframe" "1frame" "photo_frame" "a-very-long-name-that-is-over-31-chars" "" "photo frame" "frame-"; do
  run_install --dry-run --owner-key "$FIX/owner.pub" --name "$n"
  assert_eq "$RC" 2 "bad --name [$n]"
done
run_install --dry-run --owner-key "$FIX/owner.pub" --name "kitchen-frame2"
assert_eq "$RC" 0 "good --name"
assert_contains "$OUT" "hostnamectl set-hostname kitchen-frame2" "custom hostname"

run_install --dry-run --owner-key "$FIX/owner.pub" --data-partition "/tmp/x"
assert_eq "$RC" 2 "bad --data-partition"
run_install --dry-run --owner-key "$FIX/owner.pub" --tag "1.2.3"
assert_eq "$RC" 2 "bad --tag"
run_install --dry-run --owner-key "$FIX/owner.pub" --release-dir "$FIX/rel-flat"
assert_eq "$RC" 2 "--release-dir without --tag"
run_install --dry-run --owner-key "$FIX/owner.pub" --release-dir "$FIX/rel-empty" --tag v1.2.3
assert_eq "$RC" 2 "--release-dir without the tarball"
run_install --dry-run --owner-key "$FIX/owner.pub" --bogus
assert_eq "$RC" 2 "unknown flag"

# ---- 4. --writable / --data-partition none -----------------------------------
run_install --dry-run --owner-key "$FIX/owner.pub" --writable
assert_eq "$RC" 0 "--writable exit code"
assert_contains "$OUT" "raspi-config nonint disable_overlayfs" "--writable disables the overlay"
assert_not_contains "$OUT" "nonint enable_overlayfs" "--writable never enables the overlay"
assert_contains "$OUT" "reboot" "--writable says a reboot is needed"

run_install --dry-run --owner-key "$FIX/owner.pub" --data-partition none
assert_eq "$RC" 0 "--data-partition none exit code"
assert_contains "$OUT" "overlay filesystem will NOT be enabled" "no-overlay notice"
assert_not_contains "$OUT" "nonint enable_overlayfs" "no overlay without a data partition"
assert_contains "$OUT" "FRAMEDATA" "prints how to get a partition"

run_install --dry-run --owner-key "$FIX/owner.pub" --data-partition /dev/sda1
assert_eq "$RC" 0 "explicit device exit code"
assert_contains "$OUT" "/dev/sda1" "explicit device used"

# ---- 5. --release-dir layouts -------------------------------------------------
run_install --dry-run --owner-key "$FIX/owner.pub" --release-dir "$FIX/rel-nested" --tag v1.2.3
assert_eq "$RC" 0 "nested release dir"
assert_contains "$OUT" "FRAME_RELEASE_BASE_URL=file://" "file:// base url (nested)"
assert_contains "$OUT" "$FIX/rel-nested/v1.2.3" "nested layout detected"
assert_contains "$OUT" "/usr/local/sbin/frame-update v1.2.3" "runs the updater with the tag"
assert_not_contains "$OUT" "api.github.com" "no release lookup when --tag is given"

run_install --dry-run --owner-key "$FIX/owner.pub" --release-dir "$FIX/rel-flat" --tag v1.2.3
assert_eq "$RC" 0 "flat release dir"
assert_contains "$OUT" "FRAME_RELEASE_BASE_URL=file://" "file:// base url (flat)"
assert_contains "$OUT" "-> $FIX/rel-flat" "flat layout linked"

run_install --dry-run --owner-key "$FIX/owner.pub" --tag v2.0.0
assert_eq "$RC" 0 "--tag alone"
assert_contains "$OUT" "FRAME_DATA_DIR=/data /usr/local/sbin/frame-update v2.0.0" "tag from GitHub"

# ---- 6. sudoers text ----------------------------------------------------------
SUDOERS="$(bash -c 'source "$1"; sudoers_text /usr/bin/systemd-run' _ "$INSTALL")"
RULES="$(printf '%s\n' "$SUDOERS" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$')"
assert_eq "$RULES" "frame ALL=(root) NOPASSWD: /usr/bin/systemd-run --collect --unit=frame-update /usr/local/sbin/frame-update v[0-9]*" "sudoers has exactly one rule"
VISUDO="$(command -v visudo 2> /dev/null || { [[ -x /usr/sbin/visudo ]] && echo /usr/sbin/visudo; } || true)"
if [[ -n "$VISUDO" ]]; then
  printf '%s\n' "$SUDOERS" > "$ROOT/sudoers.test"
  if "$VISUDO" -cf "$ROOT/sudoers.test" > /dev/null 2>&1; then ok; else bad "visudo -cf rejects the sudoers text"; fi
else
  skip "visudo not installed; sudoers syntax not checked"
fi

# ---- 7. partition planner (pure function) -----------------------------------
plan() { bash -c 'source "$1"; plan_new_partition "$2" "$3" "$4"' _ "$INSTALL" "$@" 2> /dev/null; }
DUMP_PI='label: dos
label-id: 0xa1468510
device: /dev/mmcblk0
unit: sectors
sector-size: 512

/dev/mmcblk0p1 : start=        8192, size=     1048576, type=c
/dev/mmcblk0p2 : start=     1056768, size=     8388608, type=83'
FREE_PI='Unpartitioned space /dev/mmcblk0: 3.5 GiB, 3757047808 bytes, 7337984 sectors
Units: sectors of 1 * 512 = 512 bytes
Sector size (logical/physical): 512 bytes / 512 bytes

  Start      End Sectors  Size
   2048     8191    6144    3M
9445376 16777215 7331840  3.5G'
assert_eq "$(plan 1056768 "$DUMP_PI" "$FREE_PI")" "9445376 7331840" "plan uses free space after root"
FREE_SMALL='  Start      End Sectors  Size
   2048     8191    6144    3M
9445376 11445375 2000000  976M'
plan 1056768 "$DUMP_PI" "$FREE_SMALL" > /dev/null
assert_eq "$?" 1 "plan refuses < 2 GiB"
plan 1056768 "$DUMP_PI" "" > /dev/null
assert_eq "$?" 1 "plan refuses when there is no free space"
DUMP_ROOT_NOT_LAST="$DUMP_PI
/dev/mmcblk0p3 : start=     9445376, size=     1000000, type=83"
plan 1056768 "$DUMP_ROOT_NOT_LAST" "$FREE_PI" > /dev/null
assert_eq "$?" 1 "plan refuses when root is not the last partition"
DUMP_FULL="$DUMP_PI
/dev/mmcblk0p3 : start=     100, size=     100, type=83
/dev/mmcblk0p4 : start=     300, size=     100, type=83"
plan 1056768 "$DUMP_FULL" "$FREE_PI" > /dev/null
assert_eq "$?" 1 "plan refuses a full MBR table"
FREE_UNALIGNED='  Start      End Sectors  Size
9445377 16777215 7331839  3.5G'
assert_eq "$(plan 1056768 "$DUMP_PI" "$FREE_UNALIGNED")" "9447424 7329792" "plan aligns to 1 MiB"

# ---- 8. unit files ------------------------------------------------------------
UNITS="$PI/units"
SERVER_UNIT="$UNITS/photo-frame-server.service"
if [[ -f "$SERVER_UNIT" ]]; then ok; else bad "missing $SERVER_UNIT"; fi
for line in "User=frame" "WorkingDirectory=/data/current" \
  "ExecStart=/usr/bin/node /data/current/dist/server/index.js" \
  "Environment=NODE_ENV=production PORT=3000 FRAME_DATA_DIR=/data" \
  "AmbientCapabilities=CAP_NET_BIND_SERVICE" "RequiresMountsFor=/data" \
  "After=network-online.target NetworkManager.service tailscaled.service" \
  "Restart=always" "RestartSec=3" \
  "ProtectHome=read-only" "Environment=XAUTHORITY=/home/frame/.Xauthority" "PrivateTmp=yes"; do
  if grep -qxF "$line" "$SERVER_UNIT" 2> /dev/null; then ok; else bad "server unit lacks [$line]"; fi
done
# A frame with no WiFi must not wait for network-online before the setup screen.
if grep -qE '^Wants=.*network-online\.target' "$SERVER_UNIT"; then bad "server unit must not pull in network-online.target"; else ok; fi
# xset (Display Off/On) needs the X cookie under /home/frame: never hide /home.
if grep -qE '^ProtectHome=(yes|true|tmpfs)' "$SERVER_UNIT"; then bad "server unit hides /home (breaks xset)"; else ok; fi
if [[ -e "$UNITS/photo-frame-display.service" ]]; then bad "retired photo-frame-display.service must not exist"; else ok; fi

SERVICES=0
for unit in "$UNITS"/*.service; do
  [[ -f "$unit" ]] || continue
  SERVICES=$((SERVICES + 1))
  name="$(basename "$unit")"
  if grep -qxF "RequiresMountsFor=/data" "$unit"; then ok; else bad "$name lacks RequiresMountsFor=/data"; fi
  if grep -qE '^[[:space:]]*NoNewPrivileges=(yes|true|1|on)' "$unit"; then bad "$name sets NoNewPrivileges"; else ok; fi
  # The only /home reference allowed is the read-only X cookie path.
  if grep -v -x -F "Environment=XAUTHORITY=/home/frame/.Xauthority" "$unit" | grep -v '^#' | grep -q '/home/'; then bad "$name references /home"; else ok; fi
  # Syntax sanity: only sections, Key=Value lines, comments and blanks.
  if awk '
      /^[[:space:]]*$/ || /^[#;]/ { next }
      /^\[(Unit|Service|Install)\]$/ { sec = 1; next }
      sec && /^[A-Za-z]+=/ { next }
      { bad = 1 }
      END { exit bad }' "$unit"; then ok; else bad "$name: syntax sanity check"; fi
  if grep -qE '^ExecStart=/' "$unit"; then ok; else bad "$name: ExecStart must be an absolute path"; fi
done
if [[ "$SERVICES" -ge 2 ]]; then ok; else bad "expected server and power-log units"; fi

if command -v systemd-analyze > /dev/null 2>&1; then
  # Works without systemd as PID 1. It exits 0 even for unknown keys, so any
  # output counts as a failure -- except binaries that only exist on the Pi.
  VERIFY="$(cd "$UNITS" || exit 1; systemd-analyze verify ./*.service 2>&1 | grep -v -E 'is not executable: No such file')"
  if [[ -z "$VERIFY" ]]; then ok; else bad "systemd-analyze verify: $VERIFY"; fi
else
  skip "systemd-analyze not installed; syntax sanity check only"
fi

POLKIT="$PI/polkit/50-photo-frame-networkmanager.rules"
if [[ -f "$POLKIT" ]]; then ok; else bad "missing polkit rule"; fi
if command -v node > /dev/null 2>&1; then
  if node -e 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))' "$POLKIT" 2> /dev/null; then ok; else bad "polkit rule is not valid JavaScript"; fi
else
  skip "node not installed; polkit rule not parsed"
fi

# ---- 8b. fix round 1: boot ordering, root-copy leak, overlay recurse --------------
run_install --dry-run --owner-key "$FIX/owner.pub"
NM_BIND="$(printf '%s\n' "$OUT" | grep '^    fstab: .* /etc/NetworkManager/system-connections ' || true)"
TS_BIND="$(printf '%s\n' "$OUT" | grep '^    fstab: .* /var/lib/tailscale ' || true)"
assert_contains "$NM_BIND" "x-systemd.before=NetworkManager.service" "NM bind is ordered before NetworkManager"
assert_contains "$TS_BIND" "x-systemd.before=tailscaled.service" "Tailscale bind is ordered before tailscaled"
assert_contains "$NM_BIND" "nofail" "NM bind still nofail"
assert_contains "$OUT" "delete originals under /etc/NetworkManager/system-connections" "NM originals removed from root"
assert_contains "$OUT" "delete originals under /var/lib/tailscale" "Tailscale originals removed from root"
assert_contains "$OUT" "sudo ./pi/prepare-handoff.sh --clear-photos|--keep-photos" "handoff note: prepare-handoff"
assert_contains "$OUT" "admin page: http://photoframe.local/" "summary admin URL is port 80"
assert_not_contains "$OUT" "photoframe.local:3000" "summary no longer prints :3000"
assert_contains "$OUT" "overlayroot=tmpfs:recurse=0" "overlay must not recurse into /data"
run_install --dry-run --owner-key "$FIX/owner.pub" --writable
assert_contains "$OUT" "remove every overlayroot=tmpfs token" "--writable strips every overlay token"

# cmdline token helpers (pure)
cl() { bash -c 'source "$1"; shift; "$@"' _ "$INSTALL" "$@"; }
assert_eq "$(cl cmdline_overlay_enable 'console=tty1 root=PARTUUID=ab-02 rootwait')" \
  "overlayroot=tmpfs:recurse=0 console=tty1 root=PARTUUID=ab-02 rootwait" "enable prepends the recurse=0 token"
assert_eq "$(cl cmdline_overlay_enable 'overlayroot=tmpfs console=tty1 rootwait')" \
  "overlayroot=tmpfs:recurse=0 console=tty1 rootwait" "enable rewrites raspi-config's plain token"
assert_eq "$(cl cmdline_overlay_enable 'overlayroot=tmpfs:recurse=0 console=tty1')" \
  "overlayroot=tmpfs:recurse=0 console=tty1" "enable is idempotent"
assert_eq "$(cl cmdline_overlay_enable 'a overlayroot=tmpfs:swap=1 b overlayroot=tmpfs c')" \
  "overlayroot=tmpfs:recurse=0 a b c" "enable leaves exactly one token"
assert_eq "$(cl cmdline_overlay_strip 'overlayroot=tmpfs:recurse=0 console=tty1 rootwait')" \
  "console=tty1 rootwait" "strip removes the recurse=0 token"
assert_eq "$(cl cmdline_overlay_strip 'overlayroot=tmpfs console=tty1')" "console=tty1" "strip removes the plain token"
assert_eq "$(cl cmdline_overlay_strip 'a overlayroot=tmpfs:recurse=0,swap=1 b overlayroot=tmpfs')" "a b" "strip removes every variant"
assert_eq "$(cl cmdline_overlay_strip 'console=tty1 noverlayroot=tmpfs')" "console=tty1 noverlayroot=tmpfs" "strip leaves other tokens"
if cl cmdline_has_overlay 'console=tty1 overlayroot=tmpfs:recurse=0'; then ok; else bad "has_overlay: recurse=0 variant"; fi
if cl cmdline_has_overlay 'overlayroot=tmpfs rootwait'; then ok; else bad "has_overlay: plain token"; fi
if cl cmdline_has_overlay 'console=tty1 rootwait'; then bad "has_overlay: no token"; else ok; fi
if cl cmdline_has_overlay 'overlayroot=disabled'; then bad "has_overlay: disabled"; else ok; fi
if cl cmdline_overlay_ok 'overlayroot=tmpfs:recurse=0 console=tty1'; then ok; else bad "overlay_ok: recurse=0"; fi
if cl cmdline_overlay_ok 'overlayroot=tmpfs console=tty1'; then bad "overlay_ok: plain token would recurse into /data"; else ok; fi

# set_cmdline_first_line: the one write that can stop the Pi from booting.
CMD="$ROOT/boot"
mkdir -p "$CMD"
printf 'console=tty1 root=PARTUUID=ab-02 rootwait\n# second line kept\n' > "$CMD/cmdline.txt"
scl() { # <line>: runs set_cmdline_first_line on $CMD/cmdline.txt with root/mount helpers stubbed
  OUT="$(bash -c 'source "$1"; B=$2; as_root() { "$@"; }; run() { "$@"; }; boot_dir() { printf "%s\n" "$B"; }; findmnt() { return 1; }
    set_cmdline_first_line "$2/cmdline.txt" "$3"' _ "$INSTALL" "$CMD" "$1" 2>&1)"
  RC=$?
}
scl "overlayroot=tmpfs:recurse=0 console=tty1 root=PARTUUID=ab-02 rootwait"
assert_eq "$RC" 0 "cmdline rewrite exit"
assert_eq "$(cat "$CMD/cmdline.txt")" "overlayroot=tmpfs:recurse=0 console=tty1 root=PARTUUID=ab-02 rootwait
# second line kept" "cmdline first line replaced, other lines kept"
assert_eq "$(cat "$CMD/cmdline.txt.photo-frame.orig" 2> /dev/null)" "console=tty1 root=PARTUUID=ab-02 rootwait
# second line kept" "original cmdline backed up before the first rewrite"
scl "console=tty1 root=PARTUUID=ab-02 rootwait"
assert_eq "$RC" 0 "second cmdline rewrite exit"
assert_eq "$(head -n 1 "$CMD/cmdline.txt.photo-frame.orig")" "console=tty1 root=PARTUUID=ab-02 rootwait" "backup is never overwritten"
before_cmd="$(cat "$CMD/cmdline.txt")"
for badline in "" "   " "overlayroot=tmpfs:recurse=0 console=tty1 rootwait" "noroot=PARTUUID=ab-02"; do
  scl "$badline"
  if [[ "$RC" -ne 0 ]]; then ok; else bad "cmdline rewrite must refuse [$badline]"; fi
  assert_eq "$(cat "$CMD/cmdline.txt")" "$before_cmd" "refused cmdline rewrite leaves the file alone [$badline]"
done
assert_eq "$(find "$CMD" -name '*.photo-frame-new' | wc -l | tr -d ' ')" 0 "no staged cmdline file left behind"
# both boot-file writers go through boot_write, which syncs before and after the rename
if sed -n '/^boot_write() {/,/^}/p' "$INSTALL" | grep -c -w sync | grep -qx 2; then ok; else bad "boot_write syncs before and after the rename"; fi
if sed -n '/^set_cmdline_first_line() {/,/^}/p' "$INSTALL" | grep -qw boot_write; then ok; else bad "set_cmdline_first_line syncs the boot partition (boot_write)"; fi
# --writable with no cmdline file must fail, not report success
OUT="$(bash -c 'source "$1"; R=$2; as_root() { "$@"; }; run() { :; }; cmdline_path() { echo "$R/missing/cmdline.txt"; }
  DRY=0; WRITABLE=1; step_overlay' _ "$INSTALL" "$ROOT" 2>&1)"
RC=$?
if [[ "$RC" -ne 0 ]]; then ok; else bad "--writable with a missing cmdline.txt must fail"; fi
assert_not_contains "$OUT" "ok: " "--writable with a missing cmdline.txt reports no success"
assert_contains "$OUT" "cmdline" "--writable missing-file message names the file"

# ---- 8c. follow-up: the .orig backup is the pre-overlay line ---------------------
# backup_cmdline <file> must leave <file>.photo-frame.orig with a bootable line
# and NO overlayroot= token (its purpose: boot writable with the overlay off).
PI_LINE='console=serial0,115200 console=tty1 root=PARTUUID=ab12cd34-02 rootfstype=ext4 fsck.repair=yes rootwait cfg80211.ieee80211_regdom=GB'
BK="$ROOT/bk"
bk_reset() { rm -rf "$BK"; mkdir -p "$BK"; printf '%s\n' "$1" > "$BK/cmdline.txt"; }
bkp() { # [findmnt options]: runs backup_cmdline on $BK/cmdline.txt; run() only records
  OUT="$(bash -c 'source "$1"; B=$2; MNT=$3; as_root() { "$@"; }; run() { printf "RUN %s\n" "$*"; }
    boot_dir() { printf "%s\n" "$B"; }; findmnt() { if [[ -n "$MNT" ]]; then printf "%s\n" "$MNT"; else return 1; fi; }
    backup_cmdline "$B/cmdline.txt"' _ "$INSTALL" "$BK" "${1:-}" 2>&1)"
  RC=$?
}
orig_of() { cat "$BK/cmdline.txt.photo-frame.orig" 2> /dev/null; }
for variant in "overlayroot=tmpfs $PI_LINE" "overlayroot=tmpfs:recurse=0 $PI_LINE" \
  "console=serial0,115200 overlayroot=tmpfs:recurse=0 console=tty1 root=PARTUUID=ab12cd34-02 rootfstype=ext4 fsck.repair=yes rootwait cfg80211.ieee80211_regdom=GB" "$PI_LINE"; do
  bk_reset "$variant"
  bkp
  assert_eq "$RC" 0 "backup exit [$variant]"
  assert_eq "$(orig_of)" "$PI_LINE" "backup is the line without any overlayroot token [$variant]"
  assert_eq "$(cat "$BK/cmdline.txt")" "$variant" "backup leaves cmdline.txt alone [$variant]"
  if [[ -e "$BK/cmdline.txt.photo-frame.orig.old" ]]; then bad "no .orig.old for a first backup [$variant]"; else ok; fi
done
# other lines are kept, as in the live file
bk_reset "overlayroot=tmpfs $PI_LINE"
printf '# second line kept\n' >> "$BK/cmdline.txt"
bkp
assert_eq "$(orig_of)" "$PI_LINE
# second line kept" "backup keeps the other lines"
# a clean existing backup is never touched
bk_reset "overlayroot=tmpfs:recurse=0 $PI_LINE"
printf 'console=tty1 root=PARTUUID=0ld-02 rootwait\n' > "$BK/cmdline.txt.photo-frame.orig"
bkp
assert_eq "$RC" 0 "clean existing backup: exit"
assert_eq "$(orig_of)" "console=tty1 root=PARTUUID=0ld-02 rootwait" "clean existing backup left alone"
if [[ -e "$BK/cmdline.txt.photo-frame.orig.old" ]]; then bad "clean backup: no .orig.old"; else ok; fi
# a polluted backup (written by the previous installer, after raspi-config) is
# replaced by its own stripped line; the old file is kept once as .orig.old
bk_reset "overlayroot=tmpfs:recurse=0 $PI_LINE"
printf 'overlayroot=tmpfs console=tty1 root=PARTUUID=0ld-02 rootwait\n# kept\n' > "$BK/cmdline.txt.photo-frame.orig"
bkp
assert_eq "$RC" 0 "polluted backup: exit"
assert_eq "$(orig_of)" "console=tty1 root=PARTUUID=0ld-02 rootwait
# kept" "polluted backup replaced by its own line without the token"
assert_eq "$(cat "$BK/cmdline.txt.photo-frame.orig.old" 2> /dev/null)" "overlayroot=tmpfs console=tty1 root=PARTUUID=0ld-02 rootwait
# kept" "polluted backup kept as .orig.old"
assert_contains "$OUT" "photo-frame.orig" "polluted backup: the run says what it did"
bkp
assert_eq "$RC" 0 "polluted backup, second run: exit"
assert_eq "$(orig_of)" "console=tty1 root=PARTUUID=0ld-02 rootwait
# kept" "second run: backup unchanged"
assert_eq "$(cat "$BK/cmdline.txt.photo-frame.orig.old" 2> /dev/null)" "overlayroot=tmpfs console=tty1 root=PARTUUID=0ld-02 rootwait
# kept" "second run: .orig.old unchanged"
assert_eq "$(find "$BK" -name '*.photo-frame-new' | wc -l | tr -d ' ')" 0 "no staged backup file left behind"
# refusals: nonzero, nothing changed
for badline in "" "   " "overlayroot=tmpfs" "overlayroot=tmpfs:recurse=0 console=tty1 rootwait"; do
  bk_reset "$badline"
  bkp
  if [[ "$RC" -ne 0 ]]; then ok; else bad "backup must refuse [$badline]"; fi
  if [[ -e "$BK/cmdline.txt.photo-frame.orig" ]]; then bad "refused backup must not create .orig [$badline]"; else ok; fi
  assert_eq "$(cat "$BK/cmdline.txt")" "$badline" "refused backup leaves cmdline.txt alone [$badline]"
  assert_not_contains "$OUT" "RUN mount" "refused backup does not remount [$badline]"
done
bk_reset "overlayroot=tmpfs:recurse=0 $PI_LINE"
printf 'overlayroot=tmpfs console=tty1 rootwait\n' > "$BK/cmdline.txt.photo-frame.orig"
bkp
if [[ "$RC" -ne 0 ]]; then ok; else bad "backup must refuse a polluted .orig without root="; fi
assert_eq "$(orig_of)" "overlayroot=tmpfs console=tty1 rootwait" "refused: polluted .orig unchanged"
if [[ -e "$BK/cmdline.txt.photo-frame.orig.old" ]]; then bad "refused: no .orig.old"; else ok; fi
bk_reset "$PI_LINE"
rm -f "$BK/cmdline.txt"
bkp
if [[ "$RC" -ne 0 ]]; then ok; else bad "backup must refuse a missing cmdline.txt"; fi
# boot partition mounted ro: remount rw for the write, then ro again; rw: no remount
bk_reset "overlayroot=tmpfs $PI_LINE"
bkp "ro,relatime,fmask=0022"
assert_eq "$(printf '%s\n' "$OUT" | grep '^RUN mount' | tr '\n' '|')" "RUN mount -o remount,rw $BK|RUN mount -o remount,ro $BK|" "ro boot partition: remount rw, then ro"
assert_eq "$(orig_of)" "$PI_LINE" "ro boot partition: backup written"
bk_reset "overlayroot=tmpfs $PI_LINE"
bkp "rw,relatime"
assert_not_contains "$OUT" "RUN mount" "rw boot partition: no remount"
if sed -n '/^backup_cmdline() {/,/^}/p' "$INSTALL" | grep -qw boot_write; then ok; else bad "backup_cmdline syncs the boot partition (boot_write)"; fi
if sed -n '/^set_cmdline_first_line() {/,/^}/p' "$INSTALL" | grep -qw backup_cmdline; then ok; else bad "set_cmdline_first_line uses backup_cmdline (one place)"; fi
# the rewrite helper also cleans a polluted backup (e.g. --writable on a frame
# installed by the previous version)
bk_reset "overlayroot=tmpfs:recurse=0 $PI_LINE"
printf 'overlayroot=tmpfs %s\n' "$PI_LINE" > "$BK/cmdline.txt.photo-frame.orig"
OUT="$(bash -c 'source "$1"; B=$2; as_root() { "$@"; }; run() { "$@"; }; boot_dir() { printf "%s\n" "$B"; }; findmnt() { return 1; }
  set_cmdline_first_line "$B/cmdline.txt" "$3"' _ "$INSTALL" "$BK" "$PI_LINE" 2>&1)"
assert_eq "$?" 0 "rewrite with a polluted backup: exit"
assert_eq "$(orig_of)" "$PI_LINE" "rewrite helper cleans a polluted backup"
assert_eq "$(cat "$BK/cmdline.txt")" "$PI_LINE" "rewrite helper still writes the new line"

# step_overlay for real against a temp boot dir: a raspi-config stub records
# whether the backup already existed (and was clean) when it ran, and mimics
# enable_overlayfs by prefixing the plain token.
RC_STUB="$ROOT/rcstub"
mkdir -p "$RC_STUB"
cat > "$RC_STUB/raspi-config" << 'STUB'
#!/usr/bin/env bash
f="$STUB_BOOT/cmdline.txt"
state=absent
if [[ -e "$f.photo-frame.orig" ]]; then
  if grep -q 'overlayroot=' "$f.photo-frame.orig"; then state=polluted; else state=clean; fi
fi
printf '%s orig=%s\n' "$2" "$state" >> "$STUB_LOG"
if [[ "$2" == enable_overlayfs ]]; then
  { printf 'overlayroot=tmpfs '; cat "$f"; } > "$f.tmp" && mv "$f.tmp" "$f"
fi
STUB
chmod +x "$RC_STUB/raspi-config"
step_overlay_real() { # runs a real (non-dry) step_overlay against $BK
  : > "$ROOT/rc.log"
  OUT="$(PATH="$RC_STUB:$PATH" STUB_BOOT="$BK" STUB_LOG="$ROOT/rc.log" bash -c 'source "$1"; B=$2
    as_root() { "$@"; }; run() { printf "RUN %s\n" "$*"; "$@"; }; boot_dir() { printf "%s\n" "$B"; }
    cmdline_path() { printf "%s/cmdline.txt\n" "$B"; }; findmnt() { return 1; }; boot_ro_configured() { return 1; }
    DRY=0; WRITABLE=0; DATA_IS_PARTITION=1; step_overlay' _ "$INSTALL" "$BK" 2>&1)"
  RC=$?
}
bk_reset "$PI_LINE"
step_overlay_real
assert_eq "$RC" 0 "real step_overlay exit"
assert_eq "$(cat "$ROOT/rc.log")" "enable_bootro orig=clean
enable_overlayfs orig=clean" "the clean backup exists before raspi-config touches anything"
assert_eq "$(orig_of)" "$PI_LINE" "backup holds the pre-overlay line"
assert_eq "$(cat "$BK/cmdline.txt")" "overlayroot=tmpfs:recurse=0 $PI_LINE" "cmdline ends with exactly the recurse=0 token"
assert_contains "$OUT" "ok: the overlay filesystem" "real step_overlay reports success"
# re-run on an already-overlaid frame whose backup came from the previous version
printf 'overlayroot=tmpfs %s\n' "$PI_LINE" > "$BK/cmdline.txt.photo-frame.orig"
step_overlay_real
assert_eq "$RC" 0 "real step_overlay re-run exit"
assert_eq "$(head -n 1 "$ROOT/rc.log")" "enable_bootro orig=clean" "re-run: polluted backup cleaned before raspi-config"
assert_eq "$(orig_of)" "$PI_LINE" "re-run: backup holds the pre-overlay line"
assert_eq "$(cat "$BK/cmdline.txt")" "overlayroot=tmpfs:recurse=0 $PI_LINE" "re-run: still exactly one recurse=0 token"
# a refused backup stops the step before raspi-config runs
bk_reset "overlayroot=tmpfs console=tty1 rootwait"
step_overlay_real
if [[ "$RC" -ne 0 ]]; then ok; else bad "step_overlay must stop when the backup is refused"; fi
assert_eq "$(cat "$ROOT/rc.log")" "" "refused backup: raspi-config never ran"
assert_eq "$(cat "$BK/cmdline.txt")" "overlayroot=tmpfs console=tty1 rootwait" "refused backup: cmdline unchanged"
# dry run: the backup step is listed before raspi-config's overlay commands
run_install --dry-run --owner-key "$FIX/owner.pub"
S14="$(printf '%s\n' "$OUT" | sed -n '/^\[14\/14\]/,$p')"
L_BK="$(printf '%s\n' "$S14" | grep -n 'photo-frame.orig' | head -n 1 | cut -d: -f1)"
L_BRO="$(printf '%s\n' "$S14" | grep -n 'raspi-config nonint enable_bootro' | head -n 1 | cut -d: -f1)"
L_EOV="$(printf '%s\n' "$S14" | grep -n 'raspi-config nonint enable_overlayfs' | head -n 1 | cut -d: -f1)"
if [[ -n "$L_BK" && -n "$L_BRO" && -n "$L_EOV" && "$L_BK" -lt "$L_BRO" && "$L_BK" -lt "$L_EOV" ]]; then ok; else
  bad "dry run must list the cmdline backup before enable_bootro/enable_overlayfs ($L_BK/$L_BRO/$L_EOV)"
fi
assert_contains "$S14" "without any overlayroot token" "dry run: the backup has no overlay token"

# remove_copied_originals: deletes a root original only when /data holds an
# identical copy (same content and mode); never touches the copy.
MV="$ROOT/mv"
mkdir -p "$MV/src/sub" "$MV/dst/sub" "$MV/src/emptydir"
printf 'psk=owner\n' > "$MV/src/home.nmconnection"; cp -p "$MV/src/home.nmconnection" "$MV/dst/"
printf 'new\n' > "$MV/src/differs.nmconnection"; printf 'other\n' > "$MV/dst/differs.nmconnection"
printf 'only-on-root\n' > "$MV/src/notcopied.nmconnection"
printf 'state\n' > "$MV/src/sub/tailscaled.state"; cp -p "$MV/src/sub/tailscaled.state" "$MV/dst/sub/"
printf 'm\n' > "$MV/src/mode"; cp -p "$MV/src/mode" "$MV/dst/"; chmod 600 "$MV/src/mode"; chmod 644 "$MV/dst/mode"
printf 'brother\n' > "$MV/dst/brother.nmconnection"
bash -c 'source "$1"; as_root() { "$@"; }; DRY=0; remove_copied_originals "$2" "$3"' _ "$INSTALL" "$MV/src" "$MV/dst" > /dev/null
present() { if [[ -e "$1" ]]; then ok; else bad "$2"; fi; }
absent() { if [[ -e "$1" ]]; then bad "$2"; else ok; fi; }
absent "$MV/src/home.nmconnection" "identical original not deleted"
absent "$MV/src/sub/tailscaled.state" "identical nested original not deleted"
present "$MV/src/differs.nmconnection" "differing original must be kept"
present "$MV/src/notcopied.nmconnection" "uncopied original must be kept"
present "$MV/src/mode" "original with a different mode must be kept"
absent "$MV/src/emptydir" "empty subdirectory not removed"
present "$MV/src" "source directory itself must stay (it is the mount point)"
for f in home.nmconnection differs.nmconnection sub/tailscaled.state brother.nmconnection mode; do
  present "$MV/dst/$f" "copy $f must never be deleted"
done

# ---- 8c. Tailscale operator helper (ExecStartPre=+-, root) ------------------------
OPH="$PI/units/tailscale-operator.sh"
if [[ -f "$OPH" && -x "$OPH" ]]; then ok; else bad "missing or non-executable $OPH"; fi
assert_contains "$FIRST" "install pi/units/tailscale-operator.sh -> /usr/local/lib/photo-frame/tailscale-operator.sh (root:root 0755)" "installer installs the operator helper"
if grep -qxF "ExecStartPre=+-/usr/local/lib/photo-frame/tailscale-operator.sh" "$SERVER_UNIT"; then ok; else bad "server unit re-asserts the Tailscale operator before every start"; fi
OPB="$ROOT/opbin"
mkdir -p "$OPB"
# stub tailscale: fails until $OP_STATE/fails is down to 0, records argv
cat > "$OPB/tailscale" << 'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$OP_STATE/calls"
n="$(cat "$OP_STATE/fails" 2> /dev/null || echo 0)"
if [[ "$n" -gt 0 ]]; then echo $((n - 1)) > "$OP_STATE/fails"; echo "tskey-NOT-PRINTED" >&2; exit 1; fi
exit 0
STUB
chmod +x "$OPB/tailscale"
run_op() { # <fails> [env...]
  OP_STATE="$(mktemp -d "$ROOT/op.XXXXXX")"
  echo "$1" > "$OP_STATE/fails"
  shift
  OUT="$(env OP_STATE="$OP_STATE" PATH="$OPB:/usr/bin:/bin" "$@" bash "$OPH" 2>&1)"
  RC=$?
  OPCALLS="$(cat "$OP_STATE/calls" 2> /dev/null || true)"
}
run_op 0
assert_eq "$RC" 0 "operator helper exit (daemon ready)"
assert_eq "$OPCALLS" "set --operator=frame" "operator helper sets the operator once"
run_op 3
assert_eq "$RC" 0 "operator helper exit (daemon slow)"
assert_eq "$(printf '%s\n' "$OPCALLS" | grep -c -x 'set --operator=frame')" 4 "operator helper retries until tailscaled answers"
run_op 1000 FRAME_TAILSCALE_WAIT=3
assert_eq "$RC" 0 "operator helper never fails the unit"
n_calls="$(printf '%s\n' "$OPCALLS" | grep -c .)"
if [[ "$n_calls" -ge 2 && "$n_calls" -le 5 ]]; then ok; else bad "operator helper gives up after FRAME_TAILSCALE_WAIT (3) tries (got $n_calls)"; fi
assert_not_contains "$OUT" "tskey-NOT-PRINTED" "operator helper prints no tailscale output"
run_op 0 FRAME_TAILSCALE_OPERATOR=tester
assert_eq "$OPCALLS" "set --operator=tester" "operator name overridable for tests"
run_op 0 'FRAME_TAILSCALE_OPERATOR=x;reboot'
assert_eq "$OPCALLS" "" "bad operator name refused"
assert_eq "$RC" 0 "bad operator name still exits 0"
OUT="$(env PATH="/nonexistent" /bin/bash "$OPH" 2>&1)"
assert_eq "$?" 0 "operator helper exits 0 without tailscale"
# a hung tailscaled: each call is bounded and the whole helper stays well under
# systemd's start timeout (real sleep here, so FRAME_TAILSCALE_WAIT keeps it short)
OPH_HUNG="$ROOT/ophung"
mkdir -p "$OPH_HUNG"
printf '#!/usr/bin/env bash\nexec sleep 30\n' > "$OPH_HUNG/tailscale"
chmod +x "$OPH_HUNG/tailscale"
t0=$SECONDS
OUT="$(env PATH="$OPH_HUNG:/usr/bin:/bin" FRAME_TAILSCALE_WAIT=2 bash "$OPH" 2>&1)"
rc=$?
assert_eq "$rc" 0 "operator helper exits 0 with a hung tailscaled"
if [[ $((SECONDS - t0)) -le 12 ]]; then ok; else bad "operator helper blocked $((SECONDS - t0)) s on a hung tailscaled"; fi

# ---- 9. scripts parse -----------------------------------------------------------
for s in "$INSTALL" "$PI/power-log.sh" "$OPH"; do
  if bash -n "$s"; then ok; else bad "bash -n $s"; fi
done
if grep -q '/home/djb' "$PI/power-log.sh"; then bad "power-log.sh references /home/djb"; else ok; fi

echo "install.sh tests: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
