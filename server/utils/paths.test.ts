import { describe, it, expect, afterEach } from 'vitest';
import { getDataRoot } from './paths';
import { getProjectRoot } from './filesystem';

describe('getDataRoot', () => {
  const original = process.env.FRAME_DATA_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.FRAME_DATA_DIR;
    else process.env.FRAME_DATA_DIR = original;
  });

  it('returns FRAME_DATA_DIR when set', () => {
    process.env.FRAME_DATA_DIR = '/data';
    expect(getDataRoot()).toBe('/data');
  });

  it('falls back to the project root', () => {
    delete process.env.FRAME_DATA_DIR;
    expect(getDataRoot()).toBe(getProjectRoot());
  });
});
