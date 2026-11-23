import fs from 'fs';

// Write JSON via a temp file + fsync + rename so a crash or power loss never
// leaves a truncated file behind.
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
