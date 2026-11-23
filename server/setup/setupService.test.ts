import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSetupService } from './setupService';
import type { WifiManager } from './nmcli';
import type { TailscaleClient } from './tailscale';

function setup(opts: { grace?: number } = {}) {
  let t = 1_000_000;
  const f = {
    wifiUp: false,
    tsLoggedIn: false,
    connectError: null as Error | null,
    internet: true,
    photos: false,
  };
  const wifi = {
    scan: vi.fn(async () => []),
    connect: vi.fn(async () => {
      if (f.connectError) throw f.connectError;
    }),
    startHotspot: vi.fn(async () => {}),
    stopHotspot: vi.fn(async () => {}),
    isConnected: vi.fn(async () => f.wifiUp),
  } satisfies WifiManager;
  const tailscale = {
    status: vi.fn(async () => (f.tsLoggedIn ? { loggedIn: true, tailnetIp: '100.1.2.3' } : { loggedIn: false })),
    startLogin: vi.fn(async () => 'https://login.tailscale.com/a/abc'),
  } satisfies TailscaleClient;
  const portal = { close: vi.fn(), port: 80 };
  const portalFactory = vi.fn(() => portal);
  const service = createSetupService({
    wifi,
    tailscale,
    now: () => t,
    hasPhotos: () => f.photos,
    hasInternet: async () => f.internet,
    pollMs: 1000,
    startupGraceMs: opts.grace ?? 0,
    portalFactory,
  });
  const tick = async (ms = 1000) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { f, wifi, tailscale, portal, portalFactory, service, tick };
}

describe('setupService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts hotspot with random password in NO_WIFI and opens portal', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    expect(s.service.getState().phase).toBe('NO_WIFI');
    expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
    const [ssid, pw] = s.wifi.startHotspot.mock.calls[0] as unknown as [string, string];
    expect(ssid).toBe('PhotoFrame-Setup');
    expect(pw).toMatch(/^[A-HJ-KM-NP-Za-km-z2-9]{10}$/);
    expect(s.service.getState().hotspot).toEqual({ ssid, password: pw });
    expect(s.portalFactory).toHaveBeenCalledTimes(1);
    await s.tick(5000);
    expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
    expect(s.service.getState().hotspot?.password).toBe(pw);
    s.service.stop();
  });

  it('does not start hotspot during startup grace', async () => {
    const s = setup({ grace: 60000 });
    s.service.start();
    await s.tick(30000);
    expect(s.service.getState().phase).toBe('NO_WIFI');
    expect(s.service.getState().hotspot).toBeUndefined();
    expect(s.wifi.startHotspot).not.toHaveBeenCalled();
    await s.tick(31000);
    expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
    s.service.stop();
  });

  it('stops hotspot and portal when leaving NO_WIFI', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    s.f.wifiUp = true;
    await s.tick();
    expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
    expect(s.portal.close).toHaveBeenCalledTimes(1);
    expect(s.service.getState().hotspot).toBeUndefined();
    expect(s.service.getState().phase).toBe('NO_TAILSCALE');
    s.service.stop();
  });

  it('uses a new password for a new hotspot session', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    const first = s.service.getState().hotspot!.password;
    s.f.wifiUp = true;
    await s.tick();
    s.f.wifiUp = false;
    await s.tick();
    const second = s.service.getState().hotspot?.password;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    s.service.stop();
  });

  it('submitWifi failure sets lastError and restarts hotspot with same password', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    const pw = s.service.getState().hotspot!.password;
    s.f.connectError = new Error('Could not join that WiFi network');
    await s.service.submitWifi('Home', 'secret-pass', false);
    expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
    expect(s.wifi.connect).toHaveBeenCalledWith('Home', 'secret-pass', false);
    expect(s.wifi.startHotspot).toHaveBeenCalledTimes(2);
    expect(s.wifi.startHotspot).toHaveBeenLastCalledWith('PhotoFrame-Setup', pw);
    const state = s.service.getState();
    expect(state.lastError).toBe('Could not join that WiFi network');
    expect(state.hotspot?.password).toBe(pw);
    expect(JSON.stringify(state)).not.toContain('secret-pass');
    s.service.stop();
  });

  it('submitWifi success clears lastError', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    s.f.connectError = new Error('bad');
    await s.service.submitWifi('Home', 'x', false);
    expect(s.service.getState().lastError).toBe('bad');
    s.f.connectError = null;
    await s.service.submitWifi('Home', 'x', false);
    expect(s.service.getState().lastError).toBeUndefined();
    s.service.stop();
  });

  it('fetches tailscale login URL once on entering NO_TAILSCALE and clears it after', async () => {
    const s = setup();
    s.f.wifiUp = true;
    s.service.start();
    await s.tick();
    await s.tick();
    await s.tick(3000);
    expect(s.service.getState().phase).toBe('NO_TAILSCALE');
    expect(s.tailscale.startLogin).toHaveBeenCalledTimes(1);
    expect(s.service.getState().tailscaleLoginUrl).toBe('https://login.tailscale.com/a/abc');
    s.f.tsLoggedIn = true;
    await s.tick();
    const st = s.service.getState();
    expect(st.phase).toBe('READY');
    expect(st.tailscaleLoginUrl).toBeUndefined();
    expect(st.addresses).toEqual({ mdns: 'photoframe.local', tailnet: '100.1.2.3' });
    s.service.stop();
  });

  it('retries a failed tailscale login no more than once per 15s', async () => {
    const s = setup();
    s.f.wifiUp = true;
    s.tailscale.startLogin.mockRejectedValue(new Error('boom'));
    s.service.start();
    await s.tick();
    await s.tick(5000);
    expect(s.tailscale.startLogin).toHaveBeenCalledTimes(1);
    expect(s.service.getState().lastError).toBe('Could not get a Tailscale login link yet');
    await s.tick(11000);
    expect(s.tailscale.startLogin).toHaveBeenCalledTimes(2);
    s.service.stop();
  });

  it('survives adapter failures', async () => {
    const s = setup();
    s.wifi.isConnected.mockRejectedValue(new Error('no nmcli'));
    s.service.start();
    await s.tick();
    await s.tick();
    expect(s.service.getState().phase).toBe('NO_WIFI');
    s.service.stop();
  });

  it('stop clears timers and closes portal', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    s.service.stop();
    expect(s.portal.close).toHaveBeenCalled();
    const calls = s.wifi.isConnected.mock.calls.length;
    await s.tick(10000);
    expect(s.wifi.isConnected.mock.calls.length).toBe(calls);
  });
});
