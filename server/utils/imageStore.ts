import fs from 'fs';
import path from 'path';
import { getProjectRoot } from './filesystem';

export interface ImageMetadata {
  id: string;
  filename: string;
  originalName: string;
  path: string;
  uploadedAt: string;
  active: boolean;
}

const DATA_DIR = path.join(getProjectRoot(), 'data');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize images file if it doesn't exist
if (!fs.existsSync(IMAGES_FILE)) {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify([], null, 2));
}

export function getImages(): ImageMetadata[] {
  try {
    const data = fs.readFileSync(IMAGES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading images file:', error);
    return [];
  }
}

export function saveImages(images: ImageMetadata[]): void {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2));
}

export function addImage(image: ImageMetadata): void {
  const images = getImages();
  images.push(image);
  saveImages(images);
}

export function removeImage(id: string): boolean {
  const images = getImages();
  const filtered = images.filter(img => img.id !== id);
  
  if (filtered.length === images.length) {
    return false; // Image not found
  }
  
  saveImages(filtered);
  return true;
}

export function toggleImageActive(id: string): boolean {
  const images = getImages();
  const image = images.find(img => img.id === id);
  
  if (!image) {
    return false;
  }
  
  image.active = !image.active;
  saveImages(images);
  return true;
}

