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
  // A poll in flight, and a FIFO chain of submits. Submits wait for the poll and
  // for earlier submits; polls skip while any submit is pending.
  let polling: Promise<void> | null = null;
  let pendingSubmits = 0;
  let submitChain: Promise<void> = Promise.resolve();

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
      return wifi.scan().catch((err) => {
        logFailure('wifi.scan', err);
        return [];
      });
    },

    submitWifi(ssid, password, hidden) {
      pendingSubmits++;
      const job = submitChain.then(async () => {
        if (polling) await polling;
        await doSubmit(ssid, password, hidden);
      });
      submitChain = job.catch(() => {});
      return job.finally(() => {
        pendingSubmits--;
      });
    },
  };

  async function doSubmit(ssid: string, password: string | null, hidden?: boolean) {
    await stopHotspot(false);
    try {
      await wifi.connect(ssid, password, hidden);
      lastError = undefined;
    } catch (err) {
      logFailure('wifi.connect', err);
      lastError = err instanceof Error ? err.message : 'Could not join that WiFi network';
      // Same password so the screen stays valid; saved networks are untouched.
      await startHotspot();
    }
  }

  function logFailure(what: string, err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[setup] ${what} failed: ${msg.replace(/\s+/g, ' ')}`);
  }

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
      logFailure('wifi.startHotspot', err);
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
    } catch (err) {
      logFailure('wifi.stopHotspot', err);
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
      .catch((err) => {
        logFailure('tailscale.startLogin', err);
        lastError = 'Could not get a Tailscale login link yet';
      })
      .finally(() => {
        tailscaleInFlight = false;
      });
  }

  function poll(): Promise<void> {
    if (polling || pendingSubmits > 0) return Promise.resolve();
    const p = runPoll().finally(() => {
      polling = null;
    });
    polling = p;
    return p;
  }

  async function runPoll() {
    try {
      const wifiUp = await wifi.isConnected().catch((err) => {
        logFailure('wifi.isConnected', err);
        return false;
      });
      if (wifiUp) wifiDownSince = null;
      else if (wifiDownSince === null) wifiDownSince = now();

      const internet = wifiUp
        ? await hasInternet().catch((err) => {
            logFailure('hasInternet', err);
            return false;
          })
        : false;
      type TsStatus = Awaited<ReturnType<TailscaleClient['status']>>;
      const ts: TsStatus = wifiUp
        ? await tailscale.status().catch((err): TsStatus => {
            logFailure('tailscale.status', err);
            return { loggedIn: false };
          })
        : { loggedIn: false };
      tailnet = ts.loggedIn ? (ts.tailnetIp ?? ts.hostname) : undefined;

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
    } catch (err) {
      logFailure('poll', err);
    }
  }

  return service;
}
