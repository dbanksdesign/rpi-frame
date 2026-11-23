import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createWifiManager } from './nmcli';
import type { Run } from './exec';

function fakeRun(responses: Array<{ stdout?: string; error?: Error }> = []) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses.shift() ?? { stdout: '' };
    if (r.error) throw r.error;
    return { stdout: r.stdout ?? '', stderr: '' };
  };
  return { run, calls };
}

const listFixture = readFileSync(join(__dirname, 'fixtures/nmcli-wifi-list.txt'), 'utf8');

describe('scan', () => {
  it('parses, unescapes, dedupes, drops empty SSIDs, sorts strongest first', async () => {
    const { run, calls } = fakeRun([{ stdout: listFixture }]);
    const nets = await createWifiManager(run).scan();
    expect(calls[0].cmd).toBe('nmcli');
    expect(calls[0].args).toEqual(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']);
    expect(nets).toEqual([
      { ssid: 'OpenNet', signal: 90, secured: false },
      { ssid: 'Cafe: Free', signal: 80, secured: false },
      { ssid: 'HomeNet', signal: 72, secured: true },
      { ssid: 'Back\\slash', signal: 30, secured: true },
    ]);
  });
});

describe('connect', () => {
  it('passes hostile ssid and password as separate literal argv entries', async () => {
    const { run, calls } = fakeRun();
    const ssid = 'My "Net"; $(reboot)';
    const pw = 'p\'a ss"w;rd';
    await createWifiManager(run).connect(ssid, pw);
    expect(calls).toEqual([
      { cmd: 'nmcli', args: ['device', 'wifi', 'connect', ssid, 'password', pw] },
    ]);
  });

  it('adds hidden yes and omits password for open networks', async () => {
    const { run, calls } = fakeRun();
    await createWifiManager(run).connect('Open', null, true);
    expect(calls[0].args).toEqual(['device', 'wifi', 'connect', 'Open', 'hidden', 'yes']);
  });

  it('throws a friendly error without leaking the password', async () => {
    const err = Object.assign(new Error('Command failed: nmcli ... secretpw'), {
      stderr: 'Error: Connection activation failed secretpw',
    });
    const { run } = fakeRun([{ error: err }]);
    const p = createWifiManager(run).connect('Net', 'secretpw');
    await expect(p).rejects.toThrow(/check the password/);
    await expect(p).rejects.not.toThrow(/secretpw/);
  });
});

describe('hotspot', () => {
  it('starts a WPA2 hotspot with literal args', async () => {
    const { run, calls } = fakeRun();
    await createWifiManager(run).startHotspot('Frame Setup', 'hunter22!');
    expect(calls[0].args).toEqual(['device', 'wifi', 'hotspot', 'ssid', 'Frame Setup', 'password', 'hunter22!']);
  });

  it('stops the hotspot and ignores errors', async () => {
    const { run, calls } = fakeRun([{ error: new Error('not active') }]);
    await expect(createWifiManager(run).stopHotspot()).resolves.toBeUndefined();
    expect(calls[0].args).toEqual(['connection', 'down', 'Hotspot']);
  });
});

describe('isConnected', () => {
  it('true for a connected wifi device', async () => {
    const { run, calls } = fakeRun([{ stdout: 'eth0:ethernet:unavailable:\nwlan0:wifi:connected:Home\n' }]);
    expect(await createWifiManager(run).isConnected()).toBe(true);
    expect(calls[0].args).toEqual(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  });
  it('false when only the hotspot is up', async () => {
    const { run } = fakeRun([{ stdout: 'wlan0:wifi:connected:Hotspot\n' }]);
    expect(await createWifiManager(run).isConnected()).toBe(false);
  });
  it('false when disconnected or on error', async () => {
    expect(await createWifiManager(fakeRun([{ stdout: 'wlan0:wifi:disconnected:\n' }]).run).isConnected()).toBe(false);
    expect(await createWifiManager(fakeRun([{ error: new Error('x') }]).run).isConnected()).toBe(false);
  });
});
