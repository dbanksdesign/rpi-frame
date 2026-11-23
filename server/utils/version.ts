import fs from 'fs';
import path from 'path';
import { getProjectRoot } from './filesystem';

/** Installed release version from the VERSION file, or 'dev' if absent/empty/unreadable. */
export function readVersion(versionFile?: string): string {
  const file = versionFile ?? path.join(getProjectRoot(), 'VERSION');
  try {
    return fs.readFileSync(file, 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}
