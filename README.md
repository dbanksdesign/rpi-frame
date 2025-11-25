# Raspberry Pi Digital Photo Frame

A modern digital photo frame application for Raspberry Pi. Display images natively without a browser, while managing your photos from any device on your local network!

## Features

- 📸 **Native Display**: Images displayed directly on the Pi using `feh` (no browser needed!)
- 🖼️ **Photo Management**: Upload, show/hide, and delete photos from any device
- 🌐 **Network Accessible**: Control from your laptop, phone, or tablet via web interface
- 💾 **Local Storage**: All photos stored directly on your Raspberry Pi
- 📱 **Responsive Web UI**: Manage photos from desktop or mobile devices
- ⚡ **Modern Tech Stack**: Built with TypeScript, React, and Express
- 🔌 **Display Control**: Turn display on/off remotely from the web interface
- ⏱️ **Customizable Timing**: Adjust slideshow duration from the web interface

## Prerequisites

- Raspberry Pi (any model with network connectivity and display output)
- Node.js 18+ and npm installed
- Display connected to your Raspberry Pi (HDMI)
- `feh` image viewer (installed automatically by setup script)

### Installing Prerequisites on Raspberry Pi

If you need to install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Installation

### Automated Installation (Recommended)

1. **Clone or download this project to your Raspberry Pi:**
```bash
cd ~
git clone <your-repo-url> rpi-frame
cd rpi-frame
```

2. **Install dependencies:**
```bash
npm install
```

3. **Run the installation script:**
```bash
./install-display.sh
```

This script will:
- Install `feh` (image viewer) if not already installed
- Build the application
- Create and configure systemd services
- Start the photo frame automatically

That's it! The photo frame is now running and will start automatically on boot.

### Manual Installation

If you prefer to set things up manually:

1. **Clone or download this project to your Raspberry Pi**

2. **Install dependencies:**
```bash
npm install
```

3. **Install feh:**
```bash
sudo apt update
sudo apt install feh -y
```

4. **Build the application:**
```bash
npm run build
```

5. **Copy service files:**
```bash
sudo cp photo-frame-server.service /etc/systemd/system/
sudo cp photo-frame-display.service /etc/systemd/system/
# Edit the service files to update paths and username
sudo nano /etc/systemd/system/photo-frame-server.service
sudo nano /etc/systemd/system/photo-frame-display.service
```

6. **Enable and start services:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable photo-frame-server.service
sudo systemctl enable photo-frame-display.service
sudo systemctl start photo-frame-server.service
sudo systemctl start photo-frame-display.service
```

## Running the Application

### After Installation

Once installed, the photo frame runs automatically! Two services are running:

1. **Server Service** (`photo-frame-server.service`): The web server for managing photos
2. **Display Service** (`photo-frame-display.service`): The native image display

**Service Management Commands:**
```bash
# View logs
sudo journalctl -u photo-frame-server.service -f
sudo journalctl -u photo-frame-display.service -f

# Restart services
sudo systemctl restart photo-frame-server.service
sudo systemctl restart photo-frame-display.service

# Stop services
sudo systemctl stop photo-frame-server.service
sudo systemctl stop photo-frame-display.service

# Check status
sudo systemctl status photo-frame-server.service
sudo systemctl status photo-frame-display.service
```

### Development Mode (for testing)

If you want to test changes without the systemd services:

1. **Stop the services:**
```bash
sudo systemctl stop photo-frame-server.service
sudo systemctl stop photo-frame-display.service
```

2. **Run the server in development:**
```bash
npm run dev
```

3. **In another terminal, run the display client:**
```bash
node display-client.js
```

This will start:
- Backend API server on `http://localhost:3000`
- Frontend development server on `http://localhost:5173`
- Native display client for showing images

## Using the Application

### Accessing the Web Interface

Find your Raspberry Pi's IP address:
```bash
hostname -I
```

Then open a browser on any device on your local network and navigate to:
```
http://YOUR_PI_IP_ADDRESS:3000
```

For example: `http://192.168.1.100:3000`

### How It Works

1. **On the Raspberry Pi**: Images are displayed directly on the connected monitor using `feh` (no browser needed!)
2. **From Other Devices**: Access the web interface to upload and manage photos
3. **Real-time Updates**: The Pi display automatically updates when you add/remove/change photos

### Managing Photos

1. Open `http://YOUR_PI_IP_ADDRESS:3000/manage` on your phone or laptop
2. Upload new photos using the **"+ Upload Photos"** button
3. Show/hide photos from the slideshow using the eye icon
4. Delete unwanted photos with the delete button
5. The display on the Pi will auto-update within 1 second!

### Display Controls

From the web interface, you can:
- **Turn Display On/Off**: Use the display toggle to remotely turn the display on or off
- **Adjust Slideshow Duration**: Change how long each image displays
- **Organize Collections**: Group photos into collections
- **Select Active Collection**: Choose which collection to display

## Auto-Start on Boot

The installation script automatically configures the photo frame to start on boot. If you did a manual installation, see the service files section above.

To disable auto-start:
```bash
sudo systemctl disable photo-frame-server.service
sudo systemctl disable photo-frame-display.service
```

To re-enable:
```bash
sudo systemctl enable photo-frame-server.service
sudo systemctl enable photo-frame-display.service
```

## Project Structure

```
rpi-frame/
├── server/                    # Backend Express API
│   ├── index.ts              # Server entry point
│   ├── routes/               # API routes
│   └── utils/                # Utilities (image store, filesystem)
├── src/                      # Frontend React application
│   ├── components/           # React components
│   │   ├── Slideshow        # Slideshow view (for browser)
│   │   └── Admin            # Photo management
│   ├── App.tsx              # Main app component
│   └── main.tsx             # Entry point
├── display-client.js        # Native display client (runs on Pi)
├── photo-frame-server.service    # Systemd service for server
├── photo-frame-display.service   # Systemd service for display
├── install-display.sh       # Automated installation script
├── uploads/                 # Photo storage (created automatically)
├── data/                    # Image metadata (created automatically)
└── dist/                    # Compiled production files
```

## Architecture

This project has been redesigned to display images natively on the Raspberry Pi without requiring a browser:

**On the Raspberry Pi:**
1. **Server Service**: Runs the Express API server for photo management
2. **Display Client**: Runs `display-client.js` which uses `feh` to display images directly to the framebuffer
3. **Auto-sync**: The display client polls the server every second for updates

**From Other Devices:**
1. **Web Interface**: Access the full web UI from any device on the network
2. **Remote Control**: Upload photos, adjust settings, control display power
3. **Real-time Updates**: Changes sync to the Pi display within 1 second

**Benefits of Native Display:**
- ✅ No browser startup issues
- ✅ Lower memory usage
- ✅ Faster startup time
- ✅ More reliable display power control
- ✅ Simpler boot configuration
- ✅ Can still use the web interface from other devices

## Troubleshooting

**Cannot access from other devices:**
- Make sure your Pi and other devices are on the same network
- Check if a firewall is blocking port 3000
- Try: `sudo ufw allow 3000`

**Photos not uploading:**
- Check available disk space: `df -h`
- Ensure the `uploads` directory has write permissions

**Application not starting:**
- Check service status: `sudo systemctl status photo-frame-server.service`
- Check logs: `sudo journalctl -u photo-frame-server.service -n 50`

**Display not showing images:**
- Check display service: `sudo systemctl status photo-frame-display.service`
- Check logs: `sudo journalctl -u photo-frame-display.service -n 50`
- Make sure `feh` is installed: `sudo apt install feh`
- Verify display is connected: `DISPLAY=:0 xset q`

**Display turns back on automatically:**
- Some systems have power management that re-enables the display
- The display service includes automatic enforcement to keep it off
- Check if display is really off: `wlr-randr` or `tvservice -s`

**Images not updating on display:**
- Check that the display service is running
- Restart display service: `sudo systemctl restart photo-frame-display.service`
- Check for errors in logs

## Customization

### Change slideshow timing:

Use the web interface to adjust the slideshow duration, or edit `data/slideshow-state.json`:
```json
{
  "currentImageId": "...",
  "duration": 10000,
  "activeCollectionId": null
}
```

Duration is in milliseconds (10000 = 10 seconds).

### Change the polling interval:

Edit the display service file:
```bash
sudo nano /etc/systemd/system/photo-frame-display.service
```

Change the `POLL_INTERVAL` environment variable (in milliseconds):
```
Environment=POLL_INTERVAL=1000
```

Then reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart photo-frame-display.service
```

### Change upload file size limit:

Edit `server/routes/api.ts` and modify:
```typescript
limits: { fileSize: 10 * 1024 * 1024 } // Change to desired bytes
```

Then rebuild and restart:
```bash
npm run build
sudo systemctl restart photo-frame-server.service
```

## License

MIT License - Feel free to use and modify as needed!

## Support

For issues or questions, please check the troubleshooting section above or review the code comments for guidance.

Enjoy your digital photo frame! 📸

