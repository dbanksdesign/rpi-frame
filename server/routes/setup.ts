import { Router } from 'express';
import type { SetupService } from '../setup/setupService';
import { parseWifiRequest } from '../setup/wifiRequest';

export function createSetupRouter(service: SetupService): Router {
  const router = Router();

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

  return router;
}

/** Router used when the real setup service is disabled (FRAME_SETUP=off). */
export function createDisabledSetupRouter(): Router {
  const router = Router();
  router.get('/state', (_req, res) => {
    res.json({ phase: 'READY', showOfflineBanner: false, addresses: { mdns: 'photoframe.local' } });
  });
  return router;
}
