import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSystemRouter } from './system';

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
});
