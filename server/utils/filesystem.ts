import fs from 'fs';
import path from 'path';

// Get the project root directory (works in both dev and production)
export function getProjectRoot(): string {
  // In dev mode: __dirname is server/utils, so go up 2 levels
  // In production: __dirname is dist/server/utils, so go up 3 levels
  const isDev = __dirname.includes('server/utils') && !__dirname.includes('dist');
  const levelsUp = isDev ? 2 : 3;
  return path.resolve(__dirname, '../'.repeat(levelsUp));
}

export function ensureDirectories(): void {
  const projectRoot = getProjectRoot();
  const directories = [
    path.join(projectRoot, 'uploads'),
    path.join(projectRoot, 'data')
  ];

  console.log('Project root:', projectRoot);
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } else {
      console.log(`Directory exists: ${dir}`);
    }
  });
}

