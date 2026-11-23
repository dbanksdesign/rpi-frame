import crypto from 'crypto';
import type { WifiManager, WifiNetwork } from './nmcli';
import type { TailscaleClient } from './tailscale';
import { nextPhase } from './stateMachine';
import type { SetupPhase, SetupState } from './types';

export const HOTSPOT_SSID = 'PhotoFrame-Setup';
const MDNS_ADDRESS = 'photoframe.local';
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 10;
const TAILSCALE_RETRY_MS = 15_000;
const DEFAULT_GRACE_MS = 60_000;

export interface PortalHandle {
  close(): void;
  port: number;
}

export interface SetupService {
  start(): void;
  stop(): void;
  getState(): SetupState;
  scanNetworks(): Promise<WifiNetwork[]>;
  submitWifi(ssid: string, password: string | null, hidden?: boolean): Promise<void>;
}

export interface SetupServiceDeps {
  wifi: WifiManager;
  tailscale: TailscaleClient;
  now: () => number;
  hasPhotos: () => boolean;
  pollMs?: number;
  hasInternet?: () => Promise<boolean>;
  startupGraceMs?: number;
  /** Opens the captive portal; called when the hotspot comes up. */
  portalFactory?: (service: SetupService) => PortalHandle;
}

async function defaultHasInternet(): Promise<boolean> {
  try {
    await fetch('https://controlplane.tailscale.com', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

function generatePassword(): string {
  const bytes = crypto.randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

export function createSetupService(deps: SetupServiceDeps): SetupService {
  const { wifi, tailscale, now, hasPhotos } = deps;
  const pollMs = deps.pollMs ?? 3000;
  const hasInternet = deps.hasInternet ?? defaultHasInternet;
  const graceMs = deps.startupGraceMs ?? DEFAULT_GRACE_MS;

  let timer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  let phase: SetupPhase = 'NO_WIFI';
  let showOfflineBanner = false;
  let wifiDownSince: number | null = null;
  let tailnet: string | undefined;
  let lastError: string | undefined;

  let sessionPassword: string | null = null;
  let hotspotUp = false;
  let portal: PortalHandle | null = null;
  let busy = false; // a poll or a wifi submit is mutating hotspot state

  let tailscaleUrl: string | undefined;
  let tailscaleInFlight = false;
  let tailscaleLastAttempt = -Infinity;

  const service: SetupService = {
    start() {
      if (timer) return;
      startedAt = now();
      void poll();
      timer = setInterval(() => void poll(), pollMs);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      closePortal();
    },

    getState() {
      const state: SetupState = {
        phase,
        showOfflineBanner,
        addresses: { mdns: MDNS_ADDRESS, ...(tailnet ? { tailnet } : {}) },
      };
      if (hotspotUp && sessionPassword) state.hotspot = { ssid: HOTSPOT_SSID, password: sessionPassword };
      if (tailscaleUrl) state.tailscaleLoginUrl = tailscaleUrl;
      if (lastError) state.lastError = lastError;
      return state;
    },

    scanNetworks() {
      return wifi.scan().catch(() => []);
    },

    async submitWifi(ssid, password, hidden) {
      if (busy) {
        lastError = 'The frame is busy, please try again';
        return;
      }
      busy = true;
      try {
        await stopHotspot(false);
        try {
          await wifi.connect(ssid, password, hidden);
          lastError = undefined;
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Could not join that WiFi network';
          // Same password so the screen stays valid; saved networks are untouched.
          await startHotspot();
        }
      } finally {
        busy = false;
      }
    },
  };

  function closePortal() {
    if (!portal) return;
    try {
      portal.close();
    } catch {
      /* ignore */
    }
    portal = null;
  }

  async function startHotspot() {
    if (!sessionPassword) sessionPassword = generatePassword();
    try {
      await wifi.startHotspot(HOTSPOT_SSID, sessionPassword);
      hotspotUp = true;
      if (!portal && deps.portalFactory) {
        try {
          portal = deps.portalFactory(service);
        } catch {
          console.error('[setup] could not open captive portal');
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Could not start the setup hotspot';
    }
  }

  /** endSession: forget the password so the next hotspot gets a fresh one. */
  async function stopHotspot(endSession: boolean) {
    closePortal();
    const wasUp = hotspotUp;
    hotspotUp = false;
    if (endSession) sessionPassword = null;
    if (!wasUp && !endSession) return;
    try {
      await wifi.stopHotspot();
    } catch {
      console.error('[setup] could not stop hotspot');
    }
  }

  function maybeStartTailscaleLogin() {
    if (tailscaleUrl || tailscaleInFlight) return;
    if (now() - tailscaleLastAttempt < TAILSCALE_RETRY_MS) return;
    tailscaleInFlight = true;
    tailscaleLastAttempt = now();
    tailscale
      .startLogin()
      .then((url) => {
        if (phase === 'NO_TAILSCALE') {
          tailscaleUrl = url;
          lastError = undefined;
        }
      })
      .catch(() => {
        lastError = 'Could not get a Tailscale login link yet';
      })
      .finally(() => {
        tailscaleInFlight = false;
      });
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const wifiUp = await wifi.isConnected().catch(() => false);
      if (wifiUp) wifiDownSince = null;
      else if (wifiDownSince === null) wifiDownSince = now();

      const internet = wifiUp ? await hasInternet().catch(() => false) : false;
      const ts = wifiUp
        ? await tailscale.status().catch(() => ({ loggedIn: false }) as { loggedIn: boolean; hostname?: string; tailnetIp?: string })
        : { loggedIn: false as const };
      tailnet = ts.loggedIn ? ((ts as { tailnetIp?: string }).tailnetIp ?? (ts as { hostname?: string }).hostname) : undefined;

      const result = nextPhase({
        current: phase,
        wifiUp,
        internet,
        tailscaleLoggedIn: ts.loggedIn,
        minutesWithoutWifi: wifiDownSince === null ? 0 : (now() - wifiDownSince) / 60_000,
        hasPhotos: hasPhotos(),
      });
      const previous = phase;
      phase = result.phase;
      showOfflineBanner = result.showOfflineBanner;

      if (phase === 'NO_WIFI') {
        const inGrace = now() - startedAt < graceMs;
        if (!hotspotUp && !inGrace) await startHotspot();
      } else if (hotspotUp || sessionPassword) {
        await stopHotspot(true);
      }

      if (phase === 'NO_TAILSCALE') {
        maybeStartTailscaleLogin();
      } else {
        if (previous === 'NO_TAILSCALE') tailscaleLastAttempt = -Infinity;
        tailscaleUrl = undefined;
      }
      if (phase === 'READY') lastError = undefined;
    } catch {
      console.error('[setup] poll failed');
    } finally {
      busy = false;
    }
  }

  return service;
}
