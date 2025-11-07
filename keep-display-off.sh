#!/bin/bash
# Script to keep the display off and prevent Wayfire from waking it
# This runs in a loop to ensure the display stays off

echo "Keeping display OFF..."

# Turn off the display
wlr-randr --output HDMI-A-1 --off

# Keep checking and turning it off if it wakes up
for i in {1..10}; do
    sleep 1
    # Check if display is on and turn it off again
    if wlr-randr | grep -q "HDMI-A-1.*enabled"; then
        echo "Display woke up, turning off again..."
        wlr-randr --output HDMI-A-1 --off
    fi
done

echo "Display should now stay off"

