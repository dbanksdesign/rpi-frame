import { getProjectRoot } from './filesystem';

// Root for writable app data (uploads/ and data/). In production this is a
// separate data partition set via FRAME_DATA_DIR; otherwise the project root.
export function getDataRoot(): string {
  return process.env.FRAME_DATA_DIR || getProjectRoot();
}
