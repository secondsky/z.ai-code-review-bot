/**
 * Smoke tests for the shared unit-test helpers (tests/_helpers.js).
 * Verifies the factories produce valid shapes usable by real modules.
 */
import { describe, it, expect } from 'vitest';
import { validateFinding } from '../src/lib/findings.js';
import { parseHunks } from '../src/lib/diff.js';
import {
  makeFinding,
  makePatch,
  makeFakeCore,
  makeFakeCallApi,
  makeFakeDeps,
} from './_helpers.js';

describe('makeFinding', () => {
  it('produces a finding that passes validateFinding', () => {
    const result = validateFinding(makeFinding());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts overrides and still validates', () => {
    const result = validateFinding(makeFinding({ severity: 'critical', line: 42 }));
    expect(result.ok).toBe(true);
  });
});

describe('makePatch', () => {
  it('produces a patch parseable by parseHunks', () => {
    const patch = makePatch();
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].newStart).toBe(1);
  });

  it('respects custom line types', () => {
    const patch = makePatch({
      lines: [
        { type: 'ctx', text: 'a' },
        { type: 'add', text: 'b' },
        { type: 'add', text: 'c' },
      ],
    });
    const hunks = parseHunks(patch);
    const addLines = hunks[0].lines.filter((l) => l.type === 'add');
    expect(addLines).toHaveLength(2);
  });
});

describe('makeFakeCore', () => {
  it('creates vi.fn mocks for all core methods', () => {
    const core = makeFakeCore();
    expect(typeof core.info).toBe('function');
    expect(typeof core.warning).toBe('function');
    expect(typeof core.error).toBe('function');
    expect(typeof core.setFailed).toBe('function');
    expect(typeof core.setSecret).toBe('function');
    expect(typeof core.getInput).toBe('function');

    core.info('test');
    expect(core.info).toHaveBeenCalledWith('test');
  });
});

describe('makeFakeCallApi', () => {
  it('returns canned response', async () => {
    const fn = makeFakeCallApi('hello');
    const result = await fn('key', 'model', 'prompt');
    expect(result).toBe('hello');
  });

  it('supports per-call function responses', async () => {
    const fn = makeFakeCallApi((_k, _m, prompt) => `echo:${prompt}`);
    const result = await fn('key', 'model', 'test');
    expect(result).toBe('echo:test');
  });

  it('throws when rejectWith is set', async () => {
    const fn = makeFakeCallApi('x', { rejectWith: new Error('boom') });
    await expect(fn('k', 'm', 'p')).rejects.toThrow('boom');
  });
});

describe('makeFakeDeps', () => {
  it('builds a complete deps bundle', () => {
    const deps = makeFakeDeps();
    expect(deps.core).toBeDefined();
    expect(typeof deps.callApi).toBe('function');
    expect(deps.config).toEqual({});
    expect(deps.octokit).toEqual({});
  });

  it('accepts overrides', () => {
    const deps = makeFakeDeps({ config: { apiKey: 'x' } });
    expect(deps.config.apiKey).toBe('x');
  });
});
