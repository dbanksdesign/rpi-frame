import type { NetworkInterfaceInfo } from 'os';

const HOTSPOT_GATEWAY = '10.42.0.1';
const SKIPPED_NAMES = [/^tailscale0$/, /^docker/, /^veth/, /^br-/];
const PREFERRED_NAMES = [/^wlan/, /^eth/, /^end/, /^enp/];

function isSkippedAddress(ip: string, hotspotIp?: string): boolean {
  if (ip === HOTSPOT_GATEWAY || ip === hotspotIp) return true;
  const [a, b] = ip.split('.').map(Number);
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64.0.0/10
  return false;
}

/** The frame's current LAN IPv4, or undefined when it has none. */
export function pickLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  opts: { hotspotIp?: string } = {},
): string | undefined {
  let fallback: string | undefined;
  for (const [name, infos] of Object.entries(interfaces)) {
    if (SKIPPED_NAMES.some((re) => re.test(name))) continue;
    const found = (infos ?? []).find(
      (i) => i.family === 'IPv4' && !i.internal && !isSkippedAddress(i.address, opts.hotspotIp),
    );
    if (!found) continue;
    if (PREFERRED_NAMES.some((re) => re.test(name))) return found.address;
    fallback ??= found.address;
  }
  return fallback;
}
