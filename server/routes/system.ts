import express from 'express';
import fs from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/filesystem';

export interface SystemRouterOptions {
  versionFile?: string;
}

export function createSystemRouter(opts: SystemRouterOptions = {}): express.Router {
  const router = express.Router();

  // Cheap liveness check for the updater: no I/O, independent of setup state.
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/version', (_req, res) => {
    const versionFile = opts.versionFile ?? path.join(getProjectRoot(), 'VERSION');
    let version = 'dev';
    try {
      version = fs.readFileSync(versionFile, 'utf8').trim() || 'dev';
    } catch {
      // Missing or unreadable VERSION file: report a dev build.
    }
    res.json({ version });
  });

  return router;
}
