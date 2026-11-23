import type { SetupState } from './types'

export type Screen = 'wifi-instructions' | 'tailscale-login' | 'ready-card' | 'slideshow'

/**
 * readyCardShown: true when the READY card was already shown or does not apply
 * (first observed phase was READY); false only after a non-READY phase was observed.
 */
export function screenFor(state: SetupState, readyCardShown: boolean): Screen {
  switch (state.phase) {
    case 'NO_WIFI':
      return 'wifi-instructions'
    case 'NO_TAILSCALE':
      return 'tailscale-login'
    default:
      return readyCardShown ? 'slideshow' : 'ready-card'
  }
}
