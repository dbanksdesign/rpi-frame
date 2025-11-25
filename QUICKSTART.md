# Quick Start Guide - Native Display Mode

## What Changed?

Your photo frame now displays images **directly** on the Raspberry Pi without using a browser. You can still manage photos from any device on your network via the web interface.

## Installation

1. **Clone/download project to your Pi:**
```bash
cd ~
git clone <your-repo-url> rpi-frame
cd rpi-frame
```

2. **Install dependencies:**
```bash
npm install
```

3. **Run installation script:**
```bash
./install-display.sh
```

That's it! Your photo frame is now running.

## Quick Commands

```bash
# View logs
sudo journalctl -u photo-frame-display.service -f

# Restart display
sudo systemctl restart photo-frame-display.service

# Check status
sudo systemctl status photo-frame-display.service
sudo systemctl status photo-frame-server.service
```

## Access from Phone/Laptop

1. Find Pi's IP address:
```bash
hostname -I
```

2. Open browser on any device:
```
http://YOUR_PI_IP:3000
```

3. Upload and manage photos!

## Key Benefits

✅ No browser startup issues  
✅ No Chromium configuration needed  
✅ Display turns on/off reliably  
✅ Faster startup  
✅ Lower memory usage  
✅ Still have full web interface from other devices

## Troubleshooting

**Display not showing images?**
```bash
# Check logs
sudo journalctl -u photo-frame-display.service -n 50

# Restart display service
sudo systemctl restart photo-frame-display.service
```

**Can't access web interface?**
```bash
# Check server is running
sudo systemctl status photo-frame-server.service

# Check firewall
sudo ufw allow 3000
```

**Want to stop/start?**
```bash
# Stop everything
sudo systemctl stop photo-frame-server.service photo-frame-display.service

# Start everything
sudo systemctl start photo-frame-server.service photo-frame-display.service
```

