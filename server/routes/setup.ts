import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { SetupService } from '../setup/setupService';
import { parseWifiRequest } from '../setup/wifiRequest';

export function createSetupRouter(service: SetupService): Router {
  const router = Router();
  // Own parser + error handler so a malformed body (which may hold a typed WiFi
  // password) is never echoed or logged by Express's default handler. Mount this
  // router before any global express.json().
  router.use(express.json({ limit: '4kb' }));

  router.get('/state', (_req, res) => {
    res.json(service.getState());
  });

  router.get('/networks', async (_req, res) => {
    res.json(await service.scanNetworks());
  });

  router.post('/wifi', (req, res) => {
    const parsed = parseWifiRequest(req.body);
    if (!parsed) {
      res.status(400).json({ error: 'Invalid WiFi details' });
      return;
    }
    res.status(202).json({ accepted: true });
    service.submitWifi(parsed.ssid, parsed.password, parsed.hidden).catch(() => {
      console.error('[setup] wifi submit failed');
    });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    console.error('[setup] rejected a malformed request body');
    res.status(400).json({ error: 'Invalid request' });
  });

  return router;
}

/** Router used when the real setup service is disabled (FRAME_SETUP=off). */
export function createDisabledSetupRouter(getAdminPort: () => 80 | 3000 = () => 3000): Router {
  const router = Router();
  router.get('/state', (_req, res) => {
    res.json({ phase: 'READY', showOfflineBanner: false, addresses: { mdns: 'photoframe.local', adminPort: getAdminPort() } });
  });
  return router;
}
