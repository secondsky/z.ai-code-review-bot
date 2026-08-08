/**
 * Shared unit-test helpers (the unit-test counterpart to
 * tests/integration/helpers.js).
 *
 * These factories reduce boilerplate in edge-case tests by producing valid
 * input objects and fakes that match the shapes the source modules expect.
 *
 * Design constraints (mirrored from integration/helpers.js):
 *   - Deterministic — no randomness, no real I/O, no timers.
 *   - Pure builders — each returns a fresh object; mutations don't leak.
 *   - Every factory accepts an `overrides` param for per-test customization.
 *
 * Existing tests are NOT refactored to use these; new tests use them to stay
 * terse while the factories themselves stay explicit.
 */
import { vi } from 'vitest';

/* ------------------------------------------------------------------ *
 * Finding factory
 * ------------------------------------------------------------------ */

/**
 * Build a minimal valid finding object (passes `validateFinding`).
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {{file:string, line:number, severity:string, confidence:string, category:string, title:string, description:string, evidence:string, suggestion:string, rule:null}}
 */
export function makeFinding(overrides = {}) {
  return {
    file: 'src/app.js',
    line: 10,
    severity: 'high',
    confidence: 'high',
    category: 'bug',
    title: 'Off-by-one error',
    description: 'The loop boundary is incorrect.',
    evidence: 'for (let i = 0; i <= arr.length; i++)',
    suggestion: 'Use `< arr.length` instead.',
    rule: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Unified-diff patch builder
 * ------------------------------------------------------------------ */

/**
 * Build a unified-diff patch string with a single hunk.
 *
 * Produces a valid `@@ -1,N +1,M @@` hunk header followed by body lines.
 * Each entry in `lines` is an object:
 *   { type: 'add'|'del'|'ctx', text: string }
 *
 * The `oldStart`/`newStart` default to 1; pass overrides for multi-hunk
 * scenarios. Line numbers in the body are derived automatically from the
 * sequence of add/del/ctx entries.
 *
 * @param {{
 *   oldStart?: number,
 *   newStart?: number,
 *   lines?: Array<{type:'add'|'del'|'ctx', text:string}>,
 * }} [opts]
 * @returns {string}
 */
export function makePatch(opts = {}) {
  const oldStart = opts.oldStart ?? 1;
  const newStart = opts.newStart ?? 1;
  const lines = opts.lines ?? [
    { type: 'ctx', text: 'unchanged' },
    { type: 'add', text: 'new line' },
    { type: 'del', text: 'old line' },
  ];

  const body = lines
    .map((l) => {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      return `${prefix}${l.text}`;
    })
    .join('\n');

  // Derive per-side hunk counts from the line types so the @@ header matches
  // the body. oldCount = context + deleted lines; newCount = context + added
  // lines. (Using lines.length for both sides is wrong for mixed patches.)
  const oldCount = lines.filter((l) => l.type === 'ctx' || l.type === 'del').length;
  const newCount = lines.filter((l) => l.type === 'ctx' || l.type === 'add').length;

  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
}

/* ------------------------------------------------------------------ *
 * Fake @actions/core
 * ------------------------------------------------------------------ */

/**
 * A minimal fake `@actions/core` capturing every call (same shape as the
 * integration helper, but kept here so unit tests don't import from
 * tests/integration/).
 *
 * @returns {{info: import('vitest').Mock, warning: import('vitest').Mock, error: import('vitest').Mock, setFailed: import('vitest').Mock, setSecret: import('vitest').Mock, getInput: import('vitest').Mock}}
 */
export function makeFakeCore() {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    getInput: vi.fn(() => ''),
  };
}

/* ------------------------------------------------------------------ *
 * Fake callApi
 * ------------------------------------------------------------------ */

/**
 * Build a fake `callApi(apiKey, model, prompt)` that records every invocation
 * and returns the canned response. Pass a function to vary per-call.
 *
 * @param {string | ((apiKey: string, model: string, prompt: string) => string | Promise<string>)} [response]
 * @param {{ rejectWith?: Error | string }} [options]
 */
export function makeFakeCallApi(response = 'canned response', { rejectWith } = {}) {
  return vi.fn(async (apiKey, model, prompt) => {
    if (rejectWith) {
      throw rejectWith instanceof Error ? rejectWith : new Error(String(rejectWith));
    }
    return typeof response === 'function' ? response(apiKey, model, prompt) : response;
  });
}

/* ------------------------------------------------------------------ *
 * Generic DI deps bundle for handler/command tests
 * ------------------------------------------------------------------ */

/**
 * Build a generic `{ core, octokit, callApi, config }` bundle for tests that
 * exercise handler logic via dependency injection.
 *
 * @param {{
 *   core?: object,
 *   octokit?: object,
 *   callApi?: import('vitest').Mock,
 *   config?: Record<string, unknown>,
 * }} [overrides]
 */
export function makeFakeDeps(overrides = {}) {
  return {
    core: overrides.core ?? makeFakeCore(),
    octokit: overrides.octokit ?? {},
    callApi: overrides.callApi ?? makeFakeCallApi(),
    config: overrides.config ?? {},
  };
}
