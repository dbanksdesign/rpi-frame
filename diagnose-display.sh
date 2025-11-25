#!/bin/bash

# Diagnostic script to check what display control methods work on your Raspberry Pi

echo "========================================"
echo "Raspberry Pi Display Control Diagnostic"
echo "========================================"
echo ""

echo "1. Checking display server type..."
echo "-----------------------------------"
if [ -n "$WAYLAND_DISPLAY" ]; then
    echo "✓ Running Wayland (WAYLAND_DISPLAY=$WAYLAND_DISPLAY)"
elif [ -n "$DISPLAY" ]; then
    echo "✓ Running X11 (DISPLAY=$DISPLAY)"
else
    echo "⚠ No display server detected"
fi
echo ""

echo "2. Checking available display control tools..."
echo "----------------------------------------------"

# Check wlr-randr
if command -v wlr-randr &> /dev/null; then
    echo "✓ wlr-randr is installed"
    echo "  Testing wlr-randr:"
    wlr-randr 2>&1 | head -5 | sed 's/^/  /'
else
    echo "✗ wlr-randr not found"
fi
echo ""

# Check tvservice
if command -v tvservice &> /dev/null; then
    echo "✓ tvservice is installed"
    echo "  Testing tvservice -s:"
    tvservice -s 2>&1 | sed 's/^/  /'
else
    echo "✗ tvservice not found"
fi
echo ""

# Check xset
if command -v xset &> /dev/null; then
    echo "✓ xset is installed"
    echo "  Testing DISPLAY=:0 xset q:"
    DISPLAY=:0 xset q 2>&1 | grep -A 2 "DPMS" | sed 's/^/  /'
else
    echo "✗ xset not found"
fi
echo ""

# Check vcgencmd
if command -v vcgencmd &> /dev/null; then
    echo "✓ vcgencmd is installed"
    echo "  Testing vcgencmd display_power:"
    vcgencmd display_power 2>&1 | sed 's/^/  /'
else
    echo "✗ vcgencmd not found"
fi
echo ""

echo "3. Testing actual display control..."
echo "------------------------------------"
echo "This will attempt to turn off your display for 5 seconds"
read -p "Press Enter to continue (or Ctrl+C to cancel)..."
echo ""

# Try wlr-randr
if command -v wlr-randr &> /dev/null; then
    echo "Testing wlr-randr..."
    if wlr-randr --output HDMI-A-1 --off 2>/dev/null; then
        echo "  ✓ Command succeeded - display should be OFF now"
        sleep 5
        wlr-randr --output HDMI-A-1 --on 2>/dev/null
        echo "  ✓ Display turned back ON"
        echo ""
        echo "🎉 wlr-randr WORKS! This is your best option."
        exit 0
    else
        echo "  ✗ wlr-randr failed"
    fi
fi
echo ""

# Try tvservice
if command -v tvservice &> /dev/null; then
    echo "Testing tvservice..."
    if tvservice -o 2>/dev/null; then
        echo "  ✓ Command succeeded - display should be OFF now"
        sleep 5
        tvservice -p 2>/dev/null
        sleep 2
        # Try to refresh framebuffer
        fbset -depth 8 2>/dev/null && fbset -depth 16 2>/dev/null
        echo "  ✓ Display turned back ON"
        echo ""
        echo "🎉 tvservice WORKS! This is a good option."
        exit 0
    else
        echo "  ✗ tvservice failed"
    fi
fi
echo ""

# Try xset
if command -v xset &> /dev/null; then
    echo "Testing xset..."
    if DISPLAY=:0 xset dpms force off 2>/dev/null; then
        echo "  ⚠ Command ran without error"
        echo "  Check if your display actually turned off..."
        sleep 5
        DISPLAY=:0 xset dpms force on 2>/dev/null
        echo "  Display should be back on"
        echo ""
        read -p "Did the display actually turn off? (y/n): " answer
        if [ "$answer" = "y" ]; then
            echo "🎉 xset WORKS on your system!"
            exit 0
        else
            echo "⚠ xset command runs but doesn't control display"
        fi
    else
        echo "  ✗ xset failed"
    fi
fi
echo ""

# Try vcgencmd
if command -v vcgencmd &> /dev/null; then
    echo "Testing vcgencmd..."
    if vcgencmd display_power 0 2>/dev/null; then
        echo "  ✓ Command succeeded - display should be OFF now"
        sleep 5
        vcgencmd display_power 1 2>/dev/null
        echo "  ✓ Display turned back ON"
        echo ""
        echo "🎉 vcgencmd WORKS!"
        exit 0
    else
        echo "  ✗ vcgencmd failed"
    fi
fi
echo ""

echo "========================================"
echo "⚠ NO METHOD WORKED RELIABLY"
echo "========================================"
echo ""
echo "Your Raspberry Pi may need additional configuration."
echo "Please share the output above so we can find a solution."

