#!/bin/bash

# Wait for desktop to fully load
sleep 5

# Disable screen blanking
DISPLAY=:0 xset s off          # Disable screensaver
DISPLAY=:0 xset +dpms          # ENABLE DPMS (instead of -dpms)
DISPLAY=:0 xset s noblank      # Prevent automatic blanking
DISPLAY=:0 xset dpms 0 0 0     # Set all DPMS timeouts to 0 (never auto-trigger)

# Hide cursor after 0.1 seconds of inactivity
DISPLAY=:0 unclutter -idle 0.1 -root &

# Wait for server to be ready and actually responding
echo "Waiting for photo frame server..."
until curl -f http://localhost:3000 > /dev/null 2>&1; do
    echo "Server not ready yet, waiting..."
    sleep 3
done

echo "Server is ready! Waiting 5 more seconds..."
sleep 5

# Launch browser in kiosk mode with additional flags
DISPLAY=:0 chromium-browser \
  --kiosk \
  --start-fullscreen \
  --app=http://localhost:3000/slideshow \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-translate \
  --disable-session-crashed-bubble \
  --disable-component-update \
  --check-for-update-interval=31536000 \
  --disable-features=TranslateUI \
  --disable-restore-session-state \
  --password-store=basic \
  --incognito &

echo "Browser launched!"