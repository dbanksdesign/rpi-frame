export type SetupPhase = 'NO_WIFI' | 'NO_TAILSCALE' | 'READY';

export interface NextPhaseInput {
  current: SetupPhase;
  wifiUp: boolean;
  internet: boolean;
  tailscaleLoggedIn: boolean;
  minutesWithoutWifi: number;
  hasPhotos: boolean;
}

export interface SetupState {
  phase: SetupPhase;
  showOfflineBanner: boolean;
  hotspot?: { ssid: string; password: string };
  tailscaleLoginUrl?: string;
  lastError?: string;
  addresses: { mdns: string; tailnet?: string; lan?: string; adminPort: 80 | 3000 };
}
