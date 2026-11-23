#!/usr/bin/env bash
# tailscale-operator.sh -- installed as /usr/local/lib/photo-frame/tailscale-operator.sh
# (root:root 0755) and run as root before every start of photo-frame-server
# (ExecStartPre=+-...). It re-asserts `tailscale set --operator=frame`, which
# lets the server (user frame) run `tailscale up` to show the login QR code.
#
# The operator is a tailscaled pref stored in the Tailscale state under
# /var/lib/tailscale (= /data/system/tailscale). prepare-handoff wipes that
# state and `tailscale logout` may reset it, so it is set again on every start.
#
# Idempotent. Waits up to ~15 s for tailscaled to answer. Never fails the unit:
# always exits 0. Never prints tailscale's own output.
#
# Env (tests): FRAME_TAILSCALE_OPERATOR (default frame), FRAME_TAILSCALE_WAIT
#   (seconds, default 15).
set -u

OPERATOR="${FRAME_TAILSCALE_OPERATOR:-frame}"
WAIT="${FRAME_TAILSCALE_WAIT:-15}"

log() { printf 'tailscale-operator: %s\n' "$*"; }

if ! [[ "$OPERATOR" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  log "invalid operator name; skipping"
  exit 0
fi
if ! [[ "$WAIT" =~ ^(0|[1-9][0-9]{0,2})$ ]]; then WAIT=15; fi
if ! command -v tailscale > /dev/null 2>&1; then
  log "tailscale is not installed; skipping"
  exit 0
fi

# with_timeout <seconds> <cmd...>: a hung tailscaled must not hold up the
# server start (systemd would fail the start after TimeoutStartSec).
with_timeout() {
  local secs=$1 pid w rc=0
  shift
  if command -v timeout > /dev/null 2>&1; then timeout "$secs" "$@"; return; fi
  "$@" &
  pid=$!
  (
    sleep "$secs"
    kill "$pid" 2> /dev/null
  ) > /dev/null 2>&1 &
  w=$!
  wait "$pid" || rc=$?
  kill "$w" 2> /dev/null || true
  return "$rc"
}

# `tailscale set` fails until tailscaled's socket answers, so retrying it is
# the readiness poll (`tailscale status` exits non-zero while logged out).
# Bounded by both a try count and the elapsed time.
i=0
start=$SECONDS
while :; do
  if with_timeout 3 tailscale set "--operator=$OPERATOR" > /dev/null 2>&1; then
    log "operator is $OPERATOR"
    exit 0
  fi
  if [[ $i -ge $WAIT || $((SECONDS - start)) -ge $WAIT ]]; then break; fi
  sleep 1
  i=$((i + 1))
done
log "could not set the operator (is tailscaled running?); the Tailscale login may fail until the next start"
exit 0
