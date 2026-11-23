import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { router as apiRouter } from './routes/api';
import { ensureDirectories } from './utils/filesystem';
import { getDataRoot } from './utils/paths';
import { initWebSocketServer } from './utils/websocket';
import { getImages } from './utils/imageStore';
import { run } from './setup/exec';
import { createWifiManager } from './setup/nmcli';
import { createTailscaleClient } from './setup/tailscale';
import { createSetupService } from './setup/setupService';
import { startPortal } from './setup/portal';
import { createSetupRouter, createDisabledSetupRouter } from './routes/setup';
import { createSystemRouter } from './routes/system';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

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
  app.use('/api/setup', createDisabledSetupRouter());
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
    portalFactory: (service) => startPortal(service),
  });
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

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${PORT}/ws`);
  console.log(`Access from other devices on your network using your Pi's IP address`);
});

