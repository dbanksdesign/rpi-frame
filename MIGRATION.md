# Migration Guide: Browser to Native Display

## Overview

This guide helps you migrate from the old browser-based display to the new native display system.

## What's Different?

**Before:**
- Chromium browser running in kiosk mode on Pi
- Complex autostart configuration
- Issues with display power control
- Higher memory usage

**After:**
- Native image display using `feh`
- Simple systemd services
- Reliable display control
- Lower resource usage
- Web interface still available from other devices

## Migration Steps

### 1. Disable Old Browser Autostart (if configured)

If you previously set up browser autostart:

```bash
# Remove from LXDE autostart
nano ~/.config/lxsession/LXDE-pi/autostart
# Delete lines related to chromium-browser, xset, unclutter

# If you created a startup script, you can remove it
rm ~/start-photo-frame.sh  # or whatever you named it

# If you have the old systemd service
sudo systemctl stop photo-frame.service
sudo systemctl disable photo-frame.service
sudo rm /etc/systemd/system/photo-frame.service
```

### 2. Update Code

```bash
cd ~/rpi-frame  # or wherever your project is
git pull  # if using git
# or download the new files
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Installation Script

```bash
./install-display.sh
```

This will:
- Install `feh`
- Rebuild the application
- Create new systemd services
- Start everything automatically

### 5. Verify Installation

```bash
# Check services are running
sudo systemctl status photo-frame-server.service
sudo systemctl status photo-frame-display.service

# View logs if needed
sudo journalctl -u photo-frame-display.service -f
```

### 6. Reboot (Optional)

```bash
sudo reboot
```

After reboot, the photo frame should start automatically without browser.

## Troubleshooting

**Old browser still opens on boot?**
- Check `~/.config/lxsession/LXDE-pi/autostart`
- Make sure you removed the chromium-browser lines

**Display not showing images?**
```bash
# Check logs
sudo journalctl -u photo-frame-display.service -n 50

# Restart display
sudo systemctl restart photo-frame-display.service
```

**Want to keep using the browser method?**

You can still access the web interface from the Pi:
1. Open Chromium on the Pi
2. Navigate to `http://localhost:3000/slideshow`
3. Press F11 for fullscreen

But for best results, we recommend using the native display.

## Benefits You'll Notice

✅ **Faster Boot**: No waiting for browser to start  
✅ **More Reliable**: No browser crashes or hangs  
✅ **Better Display Control**: On/off toggle works reliably  
✅ **Lower Memory**: Less resource usage  
✅ **Simpler Configuration**: No complex autostart scripts  

## Rollback (if needed)

If you need to go back to the browser method:

```bash
# Stop new services
sudo systemctl stop photo-frame-display.service
sudo systemctl disable photo-frame-display.service

# Restore old setup
# (follow your old installation instructions)
```

## Questions?

Check the main README.md for detailed documentation.

