import type { SetupState } from './types'

/** URL of the admin page for one of the frame's addresses; ":3000" only when port 80 is unavailable. */
export function adminUrl(addresses: SetupState['addresses'], host: 'mdns' | 'lan' | 'tailnet'): string | undefined {
  const name = addresses[host]
  if (!name) return undefined
  return `http://${name}${addresses.adminPort === 3000 ? ':3000' : ''}`
}
