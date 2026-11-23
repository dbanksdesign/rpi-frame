import { describe, it, expect } from 'vitest'
import { adminUrl } from './adminUrl'

describe('adminUrl', () => {
  const base = { mdns: 'photoframe.local', lan: '192.168.1.20', tailnet: '100.1.2.3' }
  it('omits the port when the admin is on 80', () => {
    const a = { ...base, adminPort: 80 as const }
    expect(adminUrl(a, 'mdns')).toBe('http://photoframe.local')
    expect(adminUrl(a, 'lan')).toBe('http://192.168.1.20')
    expect(adminUrl(a, 'tailnet')).toBe('http://100.1.2.3')
  })
  it('appends :3000 only when adminPort is 3000', () => {
    const a = { ...base, adminPort: 3000 as const }
    expect(adminUrl(a, 'lan')).toBe('http://192.168.1.20:3000')
    expect(adminUrl(a, 'mdns')).toBe('http://photoframe.local:3000')
  })
  it('returns undefined for a missing lan or tailnet', () => {
    const a = { mdns: 'photoframe.local', adminPort: 80 as const }
    expect(adminUrl(a, 'lan')).toBeUndefined()
    expect(adminUrl(a, 'tailnet')).toBeUndefined()
  })
})
