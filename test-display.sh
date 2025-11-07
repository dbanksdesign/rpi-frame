#!/bin/bash

echo "=== Testing Display Control Methods on Raspberry Pi ==="
echo ""

# Test 1: xset
echo "Test 1: xset (X11 display power)"
if command -v xset &> /dev/null; then
    echo "  ✓ xset is installed"
    echo "  Trying to turn display OFF..."
    DISPLAY=:0 xset dpms force off 2>&1
    if [ $? -eq 0 ]; then
        echo "  ✓ xset command succeeded"
        sleep 3
        echo "  Turning display back ON..."
        DISPLAY=:0 xset dpms force on 2>&1
        echo "  Status: SUCCESS"
    else
        echo "  ✗ xset command failed"
    fi
else
    echo "  ✗ xset not installed"
fi
echo ""

# Test 2: tvservice
echo "Test 2: tvservice (HDMI control)"
if command -v tvservice &> /dev/null; then
    echo "  ✓ tvservice is installed"
    echo "  Current status:"
    tvservice -s
    echo "  Trying to turn display OFF..."
    tvservice -o 2>&1
    if [ $? -eq 0 ]; then
        echo "  ✓ tvservice off succeeded"
        sleep 3
        echo "  Turning display back ON..."
        tvservice -p 2>&1
        sleep 1
        # Try to refresh display
        if command -v fbset &> /dev/null; then
            fbset -depth 8 && fbset -depth 16
        fi
        echo "  Status: SUCCESS"
    else
        echo "  ✗ tvservice command failed"
    fi
else
    echo "  ✗ tvservice not installed"
fi
echo ""

# Test 3: vcgencmd
echo "Test 3: vcgencmd display_power"
if command -v vcgencmd &> /dev/null; then
    echo "  ✓ vcgencmd is installed"
    echo "  Trying to turn display OFF..."
    vcgencmd display_power 0 2>&1
    if [ $? -eq 0 ]; then
        echo "  ✓ vcgencmd command succeeded"
        sleep 3
        echo "  Turning display back ON..."
        vcgencmd display_power 1 2>&1
        echo "  Status: SUCCESS"
    else
        echo "  ✗ vcgencmd command failed"
    fi
else
    echo "  ✗ vcgencmd not installed"
fi
echo ""

# Test 4: wlr-randr
echo "Test 4: wlr-randr (Wayland)"
if command -v wlr-randr &> /dev/null; then
    echo "  ✓ wlr-randr is installed"
    echo "  Available outputs:"
    WAYLAND_DISPLAY=wayland-1 wlr-randr 2>&1
    echo "  Status: Available (manual test needed)"
else
    echo "  ✗ wlr-randr not installed"
fi
echo ""

echo "=== Test Complete ==="
echo ""
echo "Recommendations:"
echo "- If xset worked: Your display should have turned off and back on"
echo "- If tvservice worked: Check if HDMI output toggled"
echo "- Check the server logs after clicking the button to see which method succeeds"
echo ""
echo "If none worked, you may need to:"
echo "1. Run the Node.js server as a user with display access"
echo "2. Grant permissions: sudo usermod -a -G video \$USER"
echo "3. Check if screensaver/power management is blocking the commands"

