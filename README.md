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

### For the Wall Display

1. Open the application on your Raspberry Pi's browser
2. Click **"Slideshow"** in the navigation
3. Press F11 to enter fullscreen mode
4. Photos will automatically cycle every 5 seconds

### Managing Photos

1. Open the application on your phone or laptop at `http://YOUR_PI_IP_ADDRESS:3000`
2. Click **"Manage Photos"** in the navigation
3. Upload new photos using the **"+ Upload Photos"** button
4. Show/hide photos from the slideshow using the eye icon
5. Delete unwanted photos with the delete button

## Auto-Start on Boot (Optional)

To make the application start automatically when your Raspberry Pi boots:

1. **Create a systemd service:**
```bash
sudo nano /etc/systemd/system/photo-frame.service
```

2. **Add the following content** (replace `YOUR_USERNAME` and paths as needed):
```ini
[Unit]
Description=Digital Photo Frame
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/rpi-frame
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

3. **Enable and start the service:**
```bash
sudo systemctl enable photo-frame.service
sudo systemctl start photo-frame.service
```

4. **Check status:**
```bash
sudo systemctl status photo-frame.service
```

## Auto-Start Browser in Kiosk Mode (Optional)

To automatically open the slideshow in fullscreen when the Pi boots:

1. **Edit autostart file:**
```bash
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```

2. **Add these lines:**
```
@xset s off
@xset -dpms
@xset s noblank
@chromium-browser --kiosk --app=http://localhost:3000
```

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

