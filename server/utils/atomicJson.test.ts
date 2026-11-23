import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonAtomic } from './atomicJson';

describe('writeJsonAtomic', () => {
  const dirs: string[] = [];
  const tmpDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });

  it('writes valid JSON and leaves no .tmp file', () => {
    const file = path.join(tmpDir(), 'a.json');
    writeJsonAtomic(file, { a: 1, b: [2] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1, b: [2] });
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('keeps the original content if rename fails', () => {
    const file = path.join(tmpDir(), 'a.json');
    fs.writeFileSync(file, '{"old":true}');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    expect(() => writeJsonAtomic(file, { new: true })).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"old":true}');
  });
});
