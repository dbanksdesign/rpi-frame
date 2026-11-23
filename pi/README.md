# Building a photo frame

`pi/install.sh` turns stock **Raspberry Pi OS (64-bit, with desktop, bookworm)** on a Raspberry
Pi 5 into a plug-and-play frame. It is idempotent: re-run it to repair or upgrade a frame.

## What it does (in this order)

1. **Preflight**: checks for bookworm, arm64, systemd, an active NetworkManager, the desktop
   image (raspi-config, LightDM, the `LXDE-pi-x` session), not running in a container, and that
   the read-only overlay is off.
2. **Packages**: Node 20 from NodeSource's `node_20.x` repo (Debian 12 only has Node 18; the
   release workflow builds with Node 20), Chromium, unclutter, Avahi, OpenSSH, Tailscale (from
   its official bookworm apt repo), plus small tools. Both repo signing keys are downloaded over
   HTTPS and checked against a pinned fingerprint. No `curl | sh`.
3. **Users**: a `frame` user (locked password, autologin only) in `video audio input render
   netdev`, and `tailscale set --operator=frame` so the server can run `tailscale up` itself.
4. **Data partition**: `/data` comes from the ext4 partition labelled `FRAMEDATA` (see below).
5. **Data layout**: `/data`, `/data/releases`, `/data/system`, `/data/log` are root-owned.
   `frame` owns only `/data/uploads` and `/data/data`. `/data/current` and
   `/data/update-status.json` are written by the updater (root).
6. **Persistence**: bind mounts from `/data/system` for NetworkManager profiles and
   `/var/lib/tailscale`, plus `/etc/fake-hwclock.data`, so WiFi, Tailscale and the clock
   survive the read-only root. Existing profiles are moved to `/data`: copied, then each
   original is deleted from root once its copy is verified identical. The mounts are ordered
   before NetworkManager and tailscaled.
7. **Updater**: `/usr/local/sbin/frame-update`, plus a sudoers rule that lets `frame` run only
   `systemd-run --collect --unit=frame-update /usr/local/sbin/frame-update v…`.
8. **systemd units** (`pi/units/`): `photo-frame-server.service` and `power-log.service`, plus
   the hardware watchdog config.
9. **NetworkManager**: captive-portal DNS for the setup hotspot, and a polkit rule
   (`pi/polkit/`) that lets `frame` scan, connect and run the hotspot from a service.
10. **SSH**: the owner's public key is added for the user running the installer. Then password
    and root login are switched off. That last part is skipped if the key could not be installed.
11. **Kiosk**: X11 session, LightDM autologin of `frame`, and `start.sh` from
    `~frame/.config/lxsession/LXDE-pi/autostart`.
12. **Hostname**: `<name>`, reachable as `<name>.local` via Avahi.
13. **First release**: runs `frame-update <tag>`, which downloads the release, starts the server
    and health-checks it. This is the installer's smoke test.
14. **Overlay filesystem, last**: a read-only root (and boot partition), so pulling the plug
    can't corrupt the OS. It is enabled only when `/data` is a separate partition, as
    `overlayroot=tmpfs:recurse=0` so that only `/` is overlaid and `/data` stays writable.

It never reboots by itself.

## Flags

```
./pi/install.sh --owner-key <file-or-key> [--name photoframe]
                [--data-partition auto|<device>|none]
                [--tag vX.Y.Z] [--release-dir <dir> --tag vX.Y.Z]
                [--writable] [--dry-run]
```

- `--owner-key`: **required**. The owner's SSH *public* key, as a `.pub` file or the key
  line. Private keys are refused.
- `--name`: hostname, `^[a-z][a-z0-9-]{0,30}$` and not ending in `-`. Default `photoframe`.
- `--data-partition`:
  - `auto` (default): use the `FRAMEDATA` partition, or create one in at least 2 GiB of
    unallocated space after the root partition.
  - `<device>`: use that partition. An ext4 partition is only relabelled; an empty one is
    formatted. Anything else is refused.
  - `none`: `/data` is a plain directory and the overlay is **not** enabled.
- `--tag`: the release to install. Default: the latest published release.
- `--release-dir`: install from local files instead of GitHub. The directory holds
  `frame-<tag>.tar.gz` and `.sha256` (from `scripts/make-release.sh`), either directly or in a
  `<tag>/` subdirectory.
- `--writable`: maintenance mode. Turns the overlay off (it takes effect after a reboot).
- `--dry-run`: prints every step, command and file (with owner and mode). It changes nothing
  and needs no root.

Run it as your normal sudo-capable user (or `sudo ./pi/install.sh`). It refuses a root login
without `$SUDO_USER`, because the owner key must go to a real login user.

## Building a frame (owner)

1. Flash **Raspberry Pi OS (64-bit)** (with desktop) using Raspberry Pi Imager. Set a user and
   your WiFi in Imager's settings. You don't need to enable SSH there: the installer sets it up.
   On the first boot the OS grows the root partition to fill the card, so add the data partition
   afterwards (next section).
2. Create the `FRAMEDATA` partition (next section).
3. Boot, open a terminal (or SSH on the LAN), then:
   ```
   git clone https://github.com/dbanksdesign/rpi-frame && cd rpi-frame
   ./pi/install.sh --owner-key ~/owner.pub --name photoframe --dry-run   # review
   ./pi/install.sh --owner-key ~/owner.pub --name photoframe
   ```
   Run it from the LAN, not over Tailscale: the first run restarts `tailscaled`.
4. **Before handing it over**, remove your own traces:
   - **WiFi:** `nmcli -t -f NAME,TYPE connection show`, then `sudo nmcli connection delete '<name>'`.
   - **Tailscale:** `sudo tailscale logout`, if you ever logged the frame into your own account.
   - **Test photos:** delete them on the admin page. They are stored in `/data/uploads`.

   These deletions are permanent even with the overlay on. On the first install the installer
   moves the existing profiles and Tailscale state to `/data`, then deletes the originals from
   the root filesystem. It deletes each original only once an identical copy is on `/data`. If
   it keeps one (no identical copy), it prints a WARNING naming the file: delete that file by
   hand.
5. `sudo reboot`.

### One-time manual step: the FRAMEDATA partition

The overlay needs `/data` on its own partition, and Pi OS fills the card on first boot. Pick one:

- **GParted**: put the card in another Linux machine. Shrink the root (ext4) partition so that at
  least 2 GiB (ideally most of the card, for photos) is unallocated after it. Either create an
  ext4 partition there labelled `FRAMEDATA`, or leave the space unallocated and let
  `--data-partition auto` create it.
- **CLI** (card as `/dev/sdX` on another machine): `e2fsck -f /dev/sdX2`,
  `resize2fs /dev/sdX2 16G`, `parted /dev/sdX resizepart 2 17GiB`, create partition 3 in the
  free space, then `mkfs.ext4 -L FRAMEDATA /dev/sdX3`.

Without a partition, the installer still works: `/data` becomes a plain directory, the overlay
stays off, and it prints these steps. If `/data` was a plain directory before, the installer
refuses to mount a new partition over it. Move it aside first (`sudo mv /data /data.old`),
re-run, then copy `uploads/` and `data/` back.

## First boot (the brother)

Plug it in. The screen shows "join WiFi `PhotoFrame-Setup`" with a QR code and password. On his
phone the setup page opens, he picks his WiFi and the frame's screen says whether it worked.
Next the screen shows a Tailscale login QR. He signs in with his account and shares the machine
with the owner. Then the slideshow starts, and the admin page is at
`http://<name>.local:3000/`. The owner can now reach it over Tailscale (`ssh <user>@<tailscale
name>` with the owner key, and the admin page).

## Publishing a release

```
git tag vX.Y.Z && git push --tags
```

The release workflow builds `frame-vX.Y.Z.tar.gz` + `.sha256` and attaches them to the GitHub
release. The admin page's Update button (and a fresh install) then picks it up.

## Maintaining a frame

```
./pi/install.sh --owner-key ~/owner.pub --writable     # turns the overlay off
sudo reboot
# ... make changes (apt upgrade, edit config, re-run install.sh to repair) ...
./pi/install.sh --owner-key ~/owner.pub                # turns the overlay back on (last step)
sudo reboot
```

If the overlay is still on, a normal run refuses, because its changes would be lost at the next
reboot. With `--writable` it only turns the overlay off; reboot and re-run. A release that needs
a new system package also needs `install.sh` to be re-run.

## Tests

`npm run test:install` (`pi/test/install-dry-run.test.sh`) is offline and needs no root. It checks
the dry-run plan and order, argument validation, the sudoers text (with `visudo -cf` when
installed), the partition planner, the unit files (with `systemd-analyze verify` when installed)
and the polkit rule.

## Not verified on real hardware

These were checked offline (package indexes, `raspi-config` source, containers), but not yet on a
real Pi 5. Run through them on the test Pi:

- **First: `/data` must stay writable with the overlay on.** With the overlay enabled, write a
  file to `/data` and one to `/etc/NetworkManager/system-connections`, reboot, and confirm both
  are still there. Also check that `/boot/firmware/cmdline.txt` starts with
  `overlayroot=tmpfs:recurse=0` and that `findmnt /data` shows the ext4 partition (rw), not an
  overlay.
  - Why it matters: overlayroot defaults to `recurse=1`, which overlays every fstab mount. That
    would put photos, WiFi and Tailscale state in RAM.
  - What the installer does: it rewrites raspi-config's plain `overlayroot=tmpfs` to the
    `recurse=0` form, and `--writable` strips every form of the token. Both behaviours were
    checked against the overlayroot and raspi-config scripts, not on a device.
  - Also confirm `--writable` plus a reboot really gives a writable root.
- Boot ordering: the bind mounts carry `x-systemd.before=NetworkManager.service` and
  `x-systemd.before=tailscaled.service`. The generator output was checked in a container. Still
  to check: after a power cut, NetworkManager and tailscaled come up with the `/data` copies.
- Step 1 preflight on a real Pi (`systemd-detect-virt`, the os-release values).
- Step 2: the full apt run on Pi OS, including `chromium` providing `chromium-browser` (it does
  according to the Raspberry Pi archive's file index), and installing `overlayroot`.
- Step 3: `tailscale set --operator=frame`, and `tailscale up` run by `frame` from the service.
- Step 4: creating a partition on the live boot card (`sfdisk --append --no-reread` on a disk
  that is in use, then `partx --add`). This was tested only on image files and loop devices.
- Step 6: the bind mounts at boot (ordering, `nofail`), NetworkManager picking up profiles after
  `nmcli connection reload`, and the fake-hwclock `RequiresMountsFor=/data` drop-in.
- Step 7: the server's update button working end to end through sudo and systemd-run.
- Step 8: the server unit with `ProtectHome=yes` and `PrivateTmp=yes`, binding port 80 through
  `AmbientCapabilities`, and the watchdog after `daemon-reexec`.
- Step 9: the polkit rule letting the service scan, connect and start the hotspot, and the
  `address=/#/10.42.0.1` captive DNS making phones open the portal.
- Step 10: key-only SSH over a Tailscale node shared between tailnets.
- Step 11: `raspi-config nonint do_wayland W1` and LightDM autologin of `frame` into
  `LXDE-pi-x`. The installer also comments out `autologin-user=` in `lightdm.conf`, in case
  that file overrides the drop-in. The user `autostart` file replacing the system one (so no
  panel) is also unchecked.
- Step 14: `raspi-config nonint enable_overlayfs` / `enable_bootro` / `disable_overlayfs` /
  `disable_bootro` on a Pi 5 (initramfs-based overlayroot), and surviving a power cut.
