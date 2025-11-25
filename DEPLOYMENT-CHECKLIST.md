# Deployment Checklist for Raspberry Pi

Use this checklist when setting up the photo frame on your Raspberry Pi.

## Pre-Installation

- [ ] Raspberry Pi is set up with Raspberry Pi OS
- [ ] Pi is connected to your network (WiFi or Ethernet)
- [ ] Display is connected via HDMI
- [ ] You can SSH into the Pi (or access terminal directly)
- [ ] Node.js 18+ is installed: `node --version`
  - If not: `curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs`

## Transfer Files

- [ ] Project files copied to Pi (e.g., in `~/rpi-frame`)
- [ ] Navigate to project directory: `cd ~/rpi-frame`

## Installation

- [ ] Run: `npm install`
- [ ] Run: `./install-display.sh`
- [ ] Check for any error messages during installation
- [ ] Verify services are running:
  - [ ] `sudo systemctl status photo-frame-server.service`
  - [ ] `sudo systemctl status photo-frame-display.service`

## Testing

- [ ] Note your Pi's IP address: `hostname -I`
- [ ] From another device, open: `http://YOUR_PI_IP:3000`
- [ ] Upload a test photo
- [ ] Verify it appears on the Pi's display within 1-2 seconds
- [ ] Test display on/off toggle from web interface
- [ ] Test slideshow timing adjustment

## Verify Auto-Start

- [ ] Reboot the Pi: `sudo reboot`
- [ ] Wait for Pi to boot (~30-60 seconds)
- [ ] Check if photo frame started automatically
- [ ] Verify services auto-started:
  - [ ] `sudo systemctl is-enabled photo-frame-server.service`
  - [ ] `sudo systemctl is-enabled photo-frame-display.service`

## Optional Configuration

- [ ] Adjust slideshow timing from web interface
- [ ] Create photo collections
- [ ] Set up static IP for your Pi (recommended)
- [ ] Add bookmark on your phone/laptop for easy access
- [ ] Consider setting up firewall rules if needed

## Troubleshooting (if needed)

If something doesn't work:

- [ ] Check server logs: `sudo journalctl -u photo-frame-server.service -n 50`
- [ ] Check display logs: `sudo journalctl -u photo-frame-display.service -n 50`
- [ ] Verify feh is installed: `which feh`
- [ ] Verify display is detected: `DISPLAY=:0 xset q`
- [ ] Restart services:
  ```bash
  sudo systemctl restart photo-frame-server.service
  sudo systemctl restart photo-frame-display.service
  ```

## Post-Installation

- [ ] Upload your photo collection
- [ ] Set preferred slideshow duration
- [ ] Test remote access from all devices you'll use
- [ ] Document your Pi's IP address for future reference
- [ ] Consider adding the web interface to home screen on mobile

## Notes

Write any important information here:
- Pi IP Address: _______________
- Pi Username: _______________
- Project Location: _______________
- Any custom configurations: _______________

---

## Success! 🎉

Once all items are checked, your photo frame is ready to use!

**Remember:**
- Access web interface at: `http://YOUR_PI_IP:3000`
- View logs: `sudo journalctl -u photo-frame-display.service -f`
- Restart display: `sudo systemctl restart photo-frame-display.service`

