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
    let errorMessages: string[] = [];

    // Method 1: Try xset (works when X server is running)
    if (!success) {
      try {
        const xsetCmd = power 
          ? 'DISPLAY=:0 xset dpms force on' 
          : 'DISPLAY=:0 xset dpms force off';
        await execPromise(xsetCmd);
        success = true;
        console.log('Display toggled using xset');
      } catch (error) {
        errorMessages.push('xset failed');
      }
    }

    // Method 2: Try wlr-randr (works for Wayland)
    if (!success) {
      try {
        const wlrCmd = power
          ? 'WAYLAND_DISPLAY=wayland-1 wlr-randr --output HDMI-A-1 --on'
          : 'WAYLAND_DISPLAY=wayland-1 wlr-randr --output HDMI-A-1 --off';
        await execPromise(wlrCmd);
        success = true;
        console.log('Display toggled using wlr-randr');
      } catch (error) {
        errorMessages.push('wlr-randr failed');
      }
    }

    // Method 3: Try vcgencmd (older Raspberry Pi OS)
    if (!success) {
      try {
        const vcgencmd = `vcgencmd display_power ${power ? '1' : '0'}`;
        await execPromise(vcgencmd);
        success = true;
        console.log('Display toggled using vcgencmd');
      } catch (error) {
        errorMessages.push('vcgencmd failed');
      }
    }

    // Method 4: Try tvservice (HDMI control)
    if (!success) {
      try {
        if (power) {
          // Turn on HDMI and refresh framebuffer
          await execPromise('tvservice -p');
          await execPromise('fbset -depth 8 && fbset -depth 16');
        } else {
          // Turn off HDMI
          await execPromise('tvservice -o');
        }
        success = true;
        console.log('Display toggled using tvservice');
      } catch (error) {
        errorMessages.push('tvservice failed');
      }
    }

    if (success) {
      displayState = power;
      res.json({ success: true, isOn: power });
    } else {
      console.error('All display toggle methods failed:', errorMessages);
      res.status(500).json({ 
        error: 'Failed to toggle display. Tried: ' + errorMessages.join(', '),
        details: 'Make sure your user has permission to control the display'
      });
    }
  } catch (error) {
    console.error('Failed to toggle display:', error);
    res.status(500).json({ error: 'Failed to toggle display' });
  }
});

export default router;

