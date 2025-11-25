#!/usr/bin/env node
/**
 * Native Display Client for Raspberry Pi
 * 
 * This script runs on the Raspberry Pi and displays images directly
 * without needing a web browser. It polls the server for the current
 * slideshow state and updates the display accordingly.
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const POLL_INTERVAL = process.env.POLL_INTERVAL || 1000; // Check for changes every second
const PROJECT_ROOT = __dirname;
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');

let currentProcess = null;
let currentImageId = null;
let displayState = 'on';
let currentDuration = 120000; // Track current duration

// Log with timestamp
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Check if feh is installed
function checkFehInstalled() {
  return new Promise((resolve) => {
    exec('which feh', (error) => {
      resolve(!error);
    });
  });
}

// Kill current display process
function killCurrentDisplay() {
  if (currentProcess) {
    try {
      process.kill(-currentProcess.pid); // Kill process group
      log('Killed previous display process');
    } catch (err) {
      log(`Error killing process: ${err.message}`);
    }
    currentProcess = null;
  }
}

// Display an image using feh
function displayImage(imagePath) {
  return new Promise((resolve, reject) => {
    // Kill any existing display
    killCurrentDisplay();

    if (!fs.existsSync(imagePath)) {
      log(`Image file not found: ${imagePath}`);
      reject(new Error('Image file not found'));
      return;
    }

    log(`Displaying image: ${imagePath}`);

    // Use feh to display the image fullscreen
    // Options:
    // -F: fullscreen
    // -Z: auto-zoom to fit screen
    // -Y: hide cursor
    // -x: borderless window
    // --no-menus: hide menus
    // --quiet: suppress output
    const fehArgs = [
      '-F',           // fullscreen
      '-Z',           // auto-zoom
      '-Y',           // hide cursor
      '-x',           // borderless
      '--no-menus',   // no menus
      '--quiet',      // quiet mode
      imagePath
    ];

    // Create a new process group so we can kill all child processes
    currentProcess = spawn('feh', fehArgs, {
      detached: true,
      stdio: 'ignore'
    });

    currentProcess.on('error', (err) => {
      log(`Error spawning feh: ${err.message}`);
      reject(err);
    });

    currentProcess.on('exit', (code, signal) => {
      log(`feh process exited with code ${code} and signal ${signal}`);
      if (currentProcess && currentProcess.pid === currentProcess?.pid) {
        currentProcess = null;
      }
    });

    resolve();
  });
}

// Clear the display (show black screen)
function clearDisplay() {
  killCurrentDisplay();
  log('Display cleared - feh process killed');
}

// Fetch slideshow state from server
async function fetchSlideshowState() {
  try {
    const response = await fetch(`${SERVER_URL}/api/slideshow/state`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    log(`Error fetching slideshow state: ${error.message}`);
    return null;
  }
}

// Fetch display state from server
async function fetchDisplayState() {
  try {
    const response = await fetch(`${SERVER_URL}/api/display/status`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.isOn ? 'on' : 'off';
  } catch (error) {
    log(`Error fetching display state: ${error.message}`);
    return 'on'; // Default to on if we can't fetch
  }
}

// Get all active images
async function fetchActiveImages() {
  try {
    const response = await fetch(`${SERVER_URL}/api/images/active`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const images = await response.json();
    return images;
  } catch (error) {
    log(`Error fetching active images: ${error.message}`);
    return [];
  }
}

// Trigger the server's display toggle endpoint
async function triggerServerDisplayToggle(powerState) {
  try {
    const response = await fetch(`${SERVER_URL}/api/display/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ power: powerState }),
    });
    
    if (response.ok) {
      const result = await response.json();
      log(`Server display toggle successful: ${result.method || 'unknown method'}`);
      return true;
    } else {
      log(`Server display toggle failed: ${response.status}`);
      return false;
    }
  } catch (error) {
    log(`Error calling server display toggle: ${error.message}`);
    return false;
  }
}

// Main update loop
async function updateDisplay() {
  try {
    // Check display state first
    const newDisplayState = await fetchDisplayState();
    if (newDisplayState !== displayState) {
      const oldState = displayState;
      displayState = newDisplayState;
      log(`Display state changed from ${oldState} to ${displayState}`);
      
      if (displayState === 'off') {
        // Clear the feh display
        clearDisplay();
        // Tell the server to turn off the physical display
        log('Requesting server to turn off physical display...');
        await triggerServerDisplayToggle(false);
        return;
      } else {
        // Display is turning on
        log('Requesting server to turn on physical display...');
        await triggerServerDisplayToggle(true);
        // Wait a moment for display to power on
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Resume slideshow
        await startLocalSlideshow();
      }
    }

    if (displayState === 'off') {
      // Don't update display if it's off
      return;
    }

    // Fetch current slideshow state
    const state = await fetchSlideshowState();
    if (!state) {
      return;
    }

    const { currentImageId: newImageId, duration: newDuration } = state;

    // Check if duration changed
    if (newDuration && newDuration !== currentDuration) {
      log(`Duration changed from ${currentDuration}ms to ${newDuration}ms`);
      currentDuration = newDuration;
      // Restart slideshow with new duration
      await startLocalSlideshow();
    }

    // If image changed, update display
    if (newImageId && newImageId !== currentImageId) {
      currentImageId = newImageId;
      
      // The image filename is stored as the ID
      const imagePath = path.join(UPLOADS_DIR, currentImageId);
      
      try {
        await displayImage(imagePath);
      } catch (err) {
        log(`Failed to display image: ${err.message}`);
      }
    } else if (!newImageId && currentImageId) {
      // No image selected, clear display
      currentImageId = null;
      clearDisplay();
    }
  } catch (error) {
    log(`Error in update loop: ${error.message}`);
  }
}

// Handle slideshow rotation locally if no browser control
let localSlideshowInterval = null;

async function startLocalSlideshow() {
  const state = await fetchSlideshowState();
  if (!state) return;

  const duration = state.duration || 120000;
  currentDuration = duration; // Update tracked duration
  const images = await fetchActiveImages();

  if (images.length === 0) {
    log('No active images for slideshow');
    return;
  }

  let currentIndex = 0;
  
  // Find current image index if one is set
  if (state.currentImageId) {
    const index = images.findIndex(img => img.id === state.currentImageId);
    if (index !== -1) {
      currentIndex = index;
    }
  }

  // Clear existing interval
  if (localSlideshowInterval) {
    clearInterval(localSlideshowInterval);
    localSlideshowInterval = null;
  }

  // For single image, just display it without rotation
  if (images.length === 1) {
    const image = images[0];
    currentImageId = image.id;
    const imagePath = path.join(UPLOADS_DIR, image.filename);
    try {
      await displayImage(imagePath);
      await fetch(`${SERVER_URL}/api/slideshow/current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: image.id }),
      }).catch(() => {});
    } catch (err) {
      log(`Failed to display single image: ${err.message}`);
    }
    log(`Single image mode: ${image.filename}`);
    return;
  }

  // Rotate images
  localSlideshowInterval = setInterval(async () => {
    if (displayState === 'off') return;

    const images = await fetchActiveImages();
    if (images.length === 0) return;

    currentIndex = (currentIndex + 1) % images.length;
    const nextImage = images[currentIndex];
    
    if (nextImage) {
      currentImageId = nextImage.id;
      const imagePath = path.join(UPLOADS_DIR, nextImage.filename);
      
      try {
        await displayImage(imagePath);
        
        // Update server with current image
        await fetch(`${SERVER_URL}/api/slideshow/current`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ imageId: nextImage.id }),
        }).catch(() => {}); // Ignore errors
      } catch (err) {
        log(`Failed to display image in slideshow: ${err.message}`);
      }
    }
  }, duration);

  log(`Local slideshow started with ${images.length} images, ${duration}ms interval`);
}

// Cleanup on exit
process.on('SIGINT', () => {
  log('Received SIGINT, cleaning up...');
  killCurrentDisplay();
  if (localSlideshowInterval) {
    clearInterval(localSlideshowInterval);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, cleaning up...');
  killCurrentDisplay();
  if (localSlideshowInterval) {
    clearInterval(localSlideshowInterval);
  }
  process.exit(0);
});

// Main entry point
async function main() {
  log('=== Raspberry Pi Native Display Client ===');
  log(`Server URL: ${SERVER_URL}`);
  log(`Poll interval: ${POLL_INTERVAL}ms`);
  
  // Check if feh is installed
  const fehInstalled = await checkFehInstalled();
  if (!fehInstalled) {
    console.error('ERROR: feh is not installed!');
    console.error('Please install it with: sudo apt install feh');
    process.exit(1);
  }
  
  log('feh is installed ✓');
  
  // Wait for server to be ready
  log('Waiting for server to be ready...');
  let serverReady = false;
  while (!serverReady) {
    try {
      const response = await fetch(`${SERVER_URL}/api/images/active`);
      if (response.ok) {
        serverReady = true;
        log('Server is ready ✓');
      }
    } catch (err) {
      log('Server not ready yet, retrying in 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Start local slideshow management
  await startLocalSlideshow();
  
  // Start polling for changes
  log('Starting display update loop...');
  setInterval(updateDisplay, POLL_INTERVAL);
  
  // Initial display update
  await updateDisplay();
  
  log('Display client is running. Press Ctrl+C to exit.');
}

// Run main
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

