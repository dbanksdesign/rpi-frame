#!/bin/bash

# Helper script to control display with proper Wayland permissions
# This runs wlr-randr with the correct environment for the logged-in user

# Try multiple methods to find the graphical session user
GRAPHICAL_USER=""

# Method 1: Check who is running this script (if logged in graphically)
if [ -n "$SUDO_USER" ]; then
    GRAPHICAL_USER="$SUDO_USER"
fi

# Method 2: Find user running Wayfire or other Wayland compositor
if [ -z "$GRAPHICAL_USER" ]; then
    GRAPHICAL_USER=$(ps aux | grep -E '[w]ayfire|[w]eston|[s]way|[l]abwc' | awk '{print $1}' | head -1)
fi

# Method 3: Check loginctl for sessions
if [ -z "$GRAPHICAL_USER" ]; then
    GRAPHICAL_USER=$(loginctl list-sessions --no-legend | awk '{print $3}' | head -1)
fi

# Method 4: Check who is logged in to any display
if [ -z "$GRAPHICAL_USER" ]; then
    GRAPHICAL_USER=$(who | awk '{print $1}' | head -1)
fi

# Method 5: Get the first non-root user from /home
if [ -z "$GRAPHICAL_USER" ]; then
    GRAPHICAL_USER=$(ls /home | head -1)
fi

if [ -z "$GRAPHICAL_USER" ]; then
    echo "ERROR: Could not find graphical session user"
    echo "Debug info:"
    echo "  who output: $(who)"
    echo "  ps wayfire: $(ps aux | grep -E '[w]ayfire' | head -1)"
    echo "  loginctl: $(loginctl list-sessions --no-legend 2>/dev/null)"
    echo "  home dirs: $(ls /home 2>/dev/null)"
    exit 1
fi

echo "Found graphical user: $GRAPHICAL_USER"

# Get the user's ID and runtime directory
USER_ID=$(id -u "$GRAPHICAL_USER")
RUNTIME_DIR="/run/user/$USER_ID"

echo "User ID: $USER_ID, Runtime dir: $RUNTIME_DIR"

# Action: "on" or "off"
ACTION="$1"

if [ "$ACTION" != "on" ] && [ "$ACTION" != "off" ]; then
    echo "Usage: $0 {on|off}"
    exit 1
fi

# Run wlr-randr as the graphical user with proper environment
if [ "$ACTION" = "off" ]; then
    sudo -u "$GRAPHICAL_USER" \
        WAYLAND_DISPLAY=wayland-1 \
        XDG_RUNTIME_DIR="$RUNTIME_DIR" \
        wlr-randr --output HDMI-A-1 --off
else
    sudo -u "$GRAPHICAL_USER" \
        WAYLAND_DISPLAY=wayland-1 \
        XDG_RUNTIME_DIR="$RUNTIME_DIR" \
        wlr-randr --output HDMI-A-1 --on
fi

exit $?

