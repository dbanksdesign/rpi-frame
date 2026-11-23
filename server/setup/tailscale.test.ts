import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { createTailscaleClient } from './tailscale';
import type { Run } from './exec';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const runReturning = (stdout: string): Run => async () => ({ stdout, stderr: '' });

describe('status', () => {
  it('Running -> logged in with hostname and ip', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, a) => {
      calls.push(a);
      return { stdout: fx('tailscale-running.json'), stderr: '' };
    };
    expect(await createTailscaleClient(run).status()).toEqual({
      loggedIn: true,
      hostname: 'frame',
      tailnetIp: '100.64.0.7',
    });
    expect(calls[0]).toEqual(['status', '--json']);
  });
  it('NeedsLogin -> not logged in', async () => {
    expect(await createTailscaleClient(runReturning(fx('tailscale-needslogin.json'))).status()).toEqual({
      loggedIn: false,
    });
  });
  it('never throws on failure or garbage', async () => {
    const failing: Run = async () => {
      throw new Error('nope');
    };
    expect(await createTailscaleClient(failing).status()).toEqual({ loggedIn: false });
    expect(await createTailscaleClient(runReturning('not json')).status()).toEqual({ loggedIn: false });
  });
});

function fakeSpawn() {
  const children: any[] = [];
  const spawnFn = vi.fn((cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.cmd = cmd;
    child.args = args;
    children.push(child);
    return child;
  });
  return { spawnFn: spawnFn as any, children };
}

describe('startLogin', () => {
  afterEach(() => vi.useRealTimers());
  const noRun: Run = async () => ({ stdout: '', stderr: '' });

  it('resolves the URL from output split across chunks and leaves the child running', async () => {
    const { spawnFn, children } = fakeSpawn();
    const p = createTailscaleClient(noRun, spawnFn).startLogin();
    expect([children[0].cmd, children[0].args]).toEqual(['tailscale', ['up']]);
    children[0].stderr.emit('data', Buffer.from('To authenticate, visit:\n\n\thttps://login.tails'));
    children[0].stderr.emit('data', Buffer.from('cale.com/a/abc123\n'));
    expect(await p).toBe('https://login.tailscale.com/a/abc123');
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('reuses the in-flight login, then spawns anew after the child exits', async () => {
    const { spawnFn, children } = fakeSpawn();
    const client = createTailscaleClient(noRun, spawnFn);
    const p1 = client.startLogin();
    const p2 = client.startLogin();
    children[0].stdout.emit('data', 'https://login.tailscale.com/a/x\n');
    expect(await p1).toBe(await p2);
    expect(await client.startLogin()).toBe('https://login.tailscale.com/a/x');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    children[0].emit('exit', 0);
    const p3 = client.startLogin();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    children[1].stdout.emit('data', 'https://login.tailscale.com/a/y');
    expect(await p3).toBe('https://login.tailscale.com/a/y');
  });

  it('rejects and kills the child after 15s without a URL', async () => {
    vi.useFakeTimers();
    const { spawnFn, children } = fakeSpawn();
    const p = createTailscaleClient(noRun, spawnFn).startLogin();
    const assertion = expect(p).rejects.toThrow(/login/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('rejects if the child exits before printing a URL', async () => {
    const { spawnFn, children } = fakeSpawn();
    const p = createTailscaleClient(noRun, spawnFn).startLogin();
    children[0].emit('exit', 1);
    await expect(p).rejects.toThrow();
  });
});
