import fs from 'fs';
import path from 'path';
import type { Run } from '../setup/exec';
import { getDataRoot } from '../utils/paths';
import { readVersion } from '../utils/version';

const RELEASES_URL = 'https://api.github.com/repos/dbanksdesign/rpi-frame/releases/latest';
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const NOTES_MAX = 2000;
const CACHE_TTL_MS = 5 * 60_000;
const STALE_RUNNING_MS = 15 * 60_000;
// How long the click-to-first-status-file gap is bridged by the in-memory flag.
const STARTING_MS = 60_000;

export type UpdateErrorCode = 'invalid-tag' | 'dev-build' | 'up-to-date' | 'start-failed';

export class UpdateError extends Error {
  constructor(public readonly code: UpdateErrorCode) {
    super(code);
    this.name = 'UpdateError';
  }
}

export interface CheckResult {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  notes?: string;
  error?: string;
}

export interface UpdateStatus {
  state: 'idle' | 'running' | 'failed' | 'succeeded';
  message?: string;
  tag?: string;
}

export interface UpdateService {
  check(): Promise<CheckResult>;
  install(tag: string): Promise<'started' | 'already-running'>;
  status(): UpdateStatus;
}

export interface UpdateServiceDeps {
  run: Run;
  fetch?: typeof fetch;
  versionFile?: string;
  now?: () => number;
  cacheTtlMs?: number;
}

function parse(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    if (a === b) return 0;
    throw new TypeError('Invalid version');
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;

  let cache: { at: number; result: CheckResult } | null = null;
  let startedAt: number | null = null;
  let startFailure: string | null = null;

  const statusFile = () => path.join(getDataRoot(), 'update-status.json');

  async function check(): Promise<CheckResult> {
    const current = readVersion(deps.versionFile);
    if (current === 'dev') return { current, updateAvailable: false };
    if (cache && now() - cache.at < ttl && cache.result.current === current) {
      return cache.result;
    }
    try {
      const res = await doFetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'photo-frame' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { current, updateAvailable: false, error: "Couldn't check for updates right now" };
      }
      const data = (await res.json()) as {
        tag_name?: unknown;
        body?: unknown;
        draft?: unknown;
        prerelease?: unknown;
      };
      let result: CheckResult;
      if (
        !data ||
        data.draft === true ||
        data.prerelease === true ||
        typeof data.tag_name !== 'string' ||
        !TAG_RE.test(data.tag_name)
      ) {
        result = { current, updateAvailable: false };
      } else {
        const latest = data.tag_name;
        const notes = typeof data.body === 'string' ? data.body.slice(0, NOTES_MAX) : undefined;
        const updateAvailable = compareVersions(latest, current) > 0;
        result = { current, latest, updateAvailable, ...(notes !== undefined ? { notes } : {}) };
      }
      cache = { at: now(), result };
      return result;
    } catch {
      return { current, updateAvailable: false, error: "Couldn't check for updates right now" };
    }
  }

  function readStatusFile(): UpdateStatus & { mtimeMs?: number } {
    const file = statusFile();
    try {
      const stat = fs.statSync(file);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const state = data?.state;
      if (state !== 'running' && state !== 'succeeded' && state !== 'failed') return { state: 'idle' };
      if (state === 'running' && Date.now() - stat.mtimeMs > STALE_RUNNING_MS) return { state: 'idle' };
      const out: UpdateStatus & { mtimeMs?: number } = { state, mtimeMs: stat.mtimeMs };
      if (typeof data.message === 'string') out.message = data.message;
      if (typeof data.tag === 'string') out.tag = data.tag;
      return out;
    } catch {
      return { state: 'idle' };
    }
  }

  function status(): UpdateStatus {
    const file = readStatusFile();
    const { mtimeMs, ...fromFile } = file;
    const startingActive = startedAt !== null && now() - startedAt < STARTING_MS;
    // A status file written since the click (or any file once the flag is stale) wins.
    const fileIsNew = mtimeMs !== undefined && (startedAt === null || mtimeMs >= startedAt);
    if (fromFile.state !== 'idle' && (fileIsNew || !startingActive)) return fromFile;
    if (startingActive) return { state: 'running' };
    if (startFailure) return { state: 'failed', message: startFailure };
    return fromFile;
  }

  async function install(tag: string): Promise<'started' | 'already-running'> {
    if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new UpdateError('invalid-tag');
    const current = readVersion(deps.versionFile);
    if (current === 'dev') throw new UpdateError('dev-build');
    if (compareVersions(tag, current) <= 0) throw new UpdateError('up-to-date');

    const flagActive = startedAt !== null && now() - startedAt < STARTING_MS;
    if (flagActive || status().state === 'running') return 'already-running';

    startedAt = now();
    startFailure = null;
    try {
      await deps.run('sudo', ['-n', 'systemd-run', '--collect', '--unit=frame-update', '/usr/local/sbin/frame-update', tag]);
    } catch {
      startedAt = null;
      startFailure = 'Could not start the update';
      throw new UpdateError('start-failed');
    }
    return 'started';
  }

  return { check, install, status };
}
