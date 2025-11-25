#!/bin/bash

# Installation script for Raspberry Pi Digital Photo Frame
# This configures the Pi to display images natively without a browser

set -e  # Exit on error

echo "=========================================="
echo "Raspberry Pi Digital Photo Frame Setup"
echo "Native Display (No Browser Required)"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR"

# Get current user
CURRENT_USER=$(whoami)

echo "Current user: $CURRENT_USER"
echo "Project directory: $PROJECT_DIR"
echo ""

# Step 1: Check if feh is installed
echo "Step 1: Checking for required packages..."
if ! command -v feh &> /dev/null; then
    echo -e "${YELLOW}feh is not installed. Installing...${NC}"
    sudo apt update
    sudo apt install -y feh
    echo -e "${GREEN}✓ feh installed${NC}"
else
    echo -e "${GREEN}✓ feh is already installed${NC}"
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js is not installed!${NC}"
    echo "Please install Node.js first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js is installed ($NODE_VERSION)${NC}"

# Get the path to node
NODE_PATH=$(which node)
echo "Node path: $NODE_PATH"
echo ""

# Step 2: Build the application if needed
echo "Step 2: Building application..."
if [ ! -d "$PROJECT_DIR/dist" ]; then
    echo "Building application for the first time..."
    cd "$PROJECT_DIR"
    npm run build
    echo -e "${GREEN}✓ Application built${NC}"
else
    echo -e "${GREEN}✓ Application already built${NC}"
fi
echo ""

# Step 3: Create systemd service files with actual paths
echo "Step 3: Creating systemd service files..."

# Update service files with actual user and paths
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
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u $CURRENT_USER)
Environment=DISPLAY=:0
ExecStart=$NODE_PATH $PROJECT_DIR/dist/server/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

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
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u $CURRENT_USER)
Environment=SERVER_URL=http://localhost:3000
Environment=POLL_INTERVAL=1000
ExecStart=$NODE_PATH $PROJECT_DIR/display-client.js
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
EOF

# Copy service files to systemd directory
sudo cp /tmp/photo-frame-server.service /etc/systemd/system/
sudo cp /tmp/photo-frame-display.service /etc/systemd/system/

# Clean up temp files
rm /tmp/photo-frame-server.service
rm /tmp/photo-frame-display.service

echo -e "${GREEN}✓ Service files created${NC}"
echo ""

# Step 4: Enable and start services
echo "Step 4: Enabling and starting services..."
sudo systemctl daemon-reload
sudo systemctl enable photo-frame-server.service
sudo systemctl enable photo-frame-display.service
sudo systemctl start photo-frame-server.service

# Wait for server to be ready
echo "Waiting for server to start..."
sleep 5

# Start display client
sudo systemctl start photo-frame-display.service

echo -e "${GREEN}✓ Services enabled and started${NC}"
echo ""

# Step 5: Check status
echo "Step 5: Checking service status..."
echo ""
echo "Server status:"
sudo systemctl status photo-frame-server.service --no-pager | head -15
echo ""
echo "Display client status:"
sudo systemctl status photo-frame-display.service --no-pager | head -15
echo ""

# Step 6: Display information
echo "=========================================="
echo -e "${GREEN}Installation Complete!${NC}"
echo "=========================================="
echo ""
echo "The photo frame is now running!"
echo ""
echo "📱 Access the web interface from another device:"
IP_ADDRESS=$(hostname -I | awk '{print $1}')
echo "   http://$IP_ADDRESS:3000"
echo ""
echo "🖼️  The display is now showing images directly (no browser needed)"
echo ""
echo "📋 Useful commands:"
echo "   View server logs:  sudo journalctl -u photo-frame-server.service -f"
echo "   View display logs: sudo journalctl -u photo-frame-display.service -f"
echo "   Restart server:    sudo systemctl restart photo-frame-server.service"
echo "   Restart display:   sudo systemctl restart photo-frame-display.service"
echo "   Stop services:     sudo systemctl stop photo-frame-server.service photo-frame-display.service"
echo ""
echo "💡 Tips:"
echo "   - Upload photos from your phone/laptop at http://$IP_ADDRESS:3000"
echo "   - The display will automatically update when you add/remove photos"
echo "   - You can control slideshow timing from the web interface"
echo "   - Use the display on/off toggle in the web interface"
echo ""

