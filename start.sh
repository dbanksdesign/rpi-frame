#!/bin/bash

# Wait for desktop to fully load
sleep 5

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Hide cursor after 0.1 seconds of inactivity
unclutter -idle 0.1 -root &

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