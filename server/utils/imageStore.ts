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
  collectionIds: string[]; // Collections this image belongs to
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

const DATA_DIR = path.join(getProjectRoot(), 'data');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');
const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize images file if it doesn't exist
if (!fs.existsSync(IMAGES_FILE)) {
  fs.writeFileSync(IMAGES_FILE, JSON.stringify([], null, 2));
}

// Initialize collections file if it doesn't exist
if (!fs.existsSync(COLLECTIONS_FILE)) {
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify([], null, 2));
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
  // Initialize collectionIds if not present
  if (!image.collectionIds) {
    image.collectionIds = [];
  }
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

// Collection management functions
export function getCollections(): Collection[] {
  try {
    const data = fs.readFileSync(COLLECTIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading collections file:', error);
    return [];
  }
}

export function saveCollections(collections: Collection[]): void {
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
}

export function addCollection(collection: Collection): void {
  const collections = getCollections();
  collections.push(collection);
  saveCollections(collections);
}

export function updateCollection(id: string, updates: Partial<Omit<Collection, 'id'>>): boolean {
  const collections = getCollections();
  const collection = collections.find(c => c.id === id);
  
  if (!collection) {
    return false;
  }
  
  Object.assign(collection, updates);
  saveCollections(collections);
  return true;
}

export function removeCollection(id: string): boolean {
  const collections = getCollections();
  const filtered = collections.filter(c => c.id !== id);
  
  if (filtered.length === collections.length) {
    return false; // Collection not found
  }
  
  // Remove this collection from all images
  const images = getImages();
  images.forEach(img => {
    img.collectionIds = img.collectionIds.filter(cId => cId !== id);
  });
  saveImages(images);
  
  saveCollections(filtered);
  return true;
}

export function addImageToCollection(imageId: string, collectionId: string): boolean {
  const images = getImages();
  const image = images.find(img => img.id === imageId);
  
  if (!image) {
    return false;
  }
  
  // Initialize collectionIds if it doesn't exist (for backwards compatibility)
  if (!image.collectionIds) {
    image.collectionIds = [];
  }
  
  // Add collection if not already present
  if (!image.collectionIds.includes(collectionId)) {
    image.collectionIds.push(collectionId);
    saveImages(images);
  }
  
  return true;
}

export function removeImageFromCollection(imageId: string, collectionId: string): boolean {
  const images = getImages();
  const image = images.find(img => img.id === imageId);
  
  if (!image || !image.collectionIds) {
    return false;
  }
  
  const initialLength = image.collectionIds.length;
  image.collectionIds = image.collectionIds.filter(cId => cId !== collectionId);
  
  if (image.collectionIds.length !== initialLength) {
    saveImages(images);
    return true;
  }
  
  return false;
}

// Slideshow state management
interface SlideshowState {
  currentImageId: string | null;
  duration: number; // in milliseconds
  activeCollectionId: string | null; // null = show all active images
}

const STATE_FILE = path.join(DATA_DIR, 'slideshow-state.json');

function getDefaultState(): SlideshowState {
  return {
    currentImageId: null,
    duration: 120000, // 2 minutes default
    activeCollectionId: null, // null = show all active images
  };
}

export function getSlideshowState(): SlideshowState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading slideshow state:', error);
  }
  return getDefaultState();
}

export function saveSlideshowState(state: SlideshowState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error saving slideshow state:', error);
  }
}

export function setCurrentImage(imageId: string | null): void {
  const state = getSlideshowState();
  state.currentImageId = imageId;
  saveSlideshowState(state);
}

export function setSlideshowDuration(duration: number): void {
  const state = getSlideshowState();
  state.duration = duration;
  saveSlideshowState(state);
}

export function setActiveCollection(collectionId: string | null): void {
  const state = getSlideshowState();
  state.activeCollectionId = collectionId;
  saveSlideshowState(state);
}

