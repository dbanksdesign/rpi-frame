import type { NextPhaseInput, SetupPhase } from './types';

export const WIFI_LOSS_MINUTES = 30;

export function nextPhase(input: NextPhaseInput): { phase: SetupPhase; showOfflineBanner: boolean } {
  const { current, wifiUp, tailscaleLoggedIn, minutesWithoutWifi, hasPhotos } = input;

  if (wifiUp) {
    if (tailscaleLoggedIn || current === 'READY') {
      return { phase: 'READY', showOfflineBanner: false };
    }
    return { phase: 'NO_TAILSCALE', showOfflineBanner: false };
  }

  if (current === 'READY' && hasPhotos && minutesWithoutWifi < WIFI_LOSS_MINUTES) {
    return { phase: 'READY', showOfflineBanner: true };
  }
  return { phase: 'NO_WIFI', showOfflineBanner: false };
}
