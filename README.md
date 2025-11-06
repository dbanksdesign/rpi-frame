# Raspberry Pi Digital Photo Frame

A modern web application that turns your Raspberry Pi into a beautiful digital photo frame. Manage your photos from any device on your local network!

## Features

- 📸 **Slideshow View**: Automatic photo slideshow perfect for wall displays
- 🖼️ **Photo Management**: Upload, show/hide, and delete photos from any device
- 🌐 **Network Accessible**: Control from your laptop, phone, or tablet
- 💾 **Local Storage**: All photos stored directly on your Raspberry Pi
- 📱 **Responsive Design**: Works great on desktop and mobile devices
- ⚡ **Modern Tech Stack**: Built with TypeScript, React, and Express

## Prerequisites

- Raspberry Pi (any model with network connectivity)
- Node.js 18+ and npm installed
- Display connected to your Raspberry Pi
- Chromium browser (for kiosk mode display)

### Installing Prerequisites on Raspberry Pi

If you need to install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

If you need to install Chromium:
```bash
sudo apt update
sudo apt install chromium-browser -y
```

## Installation

1. **Clone or download this project to your Raspberry Pi**

2. **Install dependencies:**
```bash
npm install
```

3. **Build the application:**
```bash
npm run build
```

## Running the Application

### Development Mode (for testing)

Run both the frontend and backend in development mode:

```bash
npm run dev
```

This will start:
- Backend API server on `http://localhost:3000`
- Frontend development server on `http://localhost:5173`

### Production Mode (recommended for Raspberry Pi)

1. **Build the application** (if you haven't already):
```bash
npm run build
```

2. **Start the server:**
```bash
npm start
```

The application will be available at `http://0.0.0.0:3000`

3. **Access from other devices:**

Find your Raspberry Pi's IP address:
```bash
hostname -I
```

Then open a browser on any device on your local network and navigate to:
```
http://YOUR_PI_IP_ADDRESS:3000
```

For example: `http://192.168.1.100:3000`

## Using the Application

### Direct URLs

The application has two separate views accessible via direct URLs:

- **Slideshow View**: `http://YOUR_PI_IP:3000/slideshow`
  - Full-screen photo slideshow with no navigation bar
  - Perfect for the wall display
  - Auto-updates when photos are added/removed
  - Press ESC to return to manage view (if needed)

- **Manage View**: `http://YOUR_PI_IP:3000/manage`
  - Upload, show/hide, and delete photos
  - Access from your phone, laptop, or any device
  - Shows notifications when changes are made

- **Root URL**: `http://YOUR_PI_IP:3000/`
  - Redirects to `/manage` by default

### For the Wall Display

**Option 1: Direct slideshow URL (Recommended)**
- Navigate directly to `http://localhost:3000/slideshow`
- No navigation bar, pure full-screen slideshow
- Perfect for kiosk mode

**Option 2: Manual navigation**
1. Go to `http://localhost:3000`
2. Click **"Slideshow"** in the navigation
3. Press F11 to enter fullscreen mode

### Managing Photos

1. Open `http://YOUR_PI_IP_ADDRESS:3000/manage` on your phone or laptop
2. Upload new photos using the **"+ Upload Photos"** button
3. Show/hide photos from the slideshow using the eye icon
4. Delete unwanted photos with the delete button
5. The slideshow on the Pi will auto-update within 5 seconds!

## Auto-Start on Boot (Optional)

To make the application start automatically when your Raspberry Pi boots:

1. **First, find the full path to Node.js:**
```bash
which node
```
This will output something like `/usr/bin/node` or `/home/YOUR_USERNAME/.nvm/versions/node/v18.x.x/bin/node`

2. **Create a systemd service:**
```bash
sudo nano /etc/systemd/system/photo-frame.service
```

3. **Add the following content** (replace `YOUR_USERNAME`, `NODE_PATH`, and project path as needed):
```ini
[Unit]
Description=Digital Photo Frame
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/rpi-frame
ExecStart=/usr/bin/node /home/YOUR_USERNAME/rpi-frame/dist/server/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

**Important Notes:**
- Replace `YOUR_USERNAME` with your actual username (run `whoami` to find it)
- Replace `/usr/bin/node` with the path from step 1
- Replace `/home/YOUR_USERNAME/rpi-frame` with your actual project path
- Make sure you've run `npm run build` before starting the service!

4. **Reload systemd, enable and start the service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable photo-frame.service
sudo systemctl start photo-frame.service
```

5. **Check status:**
```bash
sudo systemctl status photo-frame.service
```

If you see errors, check the logs:
```bash
sudo journalctl -u photo-frame.service -n 50 -f
```

6. **To stop or restart the service:**
```bash
sudo systemctl stop photo-frame.service
sudo systemctl restart photo-frame.service
```

## Auto-Start Browser in Kiosk Mode (Optional)

To automatically open the slideshow in fullscreen when the Pi boots:

### Method 1: Using autostart (Raspberry Pi Desktop)

1. **First, check which desktop environment you're using:**
```bash
echo $DESKTOP_SESSION
```

2. **Create/edit the autostart file:**

For LXDE (most Raspberry Pi OS):
```bash
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```

For other desktop environments, the path might be different:
- LXDE: `~/.config/lxsession/LXDE/autostart`
- Wayfire: `~/.config/wayfire.ini`

3. **Add these lines to the autostart file:**
```
@xset s off
@xset -dpms
@xset s noblank
@sleep 10
@chromium-browser --kiosk --start-fullscreen --app=http://localhost:3000/slideshow --noerrdialogs --disable-infobars --no-first-run --check-for-update-interval=31536000
```

**What these do:**
- `xset` commands: Disable screen blanking and power saving
- `sleep 10`: Wait 10 seconds for the server to fully start
- `--kiosk`: Full screen mode without browser UI
- `--noerrdialogs`: Suppress error dialogs
- `--disable-infobars`: Hide info bars
- `--no-first-run`: Skip first-run prompts

4. **Verify the browser command works:**
```bash
chromium-browser --version
```

If that doesn't work, try:
```bash
chromium --version
```

Use whichever one works in your autostart file.

5. **Reboot to test:**
```bash
sudo reboot
```

### Method 2: Using a startup script (Alternative)

If Method 1 doesn't work, try this approach:

1. **Create a startup script:**
```bash
nano ~/start-photo-frame.sh
```

2. **Add this content:**
```bash
#!/bin/bash

# Wait for the desktop to load
sleep 15

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Wait for server to be ready
while ! curl -s http://localhost:3000 > /dev/null; do
    echo "Waiting for server..."
    sleep 2
done

# Launch browser in kiosk mode directly to slideshow
DISPLAY=:0 chromium-browser --kiosk --start-fullscreen \
  --app=http://localhost:3000/slideshow \
  --noerrdialogs --disable-infobars \
  --no-first-run --disable-translate \
  --check-for-update-interval=31536000 &
```

3. **Make it executable:**
```bash
chmod +x ~/start-photo-frame.sh
```

4. **Add to autostart:**
```bash
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```

Add this line:
```
@/home/YOUR_USERNAME/start-photo-frame.sh
```
(Replace `YOUR_USERNAME` with your actual username)

5. **Reboot to test:**
```bash
sudo reboot
```

### Troubleshooting:

**Browser doesn't open:**
- Check if the autostart file is in the right location
- Try running the browser command manually to test it
- Check if Chromium is installed: `sudo apt install chromium-browser`
- Increase the sleep time in case the server needs longer to start

**Browser opens but shows error:**
- Make sure the service started: `sudo systemctl status photo-frame.service`
- Check if the server is accessible: `curl http://localhost:3000`
- Look at browser console with F12

**Screen blanks after a while:**
- Check if your Pi has additional power-saving settings
- Add to `/etc/lightdm/lightdm.conf` under `[Seat:*]`:
  ```
  xserver-command=X -s 0 -dpms
  ```

**To manually exit kiosk mode on the Pi:**
- Press `Alt+F4` to close the browser
- Press `Ctrl+W` to close the current tab
- Press `F11` to exit fullscreen

## Project Structure

```
rpi-frame/
├── server/              # Backend Express API
│   ├── index.ts         # Server entry point
│   ├── routes/          # API routes
│   └── utils/           # Utilities (image store, filesystem)
├── src/                 # Frontend React application
│   ├── components/      # React components
│   │   ├── Slideshow    # Slideshow view
│   │   └── Admin        # Photo management
│   ├── App.tsx          # Main app component
│   └── main.tsx         # Entry point
├── uploads/             # Photo storage (created automatically)
├── data/                # Image metadata (created automatically)
└── dist/                # Compiled production files
```

## Troubleshooting

**Cannot access from other devices:**
- Make sure your Pi and other devices are on the same network
- Check if a firewall is blocking port 3000
- Try: `sudo ufw allow 3000`

**Photos not uploading:**
- Check available disk space: `df -h`
- Ensure the `uploads` directory has write permissions

**Application not starting:**
- Check if Node.js is installed: `node --version`
- Install if needed: `curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs`

## Customization

### Change slideshow timing:

Edit `src/components/Slideshow.tsx` and modify:
```typescript
const TRANSITION_DURATION = 5000 // Change to desired milliseconds
```

### Change upload file size limit:

Edit `server/routes/api.ts` and modify:
```typescript
limits: { fileSize: 10 * 1024 * 1024 } // Change to desired bytes
```

## License

MIT License - Feel free to use and modify as needed!

## Support

For issues or questions, please check the troubleshooting section above or review the code comments for guidance.

Enjoy your digital photo frame! 📸

