import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSetupService } from './setupService';
import type { WifiManager } from './nmcli';
import type { TailscaleClient } from './tailscale';

function setup(opts: { grace?: number; savedGrace?: number; retryEveryMs?: number; retryWaitMs?: number } = {}) {
  let t = 1_000_000;
  const f = {
    wifiUp: false,
    tsLoggedIn: false,
    connectError: null as Error | null,
    internet: true,
    photos: false,
    saved: false,
  };
  const wifi = {
    scan: vi.fn(async () => []),
    connect: vi.fn(async () => {
      if (f.connectError) throw f.connectError;
    }),
    startHotspot: vi.fn(async () => {}),
    stopHotspot: vi.fn(async () => {}),
    isConnected: vi.fn(async () => f.wifiUp),
    hasSavedNetwork: vi.fn(async () => f.saved),
  } satisfies WifiManager;
  const tailscale = {
    status: vi.fn(async () => (f.tsLoggedIn ? { loggedIn: true, tailnetIp: '100.1.2.3' } : { loggedIn: false })),
    startLogin: vi.fn(async () => 'https://login.tailscale.com/a/abc'),
  } satisfies TailscaleClient;
  const lanFixture = { ip: '192.168.1.20' as string | undefined };
  const adminPort = { value: 80 as 80 | 3000 };
  const service = createSetupService({
    wifi,
    tailscale,
    now: () => t,
    hasPhotos: () => f.photos,
    hasInternet: async () => f.internet,
    pollMs: 1000,
    startupGraceMs: opts.grace ?? 0,
    savedNetworkGraceMs: opts.savedGrace,
    retryEveryMs: opts.retryEveryMs,
    retryWaitMs: opts.retryWaitMs,
    getLanAddress: () => lanFixture.ip,
    getAdminPort: () => adminPort.value,
  });
  const tick = async (ms = 1000) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  // Advance in 1 s steps so the clock and the timers stay in step.
  const advance = async (ms: number) => {
    for (let done = 0; done < ms; done += 1000) await tick(1000);
  };
  return { f, wifi, tailscale, lanFixture, adminPort, service, tick, advance };
}

describe('setupService', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    errSpy.mockRestore();
  });

  it('starts hotspot with random password in NO_WIFI and the portal goes live', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    expect(s.service.getState().phase).toBe('NO_WIFI');
    expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
    const [ssid, pw] = s.wifi.startHotspot.mock.calls[0] as unknown as [string, string];
    expect(ssid).toBe('PhotoFrame-Setup');
    expect(pw).toMatch(/^[A-HJ-KM-NP-Za-km-z2-9]{10}$/);
    expect(s.service.getState().hotspot).toEqual({ ssid, password: pw });
    expect(s.service.isHotspotUp()).toBe(true);
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

  it('never starts the hotspot while online (e.g. Ethernet: isConnected() is true)', async () => {
    const s = setup();
    s.f.wifiUp = true;
    s.service.start();
    await s.tick(120_000);
    expect(s.wifi.startHotspot).not.toHaveBeenCalled();
    expect(s.service.getState().hotspot).toBeUndefined();
    expect(s.service.getState().phase).not.toBe('NO_WIFI');
    s.service.stop();
  });

  it('stops hotspot and portal when leaving NO_WIFI', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    s.f.wifiUp = true;
    await s.tick();
    expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
    expect(s.service.isHotspotUp()).toBe(false);
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
    expect(st.addresses).toEqual({ mdns: 'photoframe.local', tailnet: '100.1.2.3', lan: '192.168.1.20', adminPort: 80 });
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

  it('does not drop a submit that arrives mid-poll; submits run in order after the poll', async () => {
    const s = setup();
    let release!: (v: boolean) => void;
    s.wifi.isConnected.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    s.service.start(); // first poll is held on isConnected
    const p1 = s.service.submitWifi('First', 'pw1', false);
    const p2 = s.service.submitWifi('Second', 'pw2', false);
    await Promise.resolve();
    expect(s.wifi.connect).not.toHaveBeenCalled();
    release(false);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    await p2;
    expect(s.wifi.connect).toHaveBeenNthCalledWith(1, 'First', 'pw1', false);
    expect(s.wifi.connect).toHaveBeenNthCalledWith(2, 'Second', 'pw2', false);
    s.service.stop();
  });

  it('polls skip while a submit is pending', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    let release!: () => void;
    s.wifi.connect.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const p = s.service.submitWifi('Home', 'pw', false);
    await vi.advanceTimersByTimeAsync(0);
    const calls = s.wifi.isConnected.mock.calls.length;
    await s.tick(5000);
    expect(s.wifi.isConnected.mock.calls.length).toBe(calls);
    release();
    await p;
    s.service.stop();
  });

  it('logs one line with adapter name and message per failure', async () => {
    const lineFor = (name: string) => errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(name));

    const a = setup();
    a.wifi.isConnected.mockRejectedValueOnce(new Error('isc boom'));
    a.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy.mock.calls.every((c) => c.length === 1)).toBe(true);
    expect(lineFor('wifi.isConnected')).toHaveLength(1);
    expect(lineFor('wifi.isConnected')[0]).toContain('isc boom');
    a.service.stop();

    errSpy.mockClear();
    const b = setup();
    b.wifi.startHotspot.mockRejectedValueOnce(new Error('hs boom'));
    b.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lineFor('wifi.startHotspot')).toHaveLength(1);
    expect(lineFor('wifi.startHotspot')[0]).toContain('hs boom');
    b.service.stop();

    errSpy.mockClear();
    const c = setup();
    c.f.wifiUp = true;
    c.tailscale.status.mockRejectedValueOnce(new Error('st boom'));
    c.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lineFor('tailscale.status')).toHaveLength(1);
    expect(lineFor('tailscale.status')[0]).toContain('st boom');
    c.service.stop();

    errSpy.mockClear();
    const d = setup();
    d.f.wifiUp = true;
    d.tailscale.startLogin.mockRejectedValueOnce(new Error('tl boom'));
    d.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lineFor('tailscale.startLogin')).toHaveLength(1);
    expect(lineFor('tailscale.startLogin')[0]).toContain('tl boom');
    d.service.stop();

    errSpy.mockClear();
    const e = setup();
    e.wifi.scan.mockRejectedValueOnce(new Error('scan boom'));
    expect(await e.service.scanNetworks()).toEqual([]);
    expect(lineFor('wifi.scan')).toHaveLength(1);
    expect(lineFor('wifi.scan')[0]).toContain('scan boom');

    errSpy.mockClear();
    const g = setup();
    g.f.wifiUp = true;
    const hi = vi.fn(async () => {
      throw new Error('net boom');
    });
    const svc = createSetupService({
      wifi: g.wifi, tailscale: g.tailscale, now: () => 0, hasPhotos: () => false, hasInternet: hi, pollMs: 1000, startupGraceMs: 0,
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lineFor('hasInternet')).toHaveLength(1);
    expect(lineFor('hasInternet')[0]).toContain('net boom');
    svc.stop();
  });

  it('never logs the typed password', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    s.f.connectError = new Error('Could not join that WiFi network');
    await s.service.submitWifi('Home', 'hunter2-typed', false);
    for (const c of errSpy.mock.calls) expect(String(c[0])).not.toContain('hunter2-typed');
    s.service.stop();
  });

  it('stop clears timers and closes portal', async () => {
    const s = setup();
    s.service.start();
    await s.tick();
    expect(s.service.isHotspotUp()).toBe(true);
    s.service.stop();
    expect(s.service.isHotspotUp()).toBe(false);
    const calls = s.wifi.isConnected.mock.calls.length;
    await s.tick(10000);
    expect(s.wifi.isConnected.mock.calls.length).toBe(calls);
  });

  describe('after a power cut (saved WiFi profile, router still down)', () => {
    it('boots into READY + banner when photos exist; NO_WIFI and hotspot only after 30 min', async () => {
      const s = setup({ grace: 60_000 });
      s.f.saved = true;
      s.f.photos = true;
      s.service.start();
      await s.tick();
      expect(s.service.getState()).toMatchObject({ phase: 'READY', showOfflineBanner: true });
      await s.advance(28 * 60_000);
      expect(s.service.getState().phase).toBe('READY');
      expect(s.wifi.startHotspot).not.toHaveBeenCalled();
      await s.advance(3 * 60_000);
      expect(s.service.getState().phase).toBe('NO_WIFI');
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
      expect(s.wifi.hasSavedNetwork).toHaveBeenCalled();
      s.service.stop();
    });

    it('boots with photos and the router back: normal flow (Tailscale screen if logged out)', async () => {
      const s = setup();
      s.f.saved = true;
      s.f.photos = true;
      s.service.start();
      await s.tick();
      expect(s.service.getState().phase).toBe('READY');
      s.f.wifiUp = true;
      await s.tick();
      expect(s.service.getState()).toMatchObject({ phase: 'NO_TAILSCALE', showOfflineBanner: false });
      s.f.tsLoggedIn = true;
      await s.tick();
      expect(s.service.getState().phase).toBe('READY');
      s.service.stop();
    });

    it('with a saved network but no photos the hotspot waits 5 minutes, not 60 s', async () => {
      const s = setup({ grace: 60_000 });
      s.f.saved = true;
      s.service.start();
      await s.advance(4 * 60_000 + 50_000);
      expect(s.service.getState().phase).toBe('NO_WIFI');
      expect(s.wifi.startHotspot).not.toHaveBeenCalled();
      await s.advance(15_000);
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
      s.service.stop();
    });

    it('without a saved network nothing changes: hotspot after the 60 s grace, no retries', async () => {
      const s = setup({ grace: 60_000 });
      s.f.photos = true;
      s.service.start();
      await s.advance(59_000);
      expect(s.wifi.startHotspot).not.toHaveBeenCalled();
      expect(s.service.getState().phase).toBe('NO_WIFI');
      await s.advance(2_000);
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
      await s.advance(12 * 60_000);
      expect(s.wifi.stopHotspot).not.toHaveBeenCalled();
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
      s.service.stop();
    });
  });

  describe('hotspot retry while a saved network exists', () => {
    it('drops the hotspot every 5 minutes; when the saved WiFi joins, the phase leaves NO_WIFI', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const s = setup({ savedGrace: 0 });
      s.f.saved = true;
      s.service.start();
      await s.tick();
      expect(s.service.isHotspotUp()).toBe(true);
      await s.advance(4 * 60_000);
      expect(s.wifi.stopHotspot).not.toHaveBeenCalled();
      await s.advance(61_000);
      expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
      expect(s.service.isHotspotUp()).toBe(false);
      expect(s.service.getState().hotspot).toBeUndefined();
      expect(logSpy.mock.calls.filter((c) => String(c[0]).includes('[setup] retrying the saved WiFi'))).toHaveLength(1);
      s.f.wifiUp = true; // the router is back: NetworkManager autoconnects
      await s.advance(3_000);
      expect(s.service.getState().phase).toBe('NO_TAILSCALE');
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(1);
      expect(s.service.isHotspotUp()).toBe(false);
      logSpy.mockRestore();
      s.service.stop();
    });

    it('a failed retry restores the hotspot after ~45 s with the SAME password', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const s = setup({ savedGrace: 0 });
      s.f.saved = true;
      s.service.start();
      await s.tick();
      const pw = s.service.getState().hotspot!.password;
      await s.advance(5 * 60_000 + 1_000);
      expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
      expect(s.service.isHotspotUp()).toBe(false);
      await s.advance(40_000);
      expect(s.service.isHotspotUp()).toBe(false);
      await s.advance(8_000);
      expect(s.service.isHotspotUp()).toBe(true);
      expect(s.wifi.startHotspot).toHaveBeenCalledTimes(2);
      expect(s.wifi.startHotspot).toHaveBeenLastCalledWith('PhotoFrame-Setup', pw);
      expect(s.service.getState().hotspot?.password).toBe(pw);
      expect(s.service.getState().phase).toBe('NO_WIFI');
      // and it tries again 5 minutes later
      await s.advance(5 * 60_000 + 1_000);
      expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(2);
      logSpy.mockRestore();
      s.service.stop();
    });

    it('never retries while a portal submit is pending', async () => {
      const s = setup({ savedGrace: 0 });
      s.f.saved = true;
      s.service.start();
      await s.tick();
      let release!: () => void;
      s.wifi.connect.mockImplementationOnce(() => new Promise<void>((_r, rej) => (release = () => rej(new Error('bad')))));
      const p = s.service.submitWifi('Home', 'pw', false);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1); // the submit's own stop
      await s.advance(6 * 60_000);
      expect(s.wifi.stopHotspot).toHaveBeenCalledTimes(1);
      release();
      await p;
      expect(s.service.isHotspotUp()).toBe(true);
      s.service.stop();
    });

    it('no retry without a saved network', async () => {
      const s = setup();
      s.service.start();
      await s.tick();
      await s.advance(11 * 60_000);
      expect(s.wifi.stopHotspot).not.toHaveBeenCalled();
      expect(s.service.isHotspotUp()).toBe(true);
      s.service.stop();
    });
  });

  it('reports the current LAN address and admin port, recomputed on every getState', () => {
    const s = setup();
    expect(s.service.getState().addresses).toEqual({ mdns: 'photoframe.local', lan: '192.168.1.20', adminPort: 80 });
    s.lanFixture.ip = '192.168.1.99';
    s.adminPort.value = 3000;
    expect(s.service.getState().addresses).toMatchObject({ lan: '192.168.1.99', adminPort: 3000 });
    s.lanFixture.ip = undefined;
    expect(s.service.getState().addresses.lan).toBeUndefined();
  });
});
