import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { ImageMetadata, getImages, saveImages, addImage, removeImage, toggleImageActive } from '../utils/imageStore';
import { getProjectRoot } from '../utils/filesystem';

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

export default router;

