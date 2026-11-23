import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { router as apiRouter } from './routes/api';
import { ensureDirectories } from './utils/filesystem';
import { getDataRoot } from './utils/paths';
import { initWebSocketServer, attachWebSocketUpgrade } from './utils/websocket';
import { getImages } from './utils/imageStore';
import { run } from './setup/exec';
import { createWifiManager } from './setup/nmcli';
import { createTailscaleClient } from './setup/tailscale';
import { createSetupService } from './setup/setupService';
import { createPortalMiddleware } from './setup/portal';
import { createSetupRouter, createDisabledSetupRouter } from './routes/setup';
import { createSystemRouter } from './routes/system';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const ADMIN_HTTP_PORT = 80;
// Port the main app is reachable on without a port suffix; becomes 80 once that bind succeeds.
let adminPort: 80 | 3000 = 3000;
// Captive-portal middleware, mounted ONLY on the port-80 listener (never on 3000).
let portalMiddleware: express.RequestHandler | null = null;

// Initialize WebSocket server
initWebSocketServer(server);

// Middleware
app.use(cors());

// Ensure required directories exist
ensureDirectories();

// Serve uploaded images statically
const uploadsPath = path.join(getDataRoot(), 'uploads');
console.log('Serving uploads from:', uploadsPath);
app.use('/uploads', express.static(uploadsPath));

// Setup (WiFi / Tailscale onboarding). FRAME_SETUP=off disables it for dev machines.
if (process.env.FRAME_SETUP === 'off') {
  app.use('/api/setup', createDisabledSetupRouter(() => adminPort));
} else {
  const setupService = createSetupService({
    wifi: createWifiManager(run),
    tailscale: createTailscaleClient(run),
    now: () => Date.now(),
    hasPhotos: () => {
      try {
        return getImages().length > 0;
      } catch {
        return false;
      }
    },
    getAdminPort: () => adminPort,
  });
  portalMiddleware = createPortalMiddleware(setupService);
  app.use('/api/setup', createSetupRouter(setupService));
  setupService.start();
}

// System routes (health, version, update) must be mounted before the main API
// router. They sit ahead of the global JSON parser because the update route has
// its own parser and error handler (malformed bodies must not be logged).
app.use('/api', createSystemRouter());

// Global JSON parser goes after the setup and system routers, which have their own.
app.use(express.json());

// API routes
app.use('/api', apiRouter);

// Serve frontend (check if built files exist)
const clientPath = path.join(__dirname, '../client');
const indexPath = path.join(clientPath, 'index.html');

if (fs.existsSync(indexPath)) {
  console.log('Serving frontend from:', clientPath);
  app.use(express.static(clientPath));
  app.get('*', (_, res) => {
    res.sendFile(indexPath);
  });
} else {
  console.log('Frontend not built. Run "npm run build" to build the application.');
  app.get('*', (_, res) => {
    res.status(404).send('Frontend not built. Please run "npm run build" first.');
  });
}

// Same app on port 80 so the admin page is at http://photoframe.local. The portal
// middleware sits in front of it there and is inert unless the hotspot is up.
// Binding 80 needs CAP_NET_BIND_SERVICE (granted by the unit); elsewhere keep serving on 3000.
const portalApp = express();
if (portalMiddleware) portalApp.use(portalMiddleware);
portalApp.use(app);
const adminServer = createServer(portalApp);
attachWebSocketUpgrade(adminServer);
adminServer.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`Could not listen on port ${ADMIN_HTTP_PORT} (${err.code ?? 'error'}); admin stays on port ${PORT}`);
});
adminServer.listen(ADMIN_HTTP_PORT, '0.0.0.0', () => {
  adminPort = 80;
  console.log(`Admin also available on port ${ADMIN_HTTP_PORT}`);
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${PORT}/ws`);
  console.log(`Access from other devices on your network using your Pi's IP address`);
});

