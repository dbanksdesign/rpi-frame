#!/bin/bash

echo "=== Testing Display Control Methods on Raspberry Pi ==="
echo ""

# Environment diagnosis
echo "Environment Diagnosis:"
echo "  Current user: $(whoami)"
echo "  DISPLAY env: ${DISPLAY:-not set}"
echo "  XDG_RUNTIME_DIR: ${XDG_RUNTIME_DIR:-not set}"
echo "  WAYLAND_DISPLAY: ${WAYLAND_DISPLAY:-not set}"
echo ""

# Check what's running
echo "Display Server Detection:"
if pgrep -x "Xorg" > /dev/null || pgrep -x "X" > /dev/null; then
    echo "  ✓ X11 is running"
    ps aux | grep -E "X|Xorg" | grep -v grep | head -1
fi
if pgrep -x "wayfire" > /dev/null || pgrep -x "weston" > /dev/null; then
    echo "  ✓ Wayland compositor is running"
fi
if [ -n "$DISPLAY" ]; then
    echo "  Current DISPLAY: $DISPLAY"
fi
echo ""

# Find X displays
echo "Available X displays:"
ls -la /tmp/.X11-unix/ 2>/dev/null || echo "  No X11 sockets found"
echo ""

# Test 1: xset with different DISPLAY values
echo "Test 1: xset (X11 display power)"
if command -v xset &> /dev/null; then
    echo "  ✓ xset is installed"
    
    # Try to find the right DISPLAY
    for display in ":0" ":1" "$DISPLAY"; do
        if [ -n "$display" ]; then
            echo "  Trying DISPLAY=$display..."
            DISPLAY=$display xset q &> /dev/null
            if [ $? -eq 0 ]; then
                echo "    ✓ DISPLAY=$display works!"
                echo "    Testing display OFF..."
                DISPLAY=$display xset dpms force off 2>&1
                if [ $? -eq 0 ]; then
                    echo "    ✓ Display turned OFF"
                    sleep 3
                    echo "    Turning display back ON..."
                    DISPLAY=$display xset dpms force on 2>&1
                    echo "    Status: SUCCESS with DISPLAY=$display"
                    break
                fi
            else
                echo "    ✗ DISPLAY=$display doesn't work"
            fi
        fi
    done
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

