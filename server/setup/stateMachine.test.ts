import { describe, it, expect } from 'vitest';
import { nextPhase, WIFI_LOSS_MINUTES } from './stateMachine';
import type { NextPhaseInput, SetupPhase } from './types';

const base: NextPhaseInput = {
  current: 'NO_WIFI',
  wifiUp: false,
  internet: false,
  tailscaleLoggedIn: false,
  minutesWithoutWifi: 0,
  hasPhotos: false,
};

const cases: Array<[string, Partial<NextPhaseInput>, SetupPhase, boolean]> = [
  ['fresh boot, nothing up', {}, 'NO_WIFI', false],
  ['wifi+internet, not logged in', { wifiUp: true, internet: true }, 'NO_TAILSCALE', false],
  ['wifi + logged in', { wifiUp: true, internet: true, tailscaleLoggedIn: true }, 'READY', false],
  ['ready, wifi up, tailscale lost', { current: 'READY', wifiUp: true, internet: true }, 'READY', false],
  ['ready, wifi down 10 min, photos', { current: 'READY', minutesWithoutWifi: 10, hasPhotos: true }, 'READY', true],
  ['ready, wifi down 29 min, photos', { current: 'READY', minutesWithoutWifi: 29, hasPhotos: true }, 'READY', true],
  ['ready, wifi down 30 min, photos', { current: 'READY', minutesWithoutWifi: 30, hasPhotos: true }, 'NO_WIFI', false],
  ['ready, wifi down, no photos', { current: 'READY', minutesWithoutWifi: 5 }, 'NO_WIFI', false],
  ['not ready, wifi down, photos', { current: 'NO_TAILSCALE', minutesWithoutWifi: 5, hasPhotos: true }, 'NO_WIFI', false],
  ['wifi up, no internet, not logged in', { wifiUp: true }, 'NO_TAILSCALE', false],
];

describe('nextPhase', () => {
  it('exports a 30 minute threshold', () => {
    expect(WIFI_LOSS_MINUTES).toBe(30);
  });

  it.each(cases)('%s', (_name, override, phase, showOfflineBanner) => {
    expect(nextPhase({ ...base, ...override })).toEqual({ phase, showOfflineBanner });
  });
});
