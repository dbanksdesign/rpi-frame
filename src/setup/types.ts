// Mirrors server/setup/types.ts (kept separate on purpose; do not import server code).
export type SetupPhase = 'NO_WIFI' | 'NO_TAILSCALE' | 'READY'

export interface SetupState {
  phase: SetupPhase
  showOfflineBanner: boolean
  hotspot?: { ssid: string; password: string }
  tailscaleLoginUrl?: string
  lastError?: string
  addresses: { mdns: string; tailnet?: string; lan?: string; adminPort: 80 | 3000 }
}
