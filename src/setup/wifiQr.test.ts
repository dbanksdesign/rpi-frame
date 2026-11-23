import { describe, it, expect } from 'vitest'
import { escapeWifiField, wifiQrPayload } from './wifiQr'

describe('wifiQr', () => {
  it('leaves plain text alone', () => {
    expect(escapeWifiField('Frame-Setup1')).toBe('Frame-Setup1')
  })
  it('escapes backslash, semicolon, comma, colon and quote', () => {
    expect(escapeWifiField('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f')
  })
  it('builds the payload', () => {
    expect(wifiQrPayload('My;Net', 'p:w')).toBe('WIFI:T:WPA;S:My\\;Net;P:p\\:w;;')
  })
})
