import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { createSetupRouter } from './setup';
import type { SetupService } from '../setup/setupService';

describe('setup router', () => {
  it('malformed JSON returns 400 and logs neither body nor stack', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    const service = { getState: vi.fn(), scanNetworks: vi.fn(), submitWifi: vi.fn() } as unknown as SetupService;
    const app = express();
    app.use('/api/setup', createSetupRouter(service));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/wifi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ssid":"Home","password":"typed-secret-pw"',
    });
    server.close();
    const body = await res.json();
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid request' });
    expect(logged).not.toContain('typed-secret-pw');
    expect(logged).not.toContain('    at ');
  });
});
