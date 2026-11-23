export interface WifiRequest {
  ssid: string;
  password: string | null;
  hidden: boolean;
}

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
