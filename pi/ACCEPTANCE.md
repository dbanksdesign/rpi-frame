# Hardware acceptance checklist

Everything that could be tested off-device has been (unit tests, installer dry runs, containers).
This list covers what only a real Raspberry Pi 5, a real LCD, a router, a phone and two Tailscale
accounts can prove. Run it on a **spare** Pi before giving a frame away. The facts it relies on
are in `pi/README.md` and the scripts it names.

## How to use this checklist

- Use a **spare Pi 5, a spare SD card and the LCD** (or a similar one). **Never run it on the
  frame in daily use.** Several steps are destructive: re-flashing, deleting WiFi profiles,
  `echo c > /proc/sysrq-trigger`, wiping Tailscale. Those are marked **SPARE PI ONLY**.
- Allow about half a day of hands-on work, plus a 24 h soak and a 3-day soak (section 9).
- Sections are in risk order: if section 1 fails, stop and fix it. Nothing later is meaningful.
- Each step is a checkbox. Write the observed value next to it when it is a number. A step that
  says "verify" is one where the exact command or output could not be confirmed off-device.
- Needed: an SSH key pair (the owner key, `~/owner.pub`), a phone (iPhone and Android if you can),
  a laptop, a keyboard for the Pi, an Ethernet cable (used to keep a session when WiFi is
  removed), two Tailscale accounts (the "brother" tailnet and the owner's), the router's admin
  page, and the repo cloned on the Pi.
- In this document `<user>` is the login user who ran the installer, `<tag>` a release such as
  `v0.1.0`, and `photoframe` the default hostname.

## Contents

1. [Overlay filesystem and data partition](#1-overlay-filesystem-and-data-partition)
2. [Kiosk, Node and sharp](#2-kiosk-node-and-sharp)
3. [Tailscale and remote access](#3-tailscale-and-remote-access)
4. [WiFi setup hotspot](#4-wifi-setup-hotspot)
5. [Admin page on port 80](#5-admin-page-on-port-80)
6. [WiFi loss behaviour](#6-wifi-loss-behaviour)
7. [Updates and rollback](#7-updates-and-rollback)
8. [Power cuts and the watchdog](#8-power-cuts-and-the-watchdog)
9. [Power supply, soak and memory](#9-power-supply-soak-and-memory)
10. [End-user run-through](#10-end-user-run-through)
11. [Handoff](#11-handoff)
12. [Record results](#12-record-results)

---

## 1. Overlay filesystem and data partition

Why first: with the overlay on, `/` lives in RAM. If `/data` or the WiFi/Tailscale bind mounts are
also in RAM, everything is lost at the next power cut. The installer sets
`overlayroot=tmpfs:recurse=0` for this; it was checked against the scripts, never on a device.

### 1.1 Prepare the card (SPARE CARD ONLY)

- [ ] Flash Raspberry Pi OS **64-bit with desktop, bookworm** with Raspberry Pi Imager. In Imager
  set a user and your WiFi. Do not enable SSH there.
- [ ] Boot once so the OS grows the root partition. Then, with the card in another Linux machine,
  shrink the root partition so at least 2 GiB is unallocated after it (GParted, or the CLI steps
  in `pi/README.md`, "One-time manual step"). Leave the space **unallocated** so the installer's
  create-partition path is what gets tested.
- [ ] On the Pi, `lsblk` shows the root partition with free space after it and no `FRAMEDATA`
  partition yet.

### 1.2 Install

- [ ] Get a release to install from. Section 7.1 publishes `v0.1.0`; use that tag. For the offline
  path, on another machine run `gh release download <tag> -R dbanksdesign/rpi-frame -D ~/rel/<tag>`
  and copy `~/rel` to the Pi.
- [ ] `git clone https://github.com/dbanksdesign/rpi-frame && cd rpi-frame` (on the branch you
  are testing), from the **LAN**, not over Tailscale.
- [ ] `./pi/install.sh --owner-key ~/owner.pub --name photoframe --dry-run` prints 14 steps
  and changes nothing.
- [ ] `./pi/install.sh --owner-key ~/owner.pub --name photoframe --release-dir ~/rel --tag <tag>`
  runs to the end. Step 4 creates the partition: it prints "creating a partition on ..." and the
  card still works afterwards. Step 13 ends with "the server passed its health check". The last
  line says to reboot; the installer never reboots by itself.
- [ ] No `WARNING` about a kept WiFi or Tailscale file. If there is one, delete that file by hand.
- [ ] `lsblk -f` shows an ext4 partition labelled `FRAMEDATA`.
- [ ] Re-run the same command. It finishes again without errors and without a second partition
  (idempotent). Fail: `pi/install.sh`, functions `step_data_partition` and `create_partition`.

### 1.3 Overlay and persistence

- [ ] `sudo reboot`, then log in over SSH: `ssh <user>@photoframe.local`.
- [ ] `cat /proc/cmdline` contains `overlayroot=tmpfs:recurse=0`, exactly once.
- [ ] `findmnt -no FSTYPE /` prints `overlay` (verify: it may print `overlayroot` on some images;
  what matters is that `/` is not the SD card's ext4 any more).
- [ ] `findmnt -no SOURCE,FSTYPE,OPTIONS /data` shows the `FRAMEDATA` partition (a
  `/dev/mmcblk0p3`-style device), `ext4`, options include `rw`. It is **not** `overlay`.
- [ ] `findmnt /etc/NetworkManager/system-connections` and `findmnt /var/lib/tailscale` show bind
  mounts whose source is under `/data/system/`.
- [ ] Persistence test, then reboot:
  ```
  echo ok | sudo tee /data/acceptance-test.txt
  echo ok | sudo tee /etc/NetworkManager/system-connections/acceptance-test.txt
  echo ok | sudo tee /etc/acceptance-root-test.txt
  sudo reboot
  ```
- [ ] After the reboot: `/data/acceptance-test.txt` and
  `/etc/NetworkManager/system-connections/acceptance-test.txt` **exist**. `/etc/acceptance-root-test.txt`
  **does not** (the root really is in RAM). Remove the first two with `sudo rm`.
- [ ] `systemctl --failed` is empty. `systemctl list-units --type=mount | grep -i fail` is empty.
- [ ] `./pi/install.sh --owner-key ~/owner.pub --writable`, `sudo reboot`: `/proc/cmdline` has no
  `overlayroot=` token and `echo x | sudo tee /etc/writable-test` still exists after another
  reboot. Remove it. Then re-run `./pi/install.sh --owner-key ~/owner.pub` and `sudo reboot` to
  turn the overlay back on (README, "Maintaining a frame"). A normal run with the overlay on
  must **refuse** (preflight): confirm that message once.

> **If this fails:** `/data` shows `overlay` or the files vanish: `pi/install.sh`,
> `cmdline_overlay_enable` and `step_overlay`; `/boot/firmware/cmdline.txt` (first line);
> `raspi-config nonint enable_overlayfs` (verify what it wrote). To get the card writable again,
> edit `/boot/firmware/cmdline.txt` on another machine and remove `overlayroot=tmpfs...`.

### 1.4 Boot ordering after a power cut

Do this with the overlay on, WiFi saved and Tailscale logged in (section 3 first on a first pass;
come back here after it).

- [ ] Pull the plug (not `reboot`) three times, a minute apart, then let it boot.
- [ ] After each boot: the frame rejoins WiFi **without** showing the `PhotoFrame-Setup` screen,
  `nmcli -t -f NAME,TYPE connection show` lists the saved WiFi, `tailscale status` shows it logged in
  and `systemctl --failed` is empty.
- [ ] `journalctl -b -u NetworkManager -u tailscaled --no-pager | head -60`: the bind-mounted
  directories appear before NetworkManager reads profiles and before tailscaled starts (no
  "state file not found" or "starting from scratch"). `systemd-analyze critical-chain
  NetworkManager.service` lists the bind mount units ahead of NetworkManager (verify).
- [ ] `date` is sane after boot (fake-hwclock restores from `/data/system`, drop-in
  `pi/templates/fake-hwclock-photo-frame.conf`).

> **If this fails:** `/etc/fstab` lines for the two bind mounts (they carry
> `x-systemd.before=NetworkManager.service` / `tailscaled.service`), `pi/install.sh`
> `step_persistence`, `journalctl -b -u data.mount`.

### 1.5 No-partition fallback (SPARE CARD, re-flash)

- [ ] Re-flash a card (or use a second spare) with **no** unallocated space and no `FRAMEDATA`.
  Run `./pi/install.sh --owner-key ~/owner.pub --release-dir ~/rel --tag <tag>`.
- [ ] It installs, prints the manual partition steps, and `/data` is a plain directory
  (`findmnt /data` prints nothing). After a reboot `/proc/cmdline` has **no** `overlayroot` and
  the root is writable. The slideshow works.
- [ ] Optional: `--data-partition /dev/<new partition>` on an empty partition formats and uses it;
  on a partition with another filesystem it refuses.

---

## 2. Kiosk, Node and sharp

- [ ] `node --version` prints `v26.x`. `apt-cache policy nodejs | head -5` shows the `node_26.x`
  NodeSource repo. `tailscale version`, `chromium-browser --version` work.
- [ ] `getent passwd frame`; `id frame` includes `netdev`; `sudo -u frame tailscale status` does not
  say "access denied" (operator set).
- [ ] On the LCD, after boot, with nothing touched: Chromium shows the slideshow (or the setup
  screen) full screen. **No** desktop panel, wallpaper, taskbar or mouse cursor appears (move a
  mouse over it: the cursor hides within a second).
- [ ] `sudo -u frame env DISPLAY=:0 xset q | grep -iE 'timeout|DPMS|Monitor'`: screen saver
  `timeout: 0` and DPMS timeouts all 0 (verify the auth works; otherwise read it from a keyboard
  session). Leave the frame an hour and confirm the screen never blanks.
- [ ] `loginctl list-sessions` shows `frame` in an X11 session; `cat /etc/lightdm/lightdm.conf.d/50-photo-frame.conf`
  names `LXDE-pi-x`. `pgrep -a unclutter` and `pgrep -a chromium | head -1` show them running.
- [ ] Kill Chromium (`sudo pkill chromium`): it comes back within about 10 s (`start.sh` loops).
- [ ] Open the admin page from a phone (`http://photoframe.local`) and upload a **large** JPEG
  (more than 3000 px wide). It appears and shows on the frame.
- [ ] `identify -format '%wx%h\n' /data/uploads/<newest file>` (or `file`) reports at most 1920 px
  on the long side. `sharp` runs on the Pi, which proves the arm64 build in the tarball.
- [ ] `ls /data/current/node_modules | head -3` exists and `which npm` is not needed: the
  production tarball runs without running `npm` on the frame.

> **If this fails:** `pi/install.sh` `step_kiosk`; `/home/frame/.config/lxsession/LXDE-pi/autostart`
> (should be one line pointing to `/usr/local/lib/photo-frame/start.sh`); `journalctl -u photo-frame-server -b`;
> `/etc/lightdm/lightdm.conf` (autologin lines).

---

## 3. Tailscale and remote access

- [ ] Starting state: WiFi from Imager is up, Tailscale not logged in. After boot the LCD shows
  "Connect your frame to Tailscale" with a QR code and a URL. (To redo it
  later: `sudo tailscale logout`, then `sudo systemctl restart photo-frame-server` or reboot. The
  screen only appears when the server starts not-yet-ready; after the ready card, a logout alone
  changes nothing on screen.)
- [ ] Operator survives a logout (SPARE PI ONLY): `sudo tailscale logout`, then
  `sudo systemctl restart photo-frame-server`. `tailscale debug prefs | grep -i operator` still
  shows `frame` (verify the key name), `journalctl -u photo-frame-server -b | grep tailscale-operator`
  shows "operator is frame" (the unit's `ExecStartPre` helper re-sets it on every start), and the
  login QR appears on the LCD again within about 30 s.
- [ ] Scan the QR with a phone and sign in to the **brother** tailnet. The screen then shows the
  "You're all set" card (its contents are checked in section 4), and after 60 s (or a tap) the slideshow.
- [ ] The text "Afterwards, share this frame with the person who set it up: Tailscale admin
  console → Machines → this frame → Share." is visible on the Tailscale screen.
- [ ] In the **brother's** admin console (`https://login.tailscale.com/admin/machines`) share the
  machine with the owner's account. The owner accepts the invite in the owner tailnet.
- [ ] From the owner's laptop: `tailscale status` lists the shared machine. `ssh <user>@<tailscale name>`
  logs in with the owner key (plain OpenSSH, key only). `ssh -o PreferredAuthentications=password
  <user>@photoframe.local` is refused.
- [ ] `tailscale debug prefs | grep -i runssh` shows `false` (Tailscale SSH is not in use; verify
  the key name).
- [ ] From the owner's laptop, `http://<tailscale name>` loads the admin page.
- [ ] If either the SSH or the admin page fails over the shared node, write down which, and the
  fallback: invite the owner as a user of the brother's tailnet, or add an ACL granting the owner
  access to the frame's ports 22 and 80. Record it in section 12.

> **If this fails:** the login URL never appears: `journalctl -u photo-frame-server -b | grep -i tailscale`,
> `server/setup/tailscale.ts` (`tailscale up` is run as `frame`),
> `tailscale set --operator=frame` (installer step 3, and `/usr/local/lib/photo-frame/tailscale-operator.sh`
> from `pi/units/tailscale-operator.sh`, run by the unit's `ExecStartPre`), `pi/units/photo-frame-server.service`.
> "Access denied: checkprefs access denied" in the journal means the operator is not set.

---

## 4. WiFi setup hotspot

Re-trigger the setup screen without a handoff (SPARE PI ONLY): connect Ethernet or use a keyboard,
note the saved WiFi's name with `nmcli -t -f NAME,TYPE connection show`, then
`sudo nmcli connection delete "<that name>"` **and** `sudo systemctl restart photo-frame-server`
(or reboot). Deleting the profile alone is not enough: a frame that is already running with photos
stays on the slideshow with the "No WiFi" label for 30 minutes. After the restart the setup phase
starts at "no WiFi" and the hotspot appears about 60 seconds later.

- [ ] The LCD shows "Welcome to your photo frame", the network `PhotoFrame-Setup`, a password
  and a QR code, and "A setup page opens automatically (or open http://10.42.0.1)".
- [ ] `sudo -u frame nmcli device wifi list` and `sudo -u frame nmcli device wifi rescan` work
  without a password prompt (polkit rule `pi/polkit/50-photo-frame-networkmanager.rules`).
- [ ] **iPhone:** scan the QR (or join manually with the on-screen password). The captive-portal
  sheet opens by itself with "Connect your frame to WiFi".
- [ ] **Android:** same; a "Sign in to network" notification opens the page.
- [ ] **Laptop:** the page may not pop up; typing `http://10.42.0.1` into a browser works. Note
  whether it popped up by itself.
- [ ] The password shown on the LCD is accepted at the first try (the hotspot is WPA2). If the
  phone says the network is open, note it.
- [ ] The network list contains the home WiFi. The password field and the "Hidden network" box work.
- [ ] **Wrong password:** pick the home network, type a wrong password, Connect. The phone page
  says "Reconnect your phone to your home WiFi — the frame's screen will tell you if it worked."
  Within about a minute the **frame's screen** shows a red "Something went wrong" banner and the
  `PhotoFrame-Setup` hotspot is back. The previously saved profile (if any) is still listed by
  `nmcli connection show`.
- [ ] **Right password:** submit it. The frame's screen moves on (to the Tailscale screen, or the
  "You're all set" card if Tailscale is logged in). No password appears in
  `journalctl -u photo-frame-server -b`.
- [ ] **Hidden SSID:** hide the SSID in the router (or use a second hidden network), submit it
  with the "Hidden network" box ticked. It joins. Unhide the SSID afterwards.
- [ ] Ready card (`You're all set`): shows `http://photoframe.local`, `http://<LAN IP>` and, if
  Tailscale is up, `http://<tailnet name>`. The QR opens the **LAN IP** page. Tapping the card
  or waiting 60 s goes to the slideshow.

> **If this fails:** `journalctl -u photo-frame-server -b`, `journalctl -b -u NetworkManager`,
> `server/setup/nmcli.ts`, `server/setup/setupService.ts`, polkit: `journalctl -b | grep -i polkit`.
> Captive page not opening: `/etc/NetworkManager/dnsmasq-shared.d/photo-frame-captive.conf`
> must contain `address=/#/10.42.0.1`.

---

## 5. Admin page on port 80

- [ ] From a phone on the same WiFi, `http://photoframe.local` loads the admin page. Also
  `http://<LAN IP>` (read the IP from the ready card or `hostname -I`). Both without `:3000`.
- [ ] `http://photoframe.local:3000` still works.
- [ ] Live updates over port 80: open the admin page on two devices at once, choose a different
  active photo on one, and the frame's slideshow and the other device update without a refresh.
- [ ] While the hotspot is up (re-trigger it as in section 4): `curl -sI http://10.42.0.1/` from a
  laptop joined to the `PhotoFrame-Setup` network redirects to the setup page, while on the Pi `curl -sI http://localhost:3000/` still
  returns `200` and the kiosk keeps running.
- [ ] Port-80 bind fallback (SPARE PI ONLY): `sudo systemctl stop photo-frame-server`, then in a
  second session `sudo python3 -m http.server 80`, then `sudo systemctl start photo-frame-server`.
  `journalctl -u photo-frame-server -b | tail` shows "Could not listen on port 80 ... admin stays
  on port 3000". `curl -s http://localhost:3000/api/setup/state` shows `"adminPort":3000`. Stop the
  python server and `sudo systemctl restart photo-frame-server`: `adminPort` is `80` again.

> **If this fails:** `AmbientCapabilities=CAP_NET_BIND_SERVICE` in
> `pi/units/photo-frame-server.service`; `server/index.ts` (the port-80 listener).

---

## 6. WiFi loss behaviour

- [ ] **Startup grace:** with a saved WiFi, `sudo reboot` and watch the LCD from the first frame
  of the page: the `PhotoFrame-Setup` screen must **not** appear (grace is 60 s).
- [ ] **Short outage (< 30 min), photos present:** switch the router off (or move the frame out of
  range). The slideshow keeps going with a small bottom-right label
  "No WiFi — showing saved photos". Switch the router on: the label disappears within a minute
  and the frame is reachable again.
- [ ] **Reboot the router** (the real-life case) while the frame runs: same result.
- [ ] **Long outage (≥ 30 min):** keep the router off for 35 minutes. The `PhotoFrame-Setup`
  screen and hotspot appear. Switch the router on while the hotspot is up: record whether the
  frame goes back to the slideshow by itself or needs the setup page (note it; the saved profile is
  still used for retries).
- [ ] The banner only shows if the frame was already in the normal state with photos. After
  deleting all photos, a router-off shows the setup screen sooner (expected).

> **If this fails:** `server/setup/stateMachine.ts` (`WIFI_LOSS_MINUTES = 30`),
> `server/setup/setupService.ts` (`DEFAULT_GRACE_MS`).

---

## 7. Updates and rollback

The update check talks to the real public repo `dbanksdesign/rpi-frame`, so every test release
below is a **real public release**. A frame in the field with an update check (every 6 h, 5 min
cache) could see them. Keep the bad release (7.4) up for minutes, not days, and only do this with
nobody's frame on an older version waiting for an update.

### 7.1 First release and install

- [ ] On `main` (after the branch is merged): `git tag v0.1.0 && git push --tags`. The "Release"
  workflow (`.github/workflows/release.yml`, arm64 runner) goes green and the release has
  `frame-v0.1.0.tar.gz` and `frame-v0.1.0.tar.gz.sha256`. The tag must be newer than any version
  the frame already runs.
- [ ] Install a frame from it (section 1.2, offline `--release-dir` or the default
  `./pi/install.sh --owner-key ~/owner.pub` which fetches the latest release). Admin page "Software
  Update" shows "Installed version: v0.1.0".

### 7.2 A normal update

- [ ] Make a trivial change on `main` (for example a version bump in a comment), then
  `git tag v0.1.1 && git push --tags`; wait for the release workflow.
- [ ] On the admin page press **Check for updates**. It shows "Update available: v0.1.0 → v0.1.1".
  (The result may be cached for 5 minutes.)
- [ ] **Double-click** **Update to v0.1.1** (this is the one release available; a second click
  cannot be repeated later). Only one update runs: `systemctl status frame-update` shows one
  unit and the panel shows a single progress sequence; the extra click is ignored or reports an
  update is already running (updater exit 12; verify wording). The panel shows progress ("Downloading…", "Verifying…",
  "Installing…", "Restarting…", "Checking the new version…"), then "Reconnecting…", then a green
  "Updated to v0.1.1". The slideshow pauses about a minute.
- [ ] The **kiosk page reloads itself** (within about a minute) and keeps working with the new
  version. `cat /data/current/VERSION` and `readlink /data/current` show `v0.1.1`.
- [ ] Reload the admin page after the update: it shows no green "Updated to ..." banner (a stale
  status file must not look like a new success), only "Installed version: v0.1.1".
  `cat /data/update-status.json` still holds the old success.
- [ ] While that update runs (prepare a second SSH session before clicking), `ls -l /run/frame-update.lock` exists and `sudo flock -n /run/frame-update.lock true`
  fails.

### 7.3 Sudoers is exactly one command

- [ ] `sudo -u frame sudo -n -l` lists only the `systemd-run --collect --unit=frame-update
  /usr/local/sbin/frame-update v[0-9]*` rule.
- [ ] `sudo -u frame sudo -n /bin/true` **fails** ("a password is required" or similar).
- [ ] `sudo visudo -cf /etc/sudoers.d/photo-frame-update` reports it parses.

### 7.4 A bad release and rollback (throwaway branch)

- [ ] From `main`: `git switch -c throwaway-bad-release`. Make the server exit at startup, for
  example put `process.exit(1);` as the first line of `server/index.ts`. Check
  `npx vitest run` still passes (the release workflow runs it before publishing). If a test
  imports that file, pick another change that makes startup fail and note which.
- [ ] `git commit -am "throwaway: exit at startup"`, `git tag v0.1.2`, `git push origin v0.1.2`.
  Wait for the workflow to publish it.
- [ ] On the frame: **Check for updates**, then **Update to v0.1.2**. After about a minute and a
  half (60 s health-check timeout) the panel shows a red "Update failed": "The new version didn't
  start; restored the previous version".
- [ ] `readlink /data/current` is `releases/v0.1.1` again, the slideshow is back, and
  `journalctl -u frame-update -b --no-pager | tail` shows the rollback. `systemctl --failed` does
  not list `frame-update` (it was started with `--collect`).
- [ ] A later good update still works: tag `v0.1.3` from `main` (trivial change) and update, or at
  least press **Update** on the next trivial release.
- [ ] Clean up: `gh release delete v0.1.2 --cleanup-tag --yes -R dbanksdesign/rpi-frame`;
  `git push origin :refs/tags/v0.1.2` if the tag is left; delete the throwaway branch. **Leave
  the frame on the good version** (`cat /data/current/VERSION` is not `v0.1.2`). If the frame
  was left on a bad version, run `sudo systemd-run --collect --unit=frame-update
  /usr/local/sbin/frame-update v0.1.1` by hand (note: only an upgrade is offered in the UI).

> **If this fails:** `pi/updater/frame-update.sh` (exit codes: 0 ok, 2 refused layout, 10
> download/verify, 11 health failure rolled back, 12 already running); `/data/update-status.json`;
> `journalctl -u frame-update`; `server/update/updateService.ts`; `/etc/sudoers.d/photo-frame-update`.

---

## 8. Power cuts and the watchdog

All SPARE PI ONLY. Overlay on, frame in READY.

- [ ] **During uploads:** start an upload of 20 large photos from the phone and pull the plug
  mid-upload. Repeat **10 times** over the session. Every time the Pi boots, the slideshow
  returns, earlier photos are intact (`ls /data/uploads | wc -l` never drops), and
  `sudo journalctl -b -p err --no-pager | head` shows nothing alarming. `/data` is not remounted
  read-only: `findmnt -no OPTIONS /data` still has `rw`; check `sudo dmesg | grep -i ext4`.
- [ ] **During an update:** with a release ready (publish another trivial release first, the next unused tag after 7.4, for example `v0.1.4`, because 7.2 consumed `v0.1.1`), press Update and pull the plug during
  "Installing…" and again during "Restarting…". The card boots, the slideshow comes back,
  `readlink /data/current` points at a complete release (old or new), and a retry of the update
  succeeds. Remember a half-finished update leaves `/data/update-status.json` as "running":
  the admin page should treat it as stale after 15 minutes.
- [ ] `systemctl show -p RuntimeWatchdogUSec` prints `RuntimeWatchdogUSec=15s`.
- [ ] **Forced hang (SPARE PI ONLY):** `echo c | sudo tee /proc/sysrq-trigger` (needs
  `sudo sysctl kernel.sysrq=1` first; verify). The Pi reboots by itself within about 15 to 30 s
  and the frame comes back with no manual action.

> **If this fails:** `/etc/systemd/system.conf.d/watchdog.conf` (installed from `pi/watchdog.conf`;
> `sudo systemctl daemon-reexec` applies it), `journalctl -b -1` for the previous boot.

---

## 9. Power supply, soak and memory

This is the question that started the project: does the frame run without under-voltage on the
LCD's shared 18 W PD supply?

- [ ] `systemctl is-active power-log` is `active`. `tail -3 /data/log/power-log.csv` has columns
  `time,uptime_s,ext5v_v,throttled,temp_c,mem_avail_mb`, one row every 10 s.
- [ ] Record `vcgencmd get_config usb_max_current_enable` and `sudo dmesg | grep -iE 'volt|usb|throttl'`.
- [ ] Setup A: the Pi powered from the LCD's shared 18 W PD supply, Chromium on the slideshow,
  a photo transition running, WiFi up. Run **at least 24 h**. Then
  `awk -F, 'NR>1 && $3 < 4.75' /data/log/power-log.csv | wc -l` is `0` (ext5v_v never below
  4.75 V) and `awk -F, 'NR>1 && $4 != "0x0"' /data/log/power-log.csv | wc -l` is `0`
  (no throttled flags). Record the minimum `ext5v_v`.
- [ ] Setup B: the same, with the Pi on its own official 27 W supply. Record the same numbers.
- [ ] Leave the chosen setup for **3 days** before handing the frame over. No under-voltage,
  no reboots (`uptime`), no blank screen.
- [ ] If the screen goes dark: note the time. Without touching anything, SSH in and run
  `uptime`, `sudo -u frame env DISPLAY=:0 xset q | grep -i monitor` and
  `tail -20 /data/log/power-log.csv`. A normal `uptime` and "Monitor is On" mean the Pi is fine
  and the problem is the LCD or its supply. A short `uptime` means the Pi rebooted (check the
  last `ext5v_v` and `throttled` before the gap).
- [ ] Cold start: from plug-in to the first slideshow image takes ______ seconds (stopwatch).
- [ ] After 24 h: `free -m` shows `available` comfortably above 500 MB (with the overlay on,
  Chromium's cache sits in RAM). `mem_avail_mb` in the log does not trend down all day.

---

## 10. End-user run-through

Do it exactly as the brother will, from the unboxed state, ideally with someone else doing the
tapping. Start from a handed-off frame (section 11) if you can. Time each step and write down every
moment the person hesitated or asked a question.

- [ ] Plug in. The setup screen appears in about ______ s.
- [ ] Join `PhotoFrame-Setup` by scanning the QR; the setup page opens by itself.
- [ ] Choose home WiFi, enter password, Connect. The frame's screen reacts.
- [ ] Scan the Tailscale QR with his phone and sign in.
- [ ] Share the frame with the owner (admin console → Machines → this frame → Share). Note how
  long this took and what was unclear.
- [ ] The "You're all set" card appears. Open `photoframe.local` on his phone (or scan the QR).
- [ ] Upload photos; they show on the frame.
- [ ] Press **Update** when a newer release exists.
- [ ] Total time: ______ minutes. Confusing moments: ____________________________

---

## 11. Handoff

SPARE PI ONLY (this wipes it). Run at a keyboard or over SSH on the **LAN**, never over Tailscale.

- [ ] **First** copy off the soak data, because the handoff deletes the power log, the update
  status and the journal: `cp /data/log/power-log.csv ~/power-log-<date>.csv` (and `scp` it away),
  then fill in section 12.

- [ ] `sudo ./pi/prepare-handoff.sh --dry-run --clear-photos` lists the plan and changes nothing.
- [ ] `sudo ./pi/prepare-handoff.sh --clear-photos` (or `--keep-photos`). Type `handoff` when
  asked. **Do not press Ctrl-C after confirming**: it is not ignored, and stopping the script
  half-way leaves the frame half-wiped. Watch it finish and power off. Output is also in
  `/run/prepare-handoff.log` while the Pi is up. Unplug only after the green LED stops flashing.
- [ ] Boot the Pi again. It shows the WiFi setup screen, `PhotoFrame-Setup`, after about a minute.
- [ ] Log in over Ethernet or the keyboard and check (as appropriate for the mode):
  `nmcli connection show` has no WiFi profile, `tailscale status` says logged out, `sudo ls /data/uploads`
  is empty (for `--clear-photos`) or still has the photos (for `--keep-photos`),
  `/data/update-status.json` is gone, `sudo journalctl --disk-usage` is small.
- [ ] The owner's key is still there: `grep -c . /home/<user>/.ssh/authorized_keys` is at least 1, and
  the installed release still runs (`readlink /data/current`).
- [ ] Delete the machine from the Tailscale admin console
  (`https://login.tailscale.com/admin/machines`). Logging out does not always remove it.
- [ ] The photo-frame server still starts after the wipe: join WiFi through the setup page, the
  slideshow (empty or with the kept photos) comes up.
- [ ] **Tailscale login after the handoff** (this is where the operator setting matters): boot the
  handed-off frame on a **different** WiFi than the one used before (a phone hotspot works), join
  it through the setup page, and confirm the "Connect your frame to Tailscale" QR code **actually
  appears** (not stuck on "Getting a sign-in link…" or "Could not get a Tailscale login link
  yet") and that signing in with it works and reaches the "You're all set" card. The log of the
  handoff (`/run/prepare-handoff.log`, before the power-off) contains the `tailscale set
  --operator=frame` or `tailscale-operator.sh` line in step 5.

---

## 12. Record results

| Item | Value |
|---|---|
| Date | |
| Pi OS version (`cat /etc/os-release`, `uname -a`) | |
| Node version (`node --version`) | |
| Installed release tag(s) | |
| Photos / card size | |
| LCD and power supply used | |

| Section | Pass / Fail | Notes |
|---|---|---|
| 1 Overlay and data partition | | |
| 2 Kiosk, Node and sharp | | |
| 3 Tailscale and remote access | | |
| 4 WiFi setup hotspot | | |
| 5 Admin on port 80 | | |
| 6 WiFi loss | | |
| 7 Updates and rollback | | |
| 8 Power cuts and watchdog | | |
| 9 Power supply and soak | | |
| 10 End-user run-through | | |
| 11 Handoff | | |

Minimum `ext5v_v`: ______ V on the shared 18 W supply, ______ V on the 27 W supply.
Open problems and anything marked "verify" that turned out different:
