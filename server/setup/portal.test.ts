import { describe, it, expect, afterEach, vi } from 'vitest';
import { startPortal } from './portal';
import type { SetupService } from './setupService';

function fakeService(): SetupService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({ phase: 'NO_WIFI', showOfflineBanner: false, addresses: { mdns: 'photoframe.local' } })),
    scanNetworks: vi.fn(async () => [{ ssid: 'Home', signal: 80, secured: true }]),
    submitWifi: vi.fn(async () => {}),
  } as SetupService;
}

let handle: { close(): void; port: number } | null = null;
afterEach(() => {
  handle?.close();
  handle = null;
});

async function boot(service = fakeService()) {
  handle = startPortal(service, 0);
  await new Promise((r) => setTimeout(r, 50));
  return { service, base: `http://127.0.0.1:${handle.port}` };
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
});
