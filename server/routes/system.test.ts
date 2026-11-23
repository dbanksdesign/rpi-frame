import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSystemRouter } from './system';
import { UpdateError, type UpdateErrorCode } from '../update/updateService';

describe('system router', () => {
  let dir: string;
  let versionFile: string;

  const makeApp = () => {
    const app = express();
    app.use('/api', createSystemRouter({ versionFile }));
    return app;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-route-'));
    versionFile = path.join(dir, 'VERSION');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/health returns 200 {ok:true}', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/version returns the trimmed VERSION contents', async () => {
    fs.writeFileSync(versionFile, '1.2.3\n');
    const res = await request(makeApp()).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1.2.3' });
  });

  it('GET /api/version returns "dev" when the file is missing, then picks it up later', async () => {
    const app = makeApp();
    const first = await request(app).get('/api/version');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ version: 'dev' });

    fs.writeFileSync(versionFile, 'v9\n');
    const second = await request(app).get('/api/version');
    expect(second.body).toEqual({ version: 'v9' });
  });

  describe('update routes', () => {
    const fake = (over: Record<string, unknown> = {}) => ({
      check: vi.fn(async () => ({ current: 'v1.0.0', updateAvailable: false })),
      install: vi.fn(async () => 'started'),
      status: vi.fn(() => ({ state: 'idle' })),
      ...over,
    });
    const appWith = (update: unknown) => {
      const app = express();
      app.use('/api', createSystemRouter({ versionFile, update: update as never }));
      return app;
    };

    it('POST /api/update/check returns the check result', async () => {
      const res = await request(appWith(fake())).post('/api/update/check');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ current: 'v1.0.0', updateAvailable: false });
    });

    it('POST /api/update/install -> 202 started and passes the tag', async () => {
      const u = fake();
      const res = await request(appWith(u)).post('/api/update/install').send({ tag: 'v1.2.0' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'started' });
      expect(u.install).toHaveBeenCalledWith('v1.2.0');
    });

    it('install -> 409 already-running', async () => {
      const u = fake({ install: vi.fn(async () => 'already-running') });
      const res = await request(appWith(u)).post('/api/update/install').send({ tag: 'v1.2.0' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ status: 'already-running' });
    });

    it('maps service errors to statuses', async () => {
      const cases: Array<[UpdateErrorCode, number, unknown]> = [
        ['invalid-tag', 400, { error: 'Invalid version' }],
        ['dev-build', 409, { error: "A development build can't be updated" }],
        ['up-to-date', 409, { error: 'Already up to date' }],
        ['start-failed', 500, { error: 'Could not start the update' }],
      ];
      for (const [code, status, body] of cases) {
        const u = fake({ install: vi.fn(async () => { throw new UpdateError(code); }) });
        const res = await request(appWith(u)).post('/api/update/install').send({ tag: 'v1.2.0' });
        expect(res.status).toBe(status);
        expect(res.body).toEqual(body);
      }
    });

    it('rejects a missing or non-string tag with 400', async () => {
      const u = fake({ install: vi.fn(async (t: unknown) => { if (typeof t !== 'string') throw new UpdateError('invalid-tag'); return 'started'; }) });
      const res = await request(appWith(u)).post('/api/update/install').send({ tag: { a: 1 } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid version' });
    });

    it('malformed JSON -> 400 Invalid request without logging the body', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(appWith(fake()))
        .post('/api/update/install')
        .set('Content-Type', 'application/json')
        .send('{"tag": "v1.2.0", SECRET');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
      spy.mockRestore();
    });

    it('GET /api/update/status returns the status', async () => {
      const u = fake({ status: vi.fn(() => ({ state: 'running', message: 'Downloading' })) });
      const res = await request(appWith(u)).get('/api/update/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'running', message: 'Downloading' });
    });
  });
});
