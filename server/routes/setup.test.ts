import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createSetupRouter, createDisabledSetupRouter } from './setup';
import type { SetupService } from '../setup/setupService';
import type { SetupPhase } from '../setup/types';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server?.closeAllConnections();
  server = null;
});

function fakeService(opts: { phase?: SetupPhase; hotspot?: boolean } = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isHotspotUp: vi.fn(() => opts.hotspot ?? false),
    getState: vi.fn(() => ({ phase: opts.phase ?? 'READY', showOfflineBanner: false, addresses: { mdns: 'photoframe.local', adminPort: 80 } })),
    scanNetworks: vi.fn(async () => [{ ssid: 'Home', signal: 80, secured: true }]),
    submitWifi: vi.fn(async () => {}),
  } as unknown as SetupService & { submitWifi: ReturnType<typeof vi.fn>; scanNetworks: ReturnType<typeof vi.fn> };
}

async function boot(router: express.Router) {
  const app = express();
  app.use('/api/setup', router);
  const s = app.listen(0, '127.0.0.1');
  server = s;
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/setup`;
}

const json = { 'content-type': 'application/json' };

describe('setup router', () => {
  it('malformed JSON returns 400 and logs neither body nor stack', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    const base = await boot(createSetupRouter(fakeService({ phase: 'NO_WIFI', hotspot: true })));
    const res = await fetch(`${base}/wifi`, {
      method: 'POST',
      headers: json,
      body: '{"ssid":"Home","password":"typed-secret-pw"',
    });
    const body = await res.json();
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid request' });
    expect(logged).not.toContain('typed-secret-pw');
    expect(logged).not.toContain('    at ');
  });

  it('outside setup (READY / NO_TAILSCALE, no hotspot) /wifi and /networks answer 409 and touch nothing', async () => {
    for (const phase of ['READY', 'NO_TAILSCALE'] as const) {
      const service = fakeService({ phase });
      const base = await boot(createSetupRouter(service));
      const wifi = await fetch(`${base}/wifi`, { method: 'POST', headers: json, body: JSON.stringify({ ssid: 'Evil', password: 'pw123456' }) });
      expect(wifi.status).toBe(409);
      expect(await wifi.json()).toEqual({ error: 'Setup is not active' });
      const malformed = await fetch(`${base}/wifi`, { method: 'POST', headers: json, body: '{bad' });
      expect(malformed.status).toBe(409);
      const nets = await fetch(`${base}/networks`);
      expect(nets.status).toBe(409);
      expect(service.submitWifi).not.toHaveBeenCalled();
      expect(service.scanNetworks).not.toHaveBeenCalled();
      // the state stays readable
      expect((await fetch(`${base}/state`)).status).toBe(200);
      server?.close();
      server?.closeAllConnections();
    }
  });

  it('during setup (NO_WIFI or hotspot up) works as before: 400 on bad input, 202 on good', async () => {
    for (const opts of [{ phase: 'NO_WIFI' as const }, { phase: 'NO_WIFI' as const, hotspot: true }, { phase: 'READY' as const, hotspot: true }]) {
      const service = fakeService(opts);
      const base = await boot(createSetupRouter(service));
      const bad = await fetch(`${base}/wifi`, { method: 'POST', headers: json, body: JSON.stringify({ ssid: '' }) });
      expect(bad.status).toBe(400);
      const ok = await fetch(`${base}/wifi`, { method: 'POST', headers: json, body: JSON.stringify({ ssid: 'Home', password: 'pw' }) });
      expect(ok.status).toBe(202);
      expect(service.submitWifi).toHaveBeenCalledWith('Home', 'pw', false);
      expect(await (await fetch(`${base}/networks`)).json()).toEqual([{ ssid: 'Home', signal: 80, secured: true }]);
      server?.close();
      server?.closeAllConnections();
    }
  });

  it('FRAME_SETUP=off router still answers /state with READY', async () => {
    const base = await boot(createDisabledSetupRouter(() => 3000));
    const res = await fetch(`${base}/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: 'READY', addresses: { adminPort: 3000 } });
  });
});
