#!/bin/bash

# Helper script to control display with proper Wayland permissions
# This runs wlr-randr with the correct environment for the logged-in user

# Get the user who owns the graphical session
GRAPHICAL_USER=$(who | grep '(:0)' | awk '{print $1}' | head -1)

if [ -z "$GRAPHICAL_USER" ]; then
    # Fallback: try to find user running Wayfire or other compositor
    GRAPHICAL_USER=$(ps aux | grep -E '[w]ayfire|[w]eston|[s]way' | awk '{print $1}' | head -1)
fi

if [ -z "$GRAPHICAL_USER" ]; then
    echo "ERROR: Could not find graphical session user"
    exit 1
fi

# Get the user's ID and runtime directory
USER_ID=$(id -u "$GRAPHICAL_USER")
RUNTIME_DIR="/run/user/$USER_ID"

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

