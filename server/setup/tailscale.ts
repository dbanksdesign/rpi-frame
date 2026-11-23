import { spawn, type ChildProcess } from 'child_process';
import type { Run } from './exec';

export interface TailscaleClient {
  status(): Promise<{ loggedIn: boolean; hostname?: string; tailnetIp?: string }>;
  /** Starts `tailscale up` in the background and resolves with the login URL. */
  startLogin(): Promise<string>;
}

type SpawnFn = (cmd: string, args: string[], opts?: { stdio: 'pipe' }) => ChildProcess;

const URL_RE = /https:\/\/login\.tailscale\.com\/[^\s"']+/;
const LOGIN_TIMEOUT_MS = 15_000;

export function createTailscaleClient(run: Run, spawnFn: SpawnFn = spawn as SpawnFn): TailscaleClient {
  let inFlight: Promise<string> | null = null;

  return {
    async status() {
      try {
        const { stdout } = await run('tailscale', ['status', '--json']);
        const json = JSON.parse(stdout);
        if (json?.BackendState !== 'Running') return { loggedIn: false };
        return {
          loggedIn: true,
          hostname: json.Self?.HostName,
          tailnetIp: json.Self?.TailscaleIPs?.[0],
        };
      } catch {
        return { loggedIn: false };
      }
    },

    startLogin() {
      if (inFlight) return inFlight;
      const child = spawnFn('tailscale', ['up'], { stdio: 'pipe' });
      const promise = new Promise<string>((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const onData = (chunk: Buffer | string) => {
          buffer += chunk.toString();
          const m = buffer.match(URL_RE);
          if (m) finish(() => resolve(m[0]));
        };
        const timer = setTimeout(() => {
          finish(() => {
            child.kill();
            reject(new Error('Timed out waiting for the Tailscale login link'));
          });
        }, LOGIN_TIMEOUT_MS);
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => finish(() => reject(err)));
        child.on('exit', () => {
          if (inFlight === promise) inFlight = null;
          finish(() => reject(new Error('Tailscale exited before giving a login link')));
        });
      });
      inFlight = promise;
      promise.catch(() => {
        if (inFlight === promise) inFlight = null;
      });
      return promise;
    },
  };
}
