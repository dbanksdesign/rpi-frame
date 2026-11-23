import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Photos are shown full-screen on one display, so anything larger than this
// only costs memory (a 12MP photo decodes to ~48MB in the browser).
export const MAX_DIMENSION = 1920;

/**
 * Resize an image in place so its longest side is at most MAX_DIMENSION.
 * Applies EXIF rotation (resizing strips the tag), keeps the original format
 * and filename. Animated GIFs are left untouched. Returns true if rewritten.
 */
export async function optimizeImage(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gif') return false;

  const tmpPath = `${filePath}.tmp`;
  let pipeline = sharp(filePath)
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

  if (ext === '.png') pipeline = pipeline.png();
  else if (ext === '.webp') pipeline = pipeline.webp({ quality: 85 });
  else pipeline = pipeline.jpeg({ quality: 85 });

  try {
    await pipeline.toFile(tmpPath);
    const before = fs.statSync(filePath).size;
    const after = fs.statSync(tmpPath).size;
    // Keep the original if re-encoding somehow made it bigger and it was already small enough.
    if (after >= before) {
      const { width = 0, height = 0 } = await sharp(filePath).metadata();
      if (Math.max(width, height) <= MAX_DIMENSION) {
        fs.unlinkSync(tmpPath);
        return false;
      }
    }
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw err;
  }
}
