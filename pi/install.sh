#!/bin/bash
# Pi-side setup for the X11/LXDE photo frame. Safe to re-run.
#   cd ~/dev/rpi-frame && ./pi/install.sh
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Power/thermal logger =="
sudo cp "$HERE/power-log.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now power-log.service

echo "== Hardware watchdog =="
sudo mkdir -p /etc/systemd/system.conf.d
sudo cp "$HERE/watchdog.conf" /etc/systemd/system.conf.d/watchdog.conf
sudo systemctl daemon-reexec

echo "== Retire redundant display service (lxsession launches start.sh) =="
sudo systemctl disable --now photo-frame-display.service 2>/dev/null || true

echo "== Done =="
echo "Reboot to apply everything: sudo reboot"
