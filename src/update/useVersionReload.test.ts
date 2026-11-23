import { describe, it, expect } from 'vitest'
import { shouldReload } from './useVersionReload'

describe('shouldReload', () => {
  it('false when either value is null', () => {
    expect(shouldReload(null, 'v1')).toBe(false)
    expect(shouldReload('v1', null)).toBe(false)
    expect(shouldReload(null, null)).toBe(false)
  })
  it('false for dev or empty on either side', () => {
    expect(shouldReload('dev', 'v1')).toBe(false)
    expect(shouldReload('v1', 'dev')).toBe(false)
    expect(shouldReload('', 'v1')).toBe(false)
    expect(shouldReload('v1', '')).toBe(false)
  })
  it('false when same', () => {
    expect(shouldReload('v1.0.0', 'v1.0.0')).toBe(false)
  })
  it('true when different real versions', () => {
    expect(shouldReload('v1.0.0', 'v1.1.0')).toBe(true)
  })
})
