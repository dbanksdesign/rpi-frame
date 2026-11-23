#!/bin/bash

# Setup script for passwordless sudo for display control
# This allows the server service to control the display

echo "=========================================="
echo "Setting up Display Control Permissions"
echo "=========================================="
echo ""

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CURRENT_USER=$(whoami)

echo "Current user: $CURRENT_USER"
echo "Project directory: $SCRIPT_DIR"
echo ""

# Create sudoers file for passwordless display control
echo "Creating sudoers configuration..."

SUDOERS_FILE="/etc/sudoers.d/photo-frame-display"
CONTROL_SCRIPT="$SCRIPT_DIR/control-display.sh"

# Create the sudoers entry
# This allows the server user to run the control script and wlr-randr as any user
cat > /tmp/photo-frame-display-sudoers << EOF
# Allow photo frame server to control display
$CURRENT_USER ALL=(ALL) NOPASSWD: $CONTROL_SCRIPT
$CURRENT_USER ALL=(ALL) NOPASSWD: /usr/bin/wlr-randr
EOF

# Install the sudoers file
sudo cp /tmp/photo-frame-display-sudoers "$SUDOERS_FILE"
sudo chmod 0440 "$SUDOERS_FILE"
rm /tmp/photo-frame-display-sudoers

# Verify the sudoers file
if sudo visudo -c -f "$SUDOERS_FILE" > /dev/null 2>&1; then
    echo "✓ Sudoers file created and validated"
else
    echo "✗ ERROR: Sudoers file has syntax errors"
    sudo rm "$SUDOERS_FILE"
    exit 1
fi

echo ""
echo "=========================================="
echo "Testing display control..."
echo "=========================================="
echo ""

# Test the control script
echo "Testing OFF..."
if sudo "$CONTROL_SCRIPT" off; then
    echo "✓ Display control OFF works"
    sleep 2
    echo "Testing ON..."
    if sudo "$CONTROL_SCRIPT" on; then
        echo "✓ Display control ON works"
    else
        echo "✗ Display control ON failed"
        exit 1
    fi
else
    echo "✗ Display control OFF failed"
    exit 1
fi

echo ""
echo "=========================================="
echo "✓ Setup Complete!"
echo "=========================================="
echo ""
echo "Display control is now configured."
echo ""
echo "Now rebuild and restart the server:"
echo "  cd $SCRIPT_DIR"
echo "  npm run build"
echo "  sudo systemctl restart photo-frame-server.service"
echo ""

