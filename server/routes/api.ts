import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
  ImageMetadata, 
  Collection,
  getImages, 
  saveImages, 
  addImage, 
  removeImage, 
  toggleImageActive, 
  getSlideshowState, 
  setCurrentImage, 
  setSlideshowDuration,
  getCollections,
  addCollection,
  updateCollection,
  removeCollection,
  addImageToCollection,
  removeImageFromCollection,
  setActiveCollection
} from '../utils/imageStore';
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
    const { collectionId } = req.query;
    let images = getImages().filter(img => img.active);
    
    // Filter by collection if specified
    if (collectionId && typeof collectionId === 'string') {
      images = images.filter(img => 
        img.collectionIds && img.collectionIds.includes(collectionId)
      );
    }
    
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active images' });
  }
});

// Get slideshow state (current image and duration)
router.get('/slideshow/state', (req: Request, res: Response) => {
  try {
    const state = getSlideshowState();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch slideshow state' });
  }
});

// Set current image in slideshow
router.post('/slideshow/current', (req: Request, res: Response) => {
  try {
    const { imageId } = req.body;
    setCurrentImage(imageId);
    res.json({ success: true, currentImageId: imageId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set current image' });
  }
});

// Set slideshow duration
router.post('/slideshow/duration', (req: Request, res: Response) => {
  try {
    const { duration } = req.body;
    if (typeof duration !== 'number' || duration < 1000) {
      return res.status(400).json({ error: 'Duration must be at least 1000ms' });
    }
    setSlideshowDuration(duration);
    res.json({ success: true, duration });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set slideshow duration' });
  }
});

// Set active collection for slideshow
router.post('/slideshow/collection', (req: Request, res: Response) => {
  try {
    const { collectionId } = req.body;
    setActiveCollection(collectionId);
    res.json({ success: true, activeCollectionId: collectionId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set active collection' });
  }
});

// ========== Collection Management Routes ==========

// Get all collections
router.get('/collections', (req: Request, res: Response) => {
  try {
    const collections = getCollections();
    res.json(collections);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// Create new collection
router.post('/collections', (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Collection name is required' });
    }
    
    const collection: Collection = {
      id: Date.now() + '-' + Math.round(Math.random() * 1E9),
      name: name.trim(),
      description: description?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    
    addCollection(collection);
    res.json(collection);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create collection' });
  }
});

// Update collection
router.patch('/collections/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    
    const updates: Partial<Omit<Collection, 'id'>> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Collection name cannot be empty' });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = description?.trim() || undefined;
    }
    
    const success = updateCollection(id, updates);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Collection not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to update collection' });
  }
});

// Delete collection
router.delete('/collections/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const success = removeCollection(id);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Collection not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete collection' });
  }
});

// Add image to collection
router.post('/collections/:collectionId/images/:imageId', (req: Request, res: Response) => {
  try {
    const { collectionId, imageId } = req.params;
    const success = addImageToCollection(imageId, collectionId);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to add image to collection' });
  }
});

// Remove image from collection
router.delete('/collections/:collectionId/images/:imageId', (req: Request, res: Response) => {
  try {
    const { collectionId, imageId } = req.params;
    const success = removeImageFromCollection(imageId, collectionId);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Image not found or not in collection' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove image from collection' });
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
      active: true,
      collectionIds: []
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
    
    // Use xset with DISPLAY=:0 for X11
    const command = power 
      ? 'DISPLAY=:0 xset dpms force on'
      : 'DISPLAY=:0 xset dpms force off';
    
    await execPromise(command);
    
    displayState = power;
    console.log(`✓ Display ${power ? 'ON' : 'OFF'} using xset`);
    res.json({ success: true, isOn: power, method: 'xset' });
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error('Failed to toggle display:', errorMsg);
    res.status(500).json({ 
      error: 'Failed to toggle display',
      details: errorMsg
    });
  }
});

export default router;

