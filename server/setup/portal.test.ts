import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createPortalMiddleware } from './portal';
import type { SetupService } from './setupService';

function fakeService(): SetupService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isHotspotUp: vi.fn(() => true),
    hasPolled: vi.fn(() => true),
    getState: vi.fn(() => ({ phase: 'NO_WIFI', showOfflineBanner: false, addresses: { mdns: 'photoframe.local' } })),
    scanNetworks: vi.fn(async () => [{ ssid: 'Home', signal: 80, secured: true }]),
    submitWifi: vi.fn(async () => {}),
    notePortalActivity: vi.fn(),
  } as SetupService;
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server?.closeAllConnections();
  server = null;
});

async function boot(service = fakeService()) {
  const app = express();
  app.use(createPortalMiddleware(service));
  app.get('/api/ping', (_req, res) => {
    res.json({ pong: true });
  });
  app.get('/', (_req, res) => {
    res.send('main app');
  });
  const s = app.listen(0, '127.0.0.1');
  server = s;
  await new Promise((r) => s.once('listening', r));
  return { service, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

const json = { 'content-type': 'application/json' };

describe('portal', () => {
  it('redirects probe URLs and unknown paths to the gateway', async () => {
    const { base } = await boot();
    for (const p of [
      '/generate_204',
      '/gen_204',
      '/hotspot-detect.html',
      '/library/test/success.html',
      '/connecttest.txt',
      '/ncsi.txt',
      '/whatever',
    ]) {
      const res = await fetch(base + p, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://10.42.0.1/');
    }
  });

  it('serves the setup form on /', async () => {
    const { base } = await boot();
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form');
    expect(html).toContain('Reconnect your phone to your home WiFi');
  });

  it('lists networks', async () => {
    const { base } = await boot();
    const res = await fetch(base + '/networks');
    expect(await res.json()).toEqual([{ ssid: 'Home', signal: 80, secured: true }]);
  });

  it('malformed JSON returns 400 and logs neither body nor stack', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    const { base } = await boot();
    const res = await fetch(base + '/wifi', { method: 'POST', headers: json, body: '{"ssid":"Home","password":"typed-secret-pw"' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain('typed-secret-pw');
    expect(logged).not.toContain('    at ');
  });

  it('POST /wifi validates and returns 202', async () => {
    const { base, service } = await boot();
    const bad = await fetch(base + '/wifi', { method: 'POST', headers: json, body: JSON.stringify({ ssid: '' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(base + '/wifi', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ssid: 'Home', password: 'pw' }),
    });
    expect(ok.status).toBe(202);
    expect(service.submitWifi).toHaveBeenCalledWith('Home', 'pw', false);
  });

  it('is inert when the hotspot is down: the normal app answers', async () => {
    const service = fakeService();
    vi.mocked(service.isHotspotUp).mockReturnValue(false);
    const { base } = await boot(service);
    expect(await (await fetch(base + '/')).text()).toBe('main app');
    expect(await (await fetch(base + '/api/ping')).json()).toEqual({ pong: true });
    const probe = await fetch(base + '/generate_204', { redirect: 'manual' });
    expect(probe.status).toBe(404);
    const wifi = await fetch(base + '/wifi', { method: 'POST', headers: json, body: '{bad' });
    expect(wifi.status).toBe(404);
    expect(service.submitWifi).not.toHaveBeenCalled();
  });

  it('its /wifi and /networks handlers re-check that setup is active (409 otherwise)', async () => {
    const service = fakeService();
    vi.mocked(service.getState).mockReturnValue({ phase: 'READY', showOfflineBanner: false, addresses: { mdns: 'photoframe.local', adminPort: 80 } });
    // up for the portal's own gate, already down when the handler runs
    vi.mocked(service.isHotspotUp).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { base } = await boot(service);
    const res = await fetch(base + '/wifi', { method: 'POST', headers: json, body: JSON.stringify({ ssid: 'Home', password: 'pw' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Setup is not active' });
    expect(service.submitWifi).not.toHaveBeenCalled();
    vi.mocked(service.isHotspotUp).mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect((await fetch(base + '/networks')).status).toBe(409);
    expect(service.scanNetworks).not.toHaveBeenCalled();
  });

  it('follows the hotspot state on the same app', async () => {
    const service = fakeService();
    const up = vi.mocked(service.isHotspotUp);
    up.mockReturnValue(false);
    const { base } = await boot(service);
    expect(await (await fetch(base + '/')).text()).toBe('main app');
    up.mockReturnValue(true);
    expect(await (await fetch(base + '/')).text()).toContain('<form');
    expect((await fetch(base + '/generate_204', { redirect: 'manual' })).status).toBe(302);
    up.mockReturnValue(false);
    expect(await (await fetch(base + '/')).text()).toBe('main app');
  });

  it('records setup activity only for the setup page, /networks and POST /wifi', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base, service } = await boot();
    const noted = vi.mocked(service.notePortalActivity);
    for (const p of ['/generate_204', '/gen_204', '/hotspot-detect.html', '/library/test/success.html', '/connecttest.txt', '/ncsi.txt', '/whatever', '/networks/x']) {
      await fetch(base + p, { redirect: 'manual' });
    }
    await fetch(base + '/wifi', { redirect: 'manual' }); // GET /wifi is not the form submit
    expect(noted).not.toHaveBeenCalled();
    await fetch(base + '/');
    expect(noted).toHaveBeenCalledTimes(1);
    await fetch(base + '/networks');
    expect(noted).toHaveBeenCalledTimes(2);
    await fetch(base + '/wifi', { method: 'POST', headers: json, body: JSON.stringify({ ssid: 'Home', password: 'pw' }) });
    expect(noted).toHaveBeenCalledTimes(3);
    await fetch(base + '/wifi', { method: 'POST', headers: json, body: JSON.stringify({ ssid: '' }) });
    expect(noted).toHaveBeenCalledTimes(4);
    await fetch(base + '/wifi', { method: 'POST', headers: json, body: '{"ssid":' });
    expect(noted).toHaveBeenCalledTimes(5);
    expect(noted.mock.calls.every((c) => c.length === 0)).toBe(true);
    errSpy.mockRestore();
  });

  it('records no activity while the hotspot is down (inert)', async () => {
    const service = fakeService();
    vi.mocked(service.isHotspotUp).mockReturnValue(false);
    const { base } = await boot(service);
    await fetch(base + '/');
    await fetch(base + '/networks');
    await fetch(base + '/wifi', { method: 'POST', headers: json, body: JSON.stringify({ ssid: 'Home', password: 'pw' }) });
    expect(service.notePortalActivity).not.toHaveBeenCalled();
  });
});
