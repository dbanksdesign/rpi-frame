import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareVersions, createUpdateService } from './updateService';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.2.0',
  body: 'notes',
  draft: false,
  prerelease: false,
  ...over,
});
const okFetch = (payload: unknown, status = 200) =>
  vi.fn(
    async (..._a: unknown[]) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response
  );
const okRun = () => vi.fn(async (..._a: unknown[]) => ({ stdout: '', stderr: '' }));

describe('compareVersions', () => {
  it('compares numerically and strips v', () => {
    expect(compareVersions('v1.2.0', 'v1.1.9')).toBe(1);
    expect(compareVersions('1.2.0', 'v1.2.0')).toBe(0);
    expect(compareVersions('v1.9.0', 'v1.10.0')).toBe(-1);
    expect(compareVersions('v2.0.0', 'v1.99.99')).toBe(1);
  });
  it('throws TypeError on invalid input unless both equal', () => {
    expect(() => compareVersions('dev', 'v1.0.0')).toThrow(TypeError);
    expect(compareVersions('dev', 'dev')).toBe(0);
  });
});

describe('update service', () => {
  let dir: string;
  let versionFile: string;
  let statusFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-svc-'));
    versionFile = path.join(dir, 'VERSION');
    fs.writeFileSync(versionFile, 'v1.0.0\n');
    statusFile = path.join(dir, 'update-status.json');
    process.env.FRAME_DATA_DIR = dir;
  });
  afterEach(() => {
    delete process.env.FRAME_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (over: Record<string, unknown> = {}) =>
    createUpdateService({
      fetch: okFetch(release()) as unknown as typeof fetch,
      run: okRun(),
      versionFile,
      ...over,
    } as never);

  it('reports a newer tag as an update with notes', async () => {
    expect(await make().check()).toEqual({
      current: 'v1.0.0',
      latest: 'v1.2.0',
      updateAvailable: true,
      notes: 'notes',
    });
  });

  it('same and older tags are not updates', async () => {
    expect((await make({ fetch: okFetch(release({ tag_name: 'v1.0.0' })) }).check()).updateAvailable).toBe(false);
    expect((await make({ fetch: okFetch(release({ tag_name: 'v0.9.0' })) }).check()).updateAvailable).toBe(false);
  });

  it('truncates notes to 2000 chars', async () => {
    const r = await make({ fetch: okFetch(release({ body: 'x'.repeat(5000) })) }).check();
    expect(r.notes).toHaveLength(2000);
  });

  it('ignores drafts, prereleases and odd tags', async () => {
    for (const over of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.2.0-beta' }, { tag_name: 'latest' }]) {
      const r = await make({ fetch: okFetch(release(over)) }).check();
      expect(r.updateAvailable).toBe(false);
    }
  });

  it('calls the GitHub releases endpoint with the expected headers', async () => {
    const f = okFetch(release());
    await make({ fetch: f }).check();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/dbanksdesign/rpi-frame/releases/latest');
    expect(init.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'User-Agent': 'photo-frame' });
  });

  it('never throws: rejection, 403, 404 and bad JSON give a short error', async () => {
    const cases = [
      vi.fn(async () => {
        throw new Error('ECONNREFUSED https://secret.example/x');
      }),
      okFetch({}, 403),
      okFetch({}, 404),
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('bad');
            },
          }) as unknown as Response
      ),
    ];
    for (const f of cases) {
      const r = await make({ fetch: f }).check();
      expect(r.updateAvailable).toBe(false);
      expect(r.current).toBe('v1.0.0');
      expect(typeof r.error).toBe('string');
      expect(r.error).not.toMatch(/http|secret|ECONN/i);
    }
  });

  it('caches success for 5 minutes but not failures', async () => {
    let t = 1000;
    const f = okFetch(release());
    const svc = make({ fetch: f, now: () => t });
    await svc.check();
    t += 4 * 60_000;
    await svc.check();
    expect(f).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await svc.check();
    expect(f).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => {
      throw new Error('x');
    });
    const svc2 = make({ fetch: bad, now: () => t });
    await svc2.check();
    await svc2.check();
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it('dev builds: no network on check, install refused', async () => {
    fs.rmSync(versionFile);
    const f = okFetch(release());
    const run = okRun();
    const svc = make({ fetch: f, run });
    expect(await svc.check()).toEqual({ current: 'dev', updateAvailable: false });
    expect(f).not.toHaveBeenCalled();
    await expect(svc.install('v9.9.9')).rejects.toMatchObject({ code: 'dev-build' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects invalid tags before anything else, without running', async () => {
    const run = okRun();
    const svc = make({ run });
    for (const tag of ['1.2.3', 'v1.2', 'v1.2.3; rm -rf /', '--help', 'v1.2.3\n', '', 'v1.2.3-rc1']) {
      await expect(svc.install(tag)).rejects.toMatchObject({ code: 'invalid-tag' });
    }
    await expect(svc.install(undefined as never)).rejects.toMatchObject({ code: 'invalid-tag' });
    expect(run).not.toHaveBeenCalled();
  });

  it('validates the tag even on a dev build', async () => {
    fs.rmSync(versionFile);
    await expect(make().install('nope')).rejects.toMatchObject({ code: 'invalid-tag' });
  });

  it('rejects same/older tags as up-to-date', async () => {
    const run = okRun();
    const svc = make({ run });
    await expect(svc.install('v1.0.0')).rejects.toMatchObject({ code: 'up-to-date' });
    await expect(svc.install('v0.9.0')).rejects.toMatchObject({ code: 'up-to-date' });
    expect(run).not.toHaveBeenCalled();
  });

  it('install twice quickly: started then already-running; exact argv', async () => {
    const run = okRun();
    const svc = make({ run });
    expect(await svc.install('v1.2.0')).toBe('started');
    expect(await svc.install('v1.2.0')).toBe('already-running');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('sudo', [
      '-n',
      'systemd-run',
      '--unit=frame-update',
      '/usr/local/sbin/frame-update',
      'v1.2.0',
    ]);
  });

  it('concurrent installs only launch once', async () => {
    const run = okRun();
    const svc = make({ run });
    const [a, b] = await Promise.all([svc.install('v1.2.0'), svc.install('v1.2.0')]);
    expect([a, b].sort()).toEqual(['already-running', 'started']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('already-running when the status file says running', async () => {
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'running', tag: 'v1.2.0', message: 'x' }));
    const run = okRun();
    expect(await make({ run }).install('v1.2.0')).toBe('already-running');
    expect(run).not.toHaveBeenCalled();
  });

  it('run failure clears the flag, reports a generic failure, leaks no stderr', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'sudo: secret detail' });
    });
    const svc = make({ run });
    await expect(svc.install('v1.2.0')).rejects.toMatchObject({ code: 'start-failed' });
    expect(svc.status()).toEqual({ state: 'failed', message: 'Could not start the update' });
    expect(JSON.stringify(svc.status())).not.toMatch(/secret/);
    // a retry is allowed
    run.mockImplementation(async () => {
      return { stdout: '', stderr: '' } as never;
    });
    expect(await svc.install('v1.2.0')).toBe('started');
  });

  it('status: idle by default, reads file, stale running is idle', () => {
    const svc = make();
    expect(svc.status()).toEqual({ state: 'idle' });
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'running', tag: 'v1.2.0', message: 'Downloading' }));
    expect(svc.status()).toEqual({ state: 'running', tag: 'v1.2.0', message: 'Downloading' });
    const old = new Date(Date.now() - 16 * 60_000);
    fs.utimesSync(statusFile, old, old);
    expect(svc.status()).toEqual({ state: 'idle' });
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'failed', message: 'Nope' }));
    expect(svc.status()).toEqual({ state: 'failed', message: 'Nope' });
    fs.writeFileSync(statusFile, '{not json');
    expect(svc.status()).toEqual({ state: 'idle' });
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'weird' }));
    expect(svc.status()).toEqual({ state: 'idle' });
  });

  it('status reports running between click and first status file', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<{ stdout: string; stderr: string }>((r) => (release = () => r({ stdout: '', stderr: '' }))));
    const svc = make({ run });
    const p = svc.install('v1.2.0');
    expect(svc.status().state).toBe('running');
    release();
    await p;
    expect(svc.status().state).toBe('running');
  });
});
