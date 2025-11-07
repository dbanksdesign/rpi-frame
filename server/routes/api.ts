import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ImageMetadata, getImages, saveImages, addImage, removeImage, toggleImageActive } from '../utils/imageStore';
import { getProjectRoot } from '../utils/filesystem';

const execPromise = promisify(exec);

export const router = express.Router();

// Configure multer for file uploads
const uploadsDir = path.join(getProjectRoot(), 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// Get all images
router.get('/images', (req: Request, res: Response) => {
  try {
    const images = getImages();
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// Get active images only (for slideshow)
router.get('/images/active', (req: Request, res: Response) => {
  try {
    const images = getImages().filter(img => img.active);
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active images' });
  }
});

// Upload new image
router.post('/images/upload', upload.single('image'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const imageMetadata: ImageMetadata = {
      id: req.file.filename,
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: `/uploads/${req.file.filename}`,
      uploadedAt: new Date().toISOString(),
      active: true
    };

    addImage(imageMetadata);
    res.json(imageMetadata);
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Toggle image active status
router.patch('/images/:id/toggle', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const success = toggleImageActive(id);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle image status' });
  }
});

// Delete image
router.delete('/images/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const images = getImages();
    const image = images.find(img => img.id === id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Delete file from filesystem
    const filePath = path.join(getProjectRoot(), 'uploads', image.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from metadata
    removeImage(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Store display state in memory (since getting status is not reliable across all Pi models)
let displayState = true;

// Background interval to keep display off if needed
let keepOffInterval: NodeJS.Timeout | null = null;

// Helper function to find working DISPLAY value
async function findWorkingDisplay(): Promise<string | null> {
  const displays = [':0', ':1'];
  for (const display of displays) {
    try {
      await execPromise(`DISPLAY=${display} xset q`);
      console.log(`Found working DISPLAY: ${display}`);
      return display;
    } catch (error) {
      // This display doesn't work, try next
    }
  }
  return null;
}

// Function to enforce display staying off
async function enforceDisplayOff() {
  try {
    // Check if display is on and turn it off again
    const { stdout } = await execPromise('wlr-randr');
    if (stdout.includes('HDMI-A-1') && stdout.includes('enabled')) {
      console.log('⚠️ Display woke up, turning off again...');
      await execPromise('wlr-randr --output HDMI-A-1 --off');
    }
  } catch (error) {
    console.error('Error enforcing display off:', error);
  }
}

// Get display power status
router.get('/display/status', async (req: Request, res: Response) => {
  try {
    // Return the stored state
    res.json({ isOn: displayState });
  } catch (error) {
    console.error('Failed to get display status:', error);
    res.status(500).json({ error: 'Failed to get display status' });
  }
});

// Toggle display power
router.post('/display/toggle', async (req: Request, res: Response) => {
  try {
    const { power } = req.body; // true for on, false for off
    
    // Try multiple methods in order of preference
    let success = false;
    let successMethod = '';
    let errorMessages: string[] = [];

    // Method 1: Try wlr-randr FIRST (works for Wayland/Wayfire)
    if (!success) {
      try {
        if (power) {
          // Turn display on - restore full output
          await execPromise('wlr-randr --output HDMI-A-1 --on');
          // Also enable DPMS
          try {
            await execPromise('wlr-randr --output HDMI-A-1 --dpms on');
          } catch {
            // DPMS might not be supported
          }
          console.log('wlr-randr: Display ON');
        } else {
          // Turn display off - disable output completely
          const { stdout } = await execPromise('wlr-randr --output HDMI-A-1 --off');
          console.log('wlr-randr output:', stdout);
          
          // Start a background job to keep checking and turning it off
          // Some systems (like Wayfire) try to auto-enable the display
          if (keepOffInterval) {
            clearInterval(keepOffInterval);
          }
          keepOffInterval = setInterval(enforceDisplayOff, 3000); // Check every 3 seconds
          console.log('Started background enforcement to keep display off');
          
          // Wait a moment, then verify it stayed off
          await new Promise(resolve => setTimeout(resolve, 500));
          const { stdout: statusCheck } = await execPromise('wlr-randr');
          console.log('wlr-randr status after OFF:', statusCheck);
        }
        
        // If turning ON, stop the enforcement interval
        if (power && keepOffInterval) {
          clearInterval(keepOffInterval);
          keepOffInterval = null;
          console.log('Stopped background enforcement');
        }
        
        success = true;
        successMethod = 'wlr-randr';
        console.log(`✓ Display ${power ? 'ON' : 'OFF'} using wlr-randr`);
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        errorMessages.push(`wlr-randr: ${errorMsg}`);
        console.log(`✗ wlr-randr failed: ${errorMsg}`);
      }
    }

    // Method 2: Try tvservice (HDMI control) - fallback for older systems
    if (!success) {
      try {
        if (power) {
          // Turn on HDMI
          const { stdout: statusBefore } = await execPromise('tvservice -s');
          console.log('tvservice status before ON:', statusBefore);
          
          await execPromise('tvservice -p');
          // Give it a moment to power up
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Refresh the framebuffer to restore display
          try {
            await execPromise('chvt 6 && chvt 7');
          } catch {
            // Fallback to fbset if chvt requires sudo
            try {
              await execPromise('fbset -depth 8 && fbset -depth 16');
            } catch {
              console.log('Could not refresh framebuffer, but display should still be on');
            }
          }
          
          const { stdout: statusAfter } = await execPromise('tvservice -s');
          console.log('tvservice status after ON:', statusAfter);
        } else {
          // Turn off HDMI
          const { stdout: statusBefore } = await execPromise('tvservice -s');
          console.log('tvservice status before OFF:', statusBefore);
          
          await execPromise('tvservice -o');
          
          const { stdout: statusAfter } = await execPromise('tvservice -s');
          console.log('tvservice status after OFF:', statusAfter);
        }
        success = true;
        successMethod = 'tvservice';
        console.log(`✓ Display ${power ? 'ON' : 'OFF'} using tvservice`);
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        errorMessages.push(`tvservice: ${errorMsg}`);
        console.log(`✗ tvservice failed: ${errorMsg}`);
      }
    }

    // Method 3: Try xset with auto-detected DISPLAY (works when X server is running)
    if (!success) {
      try {
        const display = await findWorkingDisplay();
        if (display) {
          if (power) {
            // Turn on display
            await execPromise(`DISPLAY=${display} xset dpms force on`);
            await execPromise(`DISPLAY=${display} xset s reset`);
          } else {
            // Turn off display - disable screensaver first, then force off
            await execPromise(`DISPLAY=${display} xset s off`);
            await execPromise(`DISPLAY=${display} xset -dpms`);
            await execPromise(`DISPLAY=${display} xset dpms force off`);
          }
          success = true;
          successMethod = `xset (${display})`;
          console.log(`✓ Display ${power ? 'ON' : 'OFF'} using xset with ${display}`);
        } else {
          errorMessages.push('xset: No working DISPLAY found');
          console.log('✗ xset failed: No working DISPLAY found');
        }
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        errorMessages.push(`xset: ${errorMsg}`);
        console.log(`✗ xset failed: ${errorMsg}`);
      }
    }

    // Method 4: Try vcgencmd (older Raspberry Pi OS)
    if (!success) {
      try {
        const vcgencmd = `vcgencmd display_power ${power ? '1' : '0'}`;
        const { stdout } = await execPromise(vcgencmd);
        console.log('vcgencmd output:', stdout);
        success = true;
        successMethod = 'vcgencmd';
        console.log(`✓ Display ${power ? 'ON' : 'OFF'} using vcgencmd`);
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        errorMessages.push(`vcgencmd: ${errorMsg}`);
        console.log(`✗ vcgencmd failed: ${errorMsg}`);
      }
    }

    if (success) {
      displayState = power;
      console.log(`✓✓✓ Display successfully ${power ? 'ON' : 'OFF'} via ${successMethod}`);
      res.json({ success: true, isOn: power, method: successMethod });
    } else {
      console.error('❌ All display toggle methods failed');
      console.error('Errors:', errorMessages);
      res.status(500).json({ 
        error: 'Failed to toggle display',
        attempts: errorMessages,
        details: 'Make sure your user has permission to control the display. You may need to run the server with appropriate permissions.'
      });
    }
  } catch (error) {
    console.error('Failed to toggle display:', error);
    res.status(500).json({ error: 'Failed to toggle display' });
  }
});

export default router;

