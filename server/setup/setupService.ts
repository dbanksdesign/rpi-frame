import crypto from 'crypto';
import os from 'os';
import { pickLanAddress } from './lanAddress';
import type { WifiManager, WifiNetwork } from './nmcli';
import type { TailscaleClient } from './tailscale';
import { nextPhase } from './stateMachine';
import type { SetupPhase, SetupState } from './types';

export const HOTSPOT_SSID = 'PhotoFrame-Setup';
const DEFAULT_MDNS_HOST = 'photoframe';
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 10;
const TAILSCALE_RETRY_MS = 15_000;
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_SAVED_NETWORK_GRACE_MS = 5 * 60_000;
const DEFAULT_RETRY_EVERY_MS = 5 * 60_000;
const DEFAULT_RETRY_WAIT_MS = 45_000;

export interface SetupService {
  start(): void;
  stop(): void;
  /** True while the setup hotspot is up; the port-80 portal middleware follows this. */
  isHotspotUp(): boolean;
  /** False until the first poll has completed (the phase is only a guess before that). */
  hasPolled(): boolean;
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
  /** Startup grace when a saved WiFi profile exists but there are no photos (default 5 min). */
  savedNetworkGraceMs?: number;
  /** While the hotspot is up and a saved WiFi exists, drop it this often to let NetworkManager retry (default 5 min). */
  retryEveryMs?: number;
  /** How long each retry waits for the saved WiFi before the hotspot returns (default 45 s). */
  retryWaitMs?: number;
  /** Current LAN IPv4, evaluated on every getState(). Defaults to the host's interfaces. */
  getLanAddress?: () => string | undefined;
  /** Port the main app is actually reachable on (80 once the port-80 bind succeeds). */
  getAdminPort?: () => 80 | 3000;
  /** Host name for the <name>.local address (default: os.hostname()). */
  getHostname?: () => string;
}

/** `<first label of the host name>.local`, lower-case; photoframe.local if unknown. */
export function mdnsName(hostname: string): string {
  const label = hostname.trim().toLowerCase().split('.')[0];
  return `${/^[a-z0-9][a-z0-9-]*$/.test(label) ? label : DEFAULT_MDNS_HOST}.local`;
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
  let graceMs = deps.startupGraceMs ?? DEFAULT_GRACE_MS;
  const savedNetworkGraceMs = deps.savedNetworkGraceMs ?? DEFAULT_SAVED_NETWORK_GRACE_MS;
  const retryEveryMs = deps.retryEveryMs ?? DEFAULT_RETRY_EVERY_MS;
  const retryWaitMs = deps.retryWaitMs ?? DEFAULT_RETRY_WAIT_MS;

  let timer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  let phase: SetupPhase = 'NO_WIFI';
  let showOfflineBanner = false;
  let wifiDownSince: number | null = null;
  let tailnet: string | undefined;
  let lastError: string | undefined;
  // Boot check (first poll): a saved WiFi profile means this frame was set up
  // before, so a missing network is most likely a router still coming back.
  let bootChecked = false;
  // READY assumed at boot (saved WiFi + photos, offline) but never confirmed:
  // once online, the phase is worked out as on a fresh start.
  let assumedReady = false;
  let hotspotSince = 0;
  let polledOnce = false;

  let sessionPassword: string | null = null;
  let hotspotUp = false;
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
      bootChecked = false;
      void poll();
      timer = setInterval(() => void poll(), pollMs);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      hotspotUp = false;
    },

    isHotspotUp() {
      return hotspotUp;
    },

    hasPolled() {
      return polledOnce;
    },

    getState() {
      const lan = getLan();
      const state: SetupState = {
        phase,
        showOfflineBanner,
        addresses: {
          mdns: mdnsName(getHostname()),
          ...(lan ? { lan } : {}),
          ...(tailnet ? { tailnet } : {}),
          adminPort: deps.getAdminPort?.() ?? 3000,
        },
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

  function getHostname(): string {
    try {
      return deps.getHostname ? deps.getHostname() : os.hostname();
    } catch {
      return '';
    }
  }

  function getLan(): string | undefined {
    try {
      return deps.getLanAddress ? deps.getLanAddress() : pickLanAddress(os.networkInterfaces());
    } catch {
      return undefined;
    }
  }

  async function startHotspot() {
    if (!sessionPassword) sessionPassword = generatePassword();
    try {
      await wifi.startHotspot(HOTSPOT_SSID, sessionPassword);
      hotspotUp = true;
      hotspotSince = now();
    } catch (err) {
      logFailure('wifi.startHotspot', err);
      lastError = err instanceof Error ? err.message : 'Could not start the setup hotspot';
    }
  }

  /** endSession: forget the password so the next hotspot gets a fresh one. */
  async function stopHotspot(endSession: boolean) {
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

  async function savedNetwork(): Promise<boolean> {
    return wifi.hasSavedNetwork().catch((err) => {
      logFailure('wifi.hasSavedNetwork', err);
      return false;
    });
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * In AP mode NetworkManager stops trying saved profiles, so after a long
   * router outage the hotspot would stay up for good. Drop it for up to
   * retryWaitMs so NetworkManager can autoconnect; if that fails, bring it
   * back with the same session password (the screen and QR stay valid).
   */
  async function retrySavedNetwork() {
    if (pendingSubmits > 0 || !timer) return;
    if (!(await savedNetwork())) return;
    if (pendingSubmits > 0 || !timer) return;
    console.log(`[setup] retrying the saved WiFi: hotspot off for up to ${Math.round(retryWaitMs / 1000)} s`);
    await stopHotspot(false);
    const deadline = now() + retryWaitMs;
    let online = false;
    while (timer) {
      online = await wifi.isConnected().catch(() => false);
      if (online || now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    if (online) {
      wifiDownSince = null;
    } else if (timer && phase === 'NO_WIFI') {
      await startHotspot();
    }
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
      // "Online": WiFi or an Ethernet cable (never the setup hotspot itself).
      const wifiUp = await wifi.isConnected().catch((err) => {
        logFailure('wifi.isConnected', err);
        return false;
      });
      if (!bootChecked) {
        bootChecked = true;
        if (await savedNetwork()) {
          if (hasPhotos() && !wifiUp) {
            // After a power cut the router may take minutes: keep the slideshow
            // (with the banner) and let the 30-minute rule decide, from now.
            phase = 'READY';
            assumedReady = true;
          } else if (!hasPhotos()) {
            graceMs = Math.max(graceMs, savedNetworkGraceMs);
          }
        }
      }
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

      const current: SetupPhase = assumedReady && wifiUp ? 'NO_WIFI' : phase;
      if (wifiUp || phase !== 'READY') assumedReady = false;
      const result = nextPhase({
        current,
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
        else if (hotspotUp && now() - hotspotSince >= retryEveryMs) await retrySavedNetwork();
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
    } finally {
      polledOnce = true;
    }
  }

  return service;
}
