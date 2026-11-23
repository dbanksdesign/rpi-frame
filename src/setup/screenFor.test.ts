import { describe, it, expect } from 'vitest'
import { screenFor } from './screenFor'
import type { SetupState } from './types'

const base: SetupState = { phase: 'READY', showOfflineBanner: false, addresses: { mdns: 'photoframe.local' } }

describe('screenFor', () => {
  it('NO_WIFI -> wifi-instructions', () => {
    expect(screenFor({ ...base, phase: 'NO_WIFI' }, false)).toBe('wifi-instructions')
    expect(screenFor({ ...base, phase: 'NO_WIFI' }, true)).toBe('wifi-instructions')
  })
  it('NO_TAILSCALE -> tailscale-login', () => {
    expect(screenFor({ ...base, phase: 'NO_TAILSCALE' }, false)).toBe('tailscale-login')
  })
  it('READY and card not shown -> ready-card', () => {
    expect(screenFor(base, false)).toBe('ready-card')
  })
  it('READY and card shown -> slideshow', () => {
    expect(screenFor(base, true)).toBe('slideshow')
  })
})
