export type SetupPhase = 'NO_WIFI' | 'NO_TAILSCALE' | 'READY';

export interface NextPhaseInput {
  current: SetupPhase;
  wifiUp: boolean;
  internet: boolean;
  tailscaleLoggedIn: boolean;
  minutesWithoutWifi: number;
  hasPhotos: boolean;
}
