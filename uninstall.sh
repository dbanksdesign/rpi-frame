#!/bin/bash

# Uninstall script for Raspberry Pi Digital Photo Frame

echo "=========================================="
echo "Uninstalling Photo Frame Services"
echo "=========================================="
echo ""

# Stop services
echo "Stopping services..."
sudo systemctl stop photo-frame-server.service
sudo systemctl stop photo-frame-display.service

# Disable services
echo "Disabling services..."
sudo systemctl disable photo-frame-server.service
sudo systemctl disable photo-frame-display.service

# Remove service files
echo "Removing service files..."
sudo rm -f /etc/systemd/system/photo-frame-server.service
sudo rm -f /etc/systemd/system/photo-frame-display.service

# Reload systemd
sudo systemctl daemon-reload

echo ""
echo "✓ Services uninstalled"
echo ""
echo "Note: This does not remove:"
echo "  - The project files"
echo "  - Your uploaded photos"
echo "  - Node.js or feh"
echo ""
echo "To remove the project completely, run:"
echo "  rm -rf $(pwd)"
echo ""

