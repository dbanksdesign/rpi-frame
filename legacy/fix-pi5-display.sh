#!/bin/bash

# Quick fix script for Raspberry Pi 5 Wayland display control

echo "=========================================="
echo "Fixing Display Control for Pi 5 + Wayland"
echo "=========================================="
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR"
CURRENT_USER=$(whoami)
NODE_PATH=$(which node)
USER_ID=$(id -u)

echo "User: $CURRENT_USER (ID: $USER_ID)"
echo "Project: $PROJECT_DIR"
echo ""

# Recreate server service with Wayland env vars
echo "Updating server service file..."
cat > /tmp/photo-frame-server.service << EOF
[Unit]
Description=Digital Photo Frame Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=WAYLAND_DISPLAY=wayland-1
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
Environment=DISPLAY=:0
ExecStart=$NODE_PATH $PROJECT_DIR/dist/server/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Recreate display service with Wayland env vars
echo "Updating display service file..."
cat > /tmp/photo-frame-display.service << EOF
[Unit]
Description=Digital Photo Frame Native Display Client
After=network.target photo-frame-server.service graphical.target
Wants=photo-frame-server.service

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$PROJECT_DIR
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-1
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
Environment=SERVER_URL=http://localhost:3000
Environment=POLL_INTERVAL=1000
ExecStart=$NODE_PATH $PROJECT_DIR/display-client.js
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
EOF

# Install the updated service files
echo "Installing updated service files..."
sudo cp /tmp/photo-frame-server.service /etc/systemd/system/
sudo cp /tmp/photo-frame-display.service /etc/systemd/system/

# Clean up temp files
rm /tmp/photo-frame-server.service
rm /tmp/photo-frame-display.service

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Restart services
echo "Restarting services..."
sudo systemctl restart photo-frame-server.service
sleep 2
sudo systemctl restart photo-frame-display.service

echo ""
echo "=========================================="
echo "✓ Services Updated!"
echo "=========================================="
echo ""
echo "The services now have WAYLAND_DISPLAY and XDG_RUNTIME_DIR"
echo "which are required for wlr-randr to work on Raspberry Pi 5."
echo ""
echo "Testing in 3 seconds..."
sleep 3

# Show logs
echo ""
echo "Recent server logs:"
sudo journalctl -u photo-frame-server.service -n 10 --no-pager
echo ""
echo "Recent display logs:"
sudo journalctl -u photo-frame-display.service -n 10 --no-pager
echo ""
echo "=========================================="
echo "Now try the display toggle in the web interface!"
echo "Watch logs with:"
echo "  sudo journalctl -u photo-frame-server.service -f"
echo "=========================================="

