import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

vi.mock('./imageStore', () => ({
  getImages: () => [],
  getCollections: () => [],
  getSlideshowState: () => ({ marker: 'state' }),
  setCurrentImage: vi.fn(),
  setSlideshowDuration: vi.fn(),
  setActiveCollection: vi.fn(),
}));

import { initWebSocketServer, attachWebSocketUpgrade } from './websocket';

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => {
    s.close();
    s.closeAllConnections();
  });
});

async function listen(): Promise<Server> {
  const s = createServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return s;
}

function firstMessage(url: string): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('message', (d) => {
      ws.close();
      resolve(JSON.parse(String(d)));
    });
    ws.on('error', reject);
  });
}

describe('websocket upgrades', () => {
  it('accepts /ws on every attached http server and rejects other paths', async () => {
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {})];
    const a = await listen();
    const b = await listen();
    initWebSocketServer(a);
    attachWebSocketUpgrade(b);
    for (const s of [a, b]) {
      const port = (s.address() as AddressInfo).port;
      expect((await firstMessage(`ws://127.0.0.1:${port}/ws`)).type).toBe('connected');
    }
    const port = (a.address() as AddressInfo).port;
    await expect(firstMessage(`ws://127.0.0.1:${port}/other`)).rejects.toBeTruthy();
    logs.forEach((l) => l.mockRestore());
  });
});
