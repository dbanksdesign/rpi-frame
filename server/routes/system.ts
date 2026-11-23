import express, { NextFunction, Request, Response } from 'express';
import { readVersion } from '../utils/version';
import { run } from '../setup/exec';
import { createUpdateService, UpdateError, UpdateService } from '../update/updateService';

export interface SystemRouterOptions {
  versionFile?: string;
  update?: UpdateService;
}

export function createSystemRouter(opts: SystemRouterOptions = {}): express.Router {
  const router = express.Router();
  const update = opts.update ?? createUpdateService({ run, versionFile: opts.versionFile });

  // Cheap liveness check for the updater: no I/O, independent of setup state.
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/version', (_req, res) => {
    res.json({ version: readVersion(opts.versionFile) });
  });

  // Own small JSON parser so malformed bodies are handled below instead of
  // reaching Express's default logger.
  const json = express.json({ limit: '4kb' });

  router.post('/update/check', async (_req, res) => {
    res.json(await update.check());
  });

  router.post('/update/install', json, async (req, res) => {
    const tag = (req.body as { tag?: unknown } | undefined)?.tag;
    try {
      const result = await update.install(tag as string);
      if (result === 'started') res.status(202).json({ status: 'started' });
      else res.status(409).json({ status: 'already-running' });
    } catch (err) {
      if (err instanceof UpdateError) {
        switch (err.code) {
          case 'invalid-tag':
            return res.status(400).json({ error: 'Invalid version' });
          case 'dev-build':
            return res.status(409).json({ error: "A development build can't be updated" });
          case 'up-to-date':
            return res.status(409).json({ error: 'Already up to date' });
          case 'start-failed':
            return res.status(500).json({ error: 'Could not start the update' });
        }
      }
      res.status(500).json({ error: 'Could not start the update' });
    }
  });

  router.get('/update/status', (_req, res) => {
    res.json(update.status());
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    console.error('[update] rejected a malformed request body');
    res.status(400).json({ error: 'Invalid request' });
  });

  return router;
}
