import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';
import { pickLanAddress } from './lanAddress';

function iface(address: string, over: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24`, ...over } as NetworkInterfaceInfo;
}

describe('pickLanAddress', () => {
  it('returns undefined when nothing qualifies', () => {
    expect(pickLanAddress({})).toBeUndefined();
    expect(pickLanAddress({ lo: [iface('127.0.0.1', { internal: true })] })).toBeUndefined();
  });

  it('skips loopback, tailscale, docker, link-local, CGNAT and hotspot addresses', () => {
    const ifs = {
      lo: [iface('127.0.0.1', { internal: true })],
      tailscale0: [iface('192.168.9.9')],
      docker0: [iface('172.17.0.1')],
      veth1: [iface('172.18.0.2')],
      'br-abc': [iface('172.19.0.1')],
      wlan0: [iface('169.254.3.4')],
      wlan1: [iface('100.101.102.103')],
      wlan2: [iface('10.42.0.1')],
      eth9: [iface('fe80::1', { family: 'IPv6' })],
    };
    expect(pickLanAddress(ifs)).toBeUndefined();
  });

  it('skips a caller-supplied hotspot ip', () => {
    expect(pickLanAddress({ wlan0: [iface('10.5.5.1')] }, { hotspotIp: '10.5.5.1' })).toBeUndefined();
  });

  it('prefers wlan/eth/end/enp interfaces over others', () => {
    const ifs = { foo0: [iface('192.168.1.50')], wlan0: [iface('192.168.1.20')] };
    expect(pickLanAddress(ifs)).toBe('192.168.1.20');
    expect(pickLanAddress({ foo0: [iface('192.168.1.50')], enp3s0: [iface('192.168.1.7')] })).toBe('192.168.1.7');
  });

  it('falls back to another interface when no preferred one qualifies', () => {
    expect(pickLanAddress({ foo0: [iface('192.168.1.50')] })).toBe('192.168.1.50');
  });
});
