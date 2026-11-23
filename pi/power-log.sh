#!/bin/bash
# Logs power/thermal state every 10s and syncs to disk, so the last lines
# before a sudden power loss survive. Installed by pi/install.sh as
# /usr/local/lib/photo-frame/power-log.sh (power-log.service).
# Output: /data/log/power-log.csv on the data partition (override: POWER_LOG).
LOG="${POWER_LOG:-/data/log/power-log.csv}"
mkdir -p "$(dirname "$LOG")"
[ -f "$LOG" ] || echo "time,uptime_s,ext5v_v,throttled,temp_c,mem_avail_mb" > "$LOG"
while true; do
  v=$(vcgencmd pmic_read_adc EXT5V_V | sed -E 's/.*=([0-9.]+)V.*/\1/')
  t=$(vcgencmd get_throttled | cut -d= -f2)
  c=$(vcgencmd measure_temp | sed -E "s/temp=([0-9.]+).*/\1/")
  m=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  echo "$(date -Is),$(cut -d. -f1 /proc/uptime),$v,$t,$c,$m" >> "$LOG"
  sync "$LOG"
  # keep the log bounded (~5MB)
  [ "$(stat -c %s "$LOG")" -gt 5000000 ] && { tail -n 20000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }
  sleep 10
done
