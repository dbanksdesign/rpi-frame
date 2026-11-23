/** Escape characters special in the WiFi QR format: \ ; , : " */
export function escapeWifiField(value: string): string {
  return value.replace(/[\\;,:"]/g, (c) => `\\${c}`)
}

export function wifiQrPayload(ssid: string, password: string): string {
  return `WIFI:T:WPA;S:${escapeWifiField(ssid)};P:${escapeWifiField(password)};;`
}
