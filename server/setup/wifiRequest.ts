export interface WifiRequest {
  ssid: string;
  password: string | null;
  hidden: boolean;
}

/**
 * Setup is active while the hotspot is up or the phase is NO_WIFI. Outside it,
 * /wifi and /networks are refused (409): otherwise any LAN/tailnet client, or
 * any website via CORS, could repoint the frame's WiFi or knock it offline.
 */
export function isSetupActive(service: { isHotspotUp(): boolean; hasPolled(): boolean; getState(): { phase: string } }): boolean {
  // Before the first poll the phase is only the initial guess (NO_WIFI).
  return service.isHotspotUp() || (service.hasPolled() && service.getState().phase === 'NO_WIFI');
}

export const SETUP_INACTIVE = { error: 'Setup is not active' } as const;

/** Validates a POST /wifi body. Returns null when invalid. */
export function parseWifiRequest(body: unknown): WifiRequest | null {
  if (!body || typeof body !== 'object') return null;
  const { ssid, password, hidden } = body as Record<string, unknown>;
  if (typeof ssid !== 'string' || ssid.length === 0 || Buffer.byteLength(ssid, 'utf8') > 32) return null;
  if (password !== undefined && password !== null) {
    if (typeof password !== 'string' || password.length > 63) return null;
  }
  return {
    ssid,
    password: typeof password === 'string' && password !== '' ? password : null,
    hidden: hidden === true,
  };
}
