import type { Run } from './exec';

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
}

export interface WifiManager {
  scan(): Promise<WifiNetwork[]>;
  connect(ssid: string, password: string | null, hidden?: boolean): Promise<void>;
  startHotspot(ssid: string, password: string): Promise<void>;
  stopHotspot(): Promise<void>;
  isConnected(): Promise<boolean>;
}

const HOTSPOT_CONNECTION = 'Hotspot';

/** Split a terse nmcli line on unescaped colons, un-escaping `\:` and `\\`. */
function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === ':') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function createWifiManager(run: Run): WifiManager {
  return {
    async scan() {
      const { stdout } = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']);
      const best = new Map<string, WifiNetwork>();
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const [ssid, sig, security = ''] = splitTerse(line);
        if (!ssid) continue;
        const signal = parseInt(sig, 10) || 0;
        const existing = best.get(ssid);
        if (!existing || signal > existing.signal) {
          best.set(ssid, { ssid, signal, secured: security !== '' && security !== '--' });
        }
      }
      return [...best.values()].sort((a, b) => b.signal - a.signal);
    },

    async connect(ssid, password, hidden = false) {
      const args = ['device', 'wifi', 'connect', ssid];
      if (password !== null) args.push('password', password);
      if (hidden) args.push('hidden', 'yes');
      try {
        await run('nmcli', args, { timeoutMs: 60_000 });
      } catch {
        // Deliberately drop the underlying error: it may echo the password.
        throw new Error(
          password !== null
            ? 'Could not connect — check the password'
            : 'Could not connect to the network'
        );
      }
    },

    async startHotspot(ssid, password) {
      try {
        await run('nmcli', ['device', 'wifi', 'hotspot', 'ssid', ssid, 'password', password]);
      } catch {
        // Deliberately drop the underlying error (and its cause): it echoes the password.
        throw new Error('Could not start the setup hotspot');
      }
    },

    async stopHotspot() {
      try {
        await run('nmcli', ['connection', 'down', HOTSPOT_CONNECTION]);
      } catch {
        // Not active; nothing to stop.
      }
    },

    async isConnected() {
      try {
        const { stdout } = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
        return stdout.split('\n').some((line) => {
          const [, type, state, connection] = splitTerse(line);
          return type === 'wifi' && state === 'connected' && connection !== HOTSPOT_CONNECTION;
        });
      } catch {
        return false;
      }
    },
  };
}
