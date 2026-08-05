/**
 * Tests for src/lib/api.js — the SINGLE Z.ai HTTP client.
 *
 * The transport (https.request) and sleep are injected so these tests run
 * fully deterministically: no real network, no real multi-second backoff.
 * The retry / categorize / sanitize / progressive-timeout LOGIC is the real
 * behavior under test.
 */
import { Readable } from 'node:stream';
import {
  ZAI_API_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
  MAX_RESPONSE_SIZE,
  extractStatusCode,
  categorizeError,
  sanitizeErrorMessage,
  makeApiRequest,
  callWithRetry,
  createApiClient,
} from '../src/lib/api.js';

/* ------------------------------------------------------------------ *
 * Fake transport
 *
 * A minimal stand-in for the object returned by `https.request`. It
 * captures the request options/headers/body and then delivers a configured
 * response (a real `node:stream.Readable`) so `makeApiRequest` can consume
 * it exactly like a real IncomingMessage. Using a real Readable for the
 * response avoids hand-rolled stream timing races (data/end must fire only
 * after listeners attach, which Readable guarantees).
 * ------------------------------------------------------------------ */

/**
 * Build a fake response as a paused `Readable` over `chunks`. The stream is
 * NOT put into flowing mode until `makeApiRequest` attaches a 'data' listener
 * — exactly like a real `IncomingMessage`. A `statusCode` is attached.
 */
function buildFakeRes(chunks = [], { statusCode = 200 } = {}) {
  const buf = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)));
  // Readable.from is paused until a 'data' listener is attached, then emits
  // 'data' for each item and 'end' — exactly the IncomingMessage contract.
  const res = Readable.from(buf, { objectMode: false });
  res.statusCode = statusCode;
  return res;
}

/**
 * Create a fake `request` function (the injection-seam transport).
 * `behavior` is called with `{ options, headers, body, attempt }` and returns
 * `{ res }` (a Readable) — letting each test (or each attempt) return a
 * different response. The returned `request` also exposes a `calls` array.
 *
 * `req.destroy(err)` surfaces to `makeApiRequest`'s `'error'` handler, so the
 * timeout- and size-limit destroy paths can be tested.
 */
function makeFakeRequest(behavior) {
  const calls = [];
  const request = (url, options) => {
    // Node's `https.request(url, options)` passes the URL as arg 0; capture it
    // so tests can assert the transport was aimed at ZAI_API_URL.
    const captured = {
      url,
      options,
      headers: options?.headers || {},
      calls,
    };
    calls.push(captured);
    const { res } = behavior(captured);

    let responseCb = null;
    let errorCb = null;

    const req = {
      on(event, cb) {
        if (event === 'response') {
          responseCb = cb;
        } else if (event === 'error') {
          errorCb = cb;
        }
        return req;
      },
      setTimeout(ms, cb) {
        req.timeout = ms;
        req._timeoutCb = cb;
        return req;
      },
      destroy(err) {
        // Surface a destroy-with-error to makeApiRequest's error handler.
        if (err && errorCb) errorCb(err);
        return req;
      },
      write(data) {
        captured.writes = (captured.writes || []);
        captured.writes.push(data);
        return req;
      },
      end(data) {
        if (data) {
          captured.writes = (captured.writes || []);
          captured.writes.push(data);
        }
        captured.body = (captured.writes || []).join('');
        // Deliver the response asynchronously, after the synchronous part of
        // makeApiRequest has finished attaching handlers.
        queueMicrotask(() => {
          if (responseCb) responseCb(res);
        });
        return req;
      },
    };
    captured.req = req;
    return req;
  };
  request.calls = calls;
  return request;
}

/* ------------------------------------------------------------ *
 * categorizeError / extractStatusCode
 * ------------------------------------------------------------ */

describe('extractStatusCode', () => {
  test('extracts a 4xx/5xx number from a message', () => {
    expect(extractStatusCode('Z.ai API error 429: rate limited')).toBe(429);
    expect(extractStatusCode('Z.ai API error 503: unavailable')).toBe(503);
    expect(extractStatusCode('something 401 happened')).toBe(401);
  });

  test('extracts a 4xx from JSON-ish code":NNN messages', () => {
    expect(extractStatusCode('bad: code":413')).toBe(413);
  });

  test('returns null when no 4xx/5xx code is present', () => {
    expect(extractStatusCode('Request timed out')).toBeNull();
    expect(extractStatusCode('ECONNREFUSED')).toBeNull();
    expect(extractStatusCode('')).toBeNull();
    expect(extractStatusCode(undefined)).toBeNull();
  });
});

describe('categorizeError', () => {
  test('timeout message → timeout/retryable', () => {
    expect(categorizeError(new Error('Request timed out'))).toEqual({
      category: 'timeout',
      retryable: true,
    });
    expect(categorizeError(new Error('operation timeout'))).toEqual({
      category: 'timeout',
      retryable: true,
    });
  });

  test('429 → rate-limit/retryable', () => {
    expect(categorizeError(new Error('Z.ai API error 429: slow down'))).toEqual({
      category: 'rate-limit',
      retryable: true,
    });
  });

  test('401 and 403 → auth/non-retryable', () => {
    expect(categorizeError(new Error('Z.ai API error 401: no'))).toEqual({
      category: 'auth',
      retryable: false,
    });
    expect(categorizeError(new Error('Z.ai API error 403: nope'))).toEqual({
      category: 'auth',
      retryable: false,
    });
  });

  test('400 → validation/non-retryable', () => {
    expect(categorizeError(new Error('Z.ai API error 400: bad'))).toEqual({
      category: 'validation',
      retryable: false,
    });
  });

  test('500 and 503 → provider/retryable', () => {
    expect(categorizeError(new Error('Z.ai API error 500: oops'))).toEqual({
      category: 'provider',
      retryable: true,
    });
    expect(categorizeError(new Error('Z.ai API error 503: down'))).toEqual({
      category: 'provider',
      retryable: true,
    });
  });

  test('ECONNREFUSED and ENETUNREACH (lowercase) → provider/retryable', () => {
    expect(categorizeError(new Error('connect ECONNREFUSED 1.2.3.4:443'))).toEqual({
      category: 'provider',
      retryable: true,
    });
    expect(categorizeError(new Error('ENETUNREACH'))).toEqual({
      category: 'provider',
      retryable: true,
    });
  });

  test('"empty response" → provider/retryable', () => {
    expect(categorizeError(new Error('Z.ai API returned an empty response'))).toEqual({
      category: 'provider',
      retryable: true,
    });
  });

  test('413 (not in matrix) → internal/non-retryable', () => {
    // 413 is neither 429/401/403/400 nor 5xx; falls through to internal.
    expect(categorizeError(new Error('Z.ai API error 413: too large'))).toEqual({
      category: 'internal',
      retryable: false,
    });
  });

  test('unrecognized message → internal/non-retryable', () => {
    expect(categorizeError(new Error('something else entirely'))).toEqual({
      category: 'internal',
      retryable: false,
    });
  });

  test('does not throw for null/undefined/odd inputs', () => {
    expect(categorizeError(null).category).toBe('internal');
    expect(categorizeError(undefined).category).toBe('internal');
    expect(categorizeError({}).category).toBe('internal');
  });
});

/* ------------------------------------------------------------ *
 * sanitizeErrorMessage
 * ------------------------------------------------------------ */

describe('sanitizeErrorMessage', () => {
  test('redacts Bearer tokens', () => {
    const out = sanitizeErrorMessage(new Error('Authorization: Bearer xyz123 failed'));
    // The brief's pipeline runs the Bearer rule (3) before the Authorization:
    // rule (5); applied verbatim, the secret is removed and the Authorization
    // header value is redacted. The secret must never appear in the output.
    expect(out).not.toContain('xyz123');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts api_key=secret forms', () => {
    const out = sanitizeErrorMessage('api_key=secret went boom');
    expect(out).toContain('api_key=[REDACTED]');
    expect(out).not.toContain('secret');
  });

  test('redacts Authorization: header values', () => {
    const out = sanitizeErrorMessage('Authorization: abc123 boom');
    expect(out).toContain('Authorization: [REDACTED]');
    expect(out).not.toContain('abc123');
  });

  test('redacts credential URLs (user:pass@host)', () => {
    const out = sanitizeErrorMessage('see https://user:pass@host/path');
    expect(out).toContain('[URL_REDACTED]');
    expect(out).not.toContain('user:pass');
  });

  test('redacts JSON blobs containing api_key/token/secret/password', () => {
    const out = sanitizeErrorMessage('err {"api_key":"k","token":"t"} done');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('"api_key"');
  });

  test('truncates messages longer than 500 chars', () => {
    const long = 'x'.repeat(800);
    const out = sanitizeErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(503 + 3); // 500 + '...'
    expect(out.endsWith('...')).toBe(true);
  });

  test('extracts nested error.message from trailing JSON', () => {
    const msg = 'Z.ai API error 400: {"error":{"message":"bad model name"}}';
    const out = sanitizeErrorMessage(msg);
    expect(out).toContain('bad model name');
    expect(out).not.toContain('{"error"');
  });

  test('extracts top-level message from trailing JSON', () => {
    const msg = 'Z.ai API error 400: {"message":"flat bad"}';
    const out = sanitizeErrorMessage(msg);
    expect(out).toContain('flat bad');
    // The JSON blob must be gone after extraction.
    expect(out).not.toContain('{');
  });

  test('returns fallback for null/undefined', () => {
    expect(sanitizeErrorMessage(null)).toBe('An unknown error occurred');
    expect(sanitizeErrorMessage(undefined)).toBe('An unknown error occurred');
  });
});

/* ------------------------------------------------------------ *
 * makeApiRequest (transport injected)
 * ------------------------------------------------------------ */

describe('makeApiRequest', () => {
  test('2xx with valid choices → resolves content', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes(
        [JSON.stringify({ choices: [{ message: { content: 'hello world' } }] })],
        { statusCode: 200 },
      ),
    }));
    const content = await makeApiRequest(
      { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
      { request },
    );
    expect(content).toBe('hello world');
  });

  test('2xx invalid JSON → rejects "invalid JSON"', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes(['{not json}'], { statusCode: 200 }),
    }));
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow('invalid JSON');
  });

  test('2xx empty content → rejects "empty response"', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: '' } }] })], {
        statusCode: 200,
      }),
    }));
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow('empty response');
  });

  test('non-2xx → rejects with "Z.ai API error ${status}: ${body.slice(0,200)}"', async () => {
    const body = 'nope';
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([body], { statusCode: 503 }),
    }));
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow('Z.ai API error 503: nope');
  });

  test('response exceeding MAX_RESPONSE_SIZE → destroys with size-limit error', async () => {
    const oversized = Buffer.alloc(MAX_RESPONSE_SIZE + 1, 'a');
    let destroyErr = null;
    let errorCb = null;
    const request = () => {
      const res = Readable.from([oversized], { objectMode: false });
      res.statusCode = 200;
      const req = {
        on(event, cb) {
          if (event === 'error') errorCb = cb;
          else if (event === 'response') queueMicrotask(() => cb(res));
          return req;
        },
        setTimeout() {
          return req;
        },
        destroy(err) {
          destroyErr = err;
          if (err && errorCb) errorCb(err); // surface to makeApiRequest
          return req;
        },
        write() {
          return req;
        },
        end() {
          return req;
        },
      };
      return req;
    };
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow('size limit');
    expect(destroyErr).toBeTruthy();
    expect(String(destroyErr.message)).toMatch(/size limit/);
  });

  test('request timeout → destroys with "timed out"', async () => {
    let destroyErr = null;
    let errorCb = null;
    const request = () => {
      const req = {
        on(event, cb) {
          if (event === 'error') errorCb = cb;
          return req;
        },
        setTimeout(ms, cb) {
          req.timeout = ms;
          // Fire the timeout callback asynchronously (after handlers attach),
          // mirroring a real Node timer expiring.
          queueMicrotask(() => cb(new Error('Request timed out')));
          return req;
        },
        destroy(err) {
          destroyErr = err;
          if (err && errorCb) errorCb(err); // surface to makeApiRequest
          return req;
        },
        write() {
          return req;
        },
        end() {
          return req;
        },
      };
      return req;
    };
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow('timed out');
    expect(destroyErr).toBeTruthy();
  });

  test('request body contains model + system + user messages and the Authorization header', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      { apiKey: 'secret-key', model: 'glm-5.2', systemPrompt: 'SYS', userPrompt: 'USR', timeout: 1000 },
      { request },
    );
    const captured = request.calls[0];
    const body = JSON.parse(captured.body);
    expect(body.model).toBe('glm-5.2');
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' },
    ]);
    // Authorization header must be Bearer <apiKey>
    const auth = captured.options.headers['Authorization'] || captured.options.headers['authorization'];
    expect(auth).toBe('Bearer secret-key');
    // The transport must have been aimed at ZAI_API_URL (host api.z.ai, path
    // /api/coding/paas/v4/chat/completions) — without this, production would
    // POST to localhost.
    expect(captured.url).toBe(ZAI_API_URL);
    const parsedUrl = new URL(captured.url);
    expect(parsedUrl.host).toBe('api.z.ai');
    expect(parsedUrl.pathname).toBe('/api/coding/paas/v4/chat/completions');
  });

  test('temperature appears in the request body when provided as a number', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      {
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        timeout: 1000,
        temperature: 0.7,
      },
      { request },
    );
    const body = JSON.parse(request.calls[0].body);
    expect(body.temperature).toBe(0.7);
  });

  test('max_tokens appears in the request body when maxTokens is provided as a number', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      {
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        timeout: 1000,
        maxTokens: 8192,
      },
      { request },
    );
    const body = JSON.parse(request.calls[0].body);
    expect(body.max_tokens).toBe(8192);
  });

  test('both temperature and max_tokens appear when both are provided', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      {
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        timeout: 1000,
        temperature: 0,
        maxTokens: 1024,
      },
      { request },
    );
    const body = JSON.parse(request.calls[0].body);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(1024);
  });

  test('temperature and max_tokens are ABSENT when not provided (omitted keys)', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
      { request },
    );
    const body = JSON.parse(request.calls[0].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    // The baseline fields are still present.
    expect(body.model).toBe('m');
    expect(body.messages).toHaveLength(2);
  });

  test('temperature=undefined and maxTokens=undefined are omitted (not in body)', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    await makeApiRequest(
      {
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        timeout: 1000,
        temperature: undefined,
        maxTokens: undefined,
      },
      { request },
    );
    const body = JSON.parse(request.calls[0].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });
});

/* ------------------------------------------------------------ *
 * callWithRetry (sleep injected to a no-op)
 * ------------------------------------------------------------ */

/** A fn that records every (attempt, currentTimeout) it was called with. */
function recordingFn(behaviorByAttempt) {
  const calls = [];
  const fn = (attempt, currentTimeout) => {
    calls.push({ attempt, currentTimeout });
    const behavior = behaviorByAttempt[attempt];
    if (typeof behavior === 'function') return behavior(attempt, currentTimeout);
    if (behavior instanceof Error) return Promise.reject(behavior);
    return Promise.resolve(behavior);
  };
  fn.calls = calls;
  return fn;
}

describe('callWithRetry', () => {
  test('first-attempt success → { success, data, usedFallback:false }, fn called once', async () => {
    const fn = recordingFn(['OK']);
    const out = await callWithRetry(fn, { maxRetries: 3, baseDelay: 2000, baseTimeout: 120000, sleep: async () => {} });
    expect(out).toEqual({ success: true, data: 'OK', usedFallback: false });
    expect(fn.calls).toHaveLength(1);
  });

  test('retry-then-succeed (retryable twice then succeeds) → success, fn called 3 times', async () => {
    const fn = recordingFn([
      new Error('Z.ai API error 500: oops'),
      new Error('Z.ai API error 503: down'),
      'WIN',
    ]);
    const out = await callWithRetry(fn, { maxRetries: 3, baseDelay: 2000, baseTimeout: 120000, sleep: async () => {} });
    expect(out.success).toBe(true);
    expect(out.data).toBe('WIN');
    expect(fn.calls).toHaveLength(3);
  });

  test('non-retryable immediate (auth) → { success:false }, fn called once, category auth', async () => {
    const fn = recordingFn([new Error('Z.ai API error 401: no')]);
    const out = await callWithRetry(fn, { maxRetries: 3, baseDelay: 2000, baseTimeout: 120000, sleep: async () => {} });
    expect(out.success).toBe(false);
    expect(out.data).toBeNull();
    expect(out.error.category).toBe('auth');
    expect(out.error.attempts).toBe(1);
    expect(fn.calls).toHaveLength(1);
  });

  test('5xx retries then gives up → { success:false }, called maxRetries+1 times, category provider', async () => {
    const fn = recordingFn([
      new Error('Z.ai API error 500: a'),
      new Error('Z.ai API error 500: b'),
      new Error('Z.ai API error 500: c'),
      new Error('Z.ai API error 500: d'),
    ]);
    const out = await callWithRetry(fn, { maxRetries: 3, baseDelay: 2000, baseTimeout: 120000, sleep: async () => {} });
    expect(out.success).toBe(false);
    expect(out.error.category).toBe('provider');
    expect(out.error.attempts).toBe(4); // maxRetries(3) + 1
    expect(fn.calls).toHaveLength(4);
  });

  test('error.attempts and error.totalDuration are present on give-up', async () => {
    const fn = recordingFn([new Error('Z.ai API error 400: bad')]);
    const out = await callWithRetry(fn, { maxRetries: 3, baseDelay: 2000, baseTimeout: 120000, sleep: async () => {} });
    expect(out.error.attempts).toBe(1);
    expect(typeof out.error.totalDuration).toBe('number');
    expect(out.error.totalDuration).toBeGreaterThanOrEqual(0);
  });

  test('timeout at attempt 0 does NOT trigger fallback; timeout at attempt 1 DOES, then success', async () => {
    let fallbackCalled = 0;
    const fn = recordingFn([
      new Error('Request timed out'), // attempt 0 — timeout, but attempt < 1, no fallback
      new Error('Request timed out'), // attempt 1 — timeout + attempt>=1 → fallback triggers
      'FALLBACK_OK', // attempt 2 — succeeds with fallback prompt
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FALLBACK_PROMPT' }),
      onFallback: () => {
        fallbackCalled++;
      },
    });
    expect(out.success).toBe(true);
    expect(out.data).toBe('FALLBACK_OK');
    expect(out.usedFallback).toBe(true);
    expect(fallbackCalled).toBe(1);
  });

  test('fallback does NOT trigger on a 5xx error', async () => {
    let fallbackCalled = 0;
    const fn = recordingFn([new Error('Z.ai API error 500: oops'), 'OK']);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FB' }),
      onFallback: () => {
        fallbackCalled++;
      },
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(false);
    expect(fallbackCalled).toBe(0);
  });

  test('progressive timeout: currentTimeout decreases across attempts (100/67/50/33, floored at 10000)', async () => {
    const fn = recordingFn([
      new Error('Z.ai API error 500: 0'),
      new Error('Z.ai API error 500: 1'),
      new Error('Z.ai API error 500: 2'),
      new Error('Z.ai API error 500: 3'),
    ]);
    await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
    });
    const timeouts = fn.calls.map((c) => c.currentTimeout);
    // 120000 * [1.0, 0.67, 0.5, 0.33]
    expect(timeouts[0]).toBe(120000);
    expect(timeouts[1]).toBe(Math.floor(120000 * 0.67));
    expect(timeouts[2]).toBe(60000);
    expect(timeouts[3]).toBe(Math.floor(120000 * 0.33));
    expect(timeouts.length).toBe(4);
  });

  test('progressive timeout never drops below 10000', async () => {
    const fn = recordingFn([new Error('Z.ai API error 500: x'), 'OK']);
    await callWithRetry(fn, {
      maxRetries: 1,
      baseDelay: 2000,
      baseTimeout: 5000, // tiny base → would floor to 10000
      sleep: async () => {},
    });
    expect(fn.calls[0].currentTimeout).toBe(10000);
  });

  test('backoff delay is exponential (baseDelay * 2^attempt) using injected sleep', async () => {
    const delays = [];
    const fn = recordingFn([new Error('Z.ai API error 500: a'), new Error('Z.ai API error 500: b'), 'OK']);
    await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    // attempt 0 fails → delay0 = 2000 * 2^0 + jitter(0..999); check base part
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
    expect(delays[0]).toBeLessThan(3000);
    // attempt 1 fails → delay1 = 2000 * 2^1 + jitter = 4000..4999
    expect(delays[1]).toBeGreaterThanOrEqual(4000);
    expect(delays[1]).toBeLessThan(5000);
  });
});

/* ------------------------------------------------------------ *
 * createApiClient.call (end-to-end with faked transport)
 * ------------------------------------------------------------ */

describe('createApiClient', () => {
  test('exposes config with the default constants', () => {
    const client = createApiClient();
    expect(client.config).toEqual({
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      baseDelay: DEFAULT_BASE_DELAY_MS,
    });
  });

  test('call() success path through the factory with faked transport', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'review done' } }] })], {
        statusCode: 200,
      }),
    }));
    const client = createApiClient();
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      request, // factory passes through to makeApiRequest
    });
    expect(out).toEqual({ success: true, data: 'review done', usedFallback: false });
    expect(request.calls).toHaveLength(1);
  });

  test('call() retry path through the factory with faked transport (500 then 200)', async () => {
    let attempt = 0;
    const responses = [
      { statusCode: 500, body: 'err' },
      { statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok after retry' } }] }) },
    ];
    const request = makeFakeRequest(() => {
      const r = responses[attempt++];
      return { res: buildFakeRes([r.body], { statusCode: r.statusCode }) };
    });
    const client = createApiClient({ maxRetries: 3, baseDelay: 2000, baseTimeout: 120000 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(true);
    expect(out.data).toBe('ok after retry');
    expect(request.calls).toHaveLength(2);
  });

  test('call() fallback end-to-end: timeout at attempts 0+1 fires fallback, and the fallback prompt reaches the transport', async () => {
    // First two calls reject with a timeout error; the third succeeds. The
    // transport is a hand-rolled fake so we can control per-call behavior.
    const calls = [];
    const request = (options) => {
      const callIdx = calls.length;
      const captured = { options, headers: options.headers || {}, calls };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') {
            errorCb = cb;
            // First two attempts: fire the timeout error after handlers attach.
            if (callIdx < 2) {
              queueMicrotask(() => cb(new Error('Request timed out')));
            }
          }
          return req;
        },
        setTimeout() {
          return req;
        },
        destroy(err) {
          if (err && errorCb) errorCb(err);
          return req;
        },
        write(d) {
          captured.writes = (captured.writes || []);
          captured.writes.push(d);
          return req;
        },
        end(d) {
          if (d) {
            captured.writes = (captured.writes || []);
            captured.writes.push(d);
          }
          captured.body = (captured.writes || []).join('');
          // Third call (attempt 2): deliver a successful response.
          if (callIdx >= 2) {
            const res = buildFakeRes(
              [JSON.stringify({ choices: [{ message: { content: 'recovered' } }] })],
              { statusCode: 200 },
            );
            queueMicrotask(() => responseCb && responseCb(res));
          }
          return req;
        },
      };
      captured.req = req;
      return req;
    };

    let fallbackObserved = 0;
    const client = createApiClient({ maxRetries: 3, baseDelay: 2000, baseTimeout: 120000 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'ORIGINAL_PROMPT',
      sleep: async () => {},
      request,
      fallbackPrompt: () => ({ prompt: 'FALLBACK_PROMPT' }),
      onFallback: () => {
        fallbackObserved++;
      },
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    expect(fallbackObserved).toBe(1);
    // The 3rd call (attempt 2) must have used the fallback prompt.
    const lastCall = calls[calls.length - 1];
    const body = JSON.parse(lastCall.body);
    expect(body.messages.find((m) => m.role === 'user').content).toBe('FALLBACK_PROMPT');
  });

  test('ZAI_API_URL is the documented endpoint', () => {
    expect(ZAI_API_URL).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  test('withFallback() returns a new client whose call() uses the configured fallback on timeout', async () => {
    const calls = [];
    const request = (options) => {
      const callIdx = calls.length;
      const captured = { options, headers: options.headers || {} };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') {
            errorCb = cb;
            // Time out on attempts 0 and 1 so the fallback (attempt>=1) fires;
            // attempt 2 succeeds.
            if (callIdx < 2) {
              queueMicrotask(() => cb(new Error('Request timed out')));
            }
          }
          return req;
        },
        setTimeout() {
          return req;
        },
        destroy(err) {
          if (err && errorCb) errorCb(err);
          return req;
        },
        write(d) {
          captured.writes = (captured.writes || []);
          captured.writes.push(d);
          return req;
        },
        end(d) {
          if (d) {
            captured.writes = (captured.writes || []);
            captured.writes.push(d);
          }
          captured.body = (captured.writes || []).join('');
          if (callIdx >= 2) {
            const res = buildFakeRes(
              [JSON.stringify({ choices: [{ message: { content: 'ok' } }] })],
              { statusCode: 200 },
            );
            queueMicrotask(() => responseCb && responseCb(res));
          }
          return req;
        },
      };
      return req;
    };

    const client = createApiClient({ maxRetries: 3, baseDelay: 2000, baseTimeout: 120000 }).withFallback(
      () => ({ prompt: 'FB_VIA_WITHFALLBACK' }),
    );
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'ORIG',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    expect(JSON.parse(calls[calls.length - 1].body).messages.find((m) => m.role === 'user').content).toBe(
      'FB_VIA_WITHFALLBACK',
    );
  });

  test('factory-config fallbackPrompt (string) activates the timeout-fallback path on the client', async () => {
    // Build a client with `fallbackPrompt: 'SHORT'` — the factory must
    // synthesize a fallbackPrompt function that returns { prompt: 'SHORT' } so
    // callWithRetry's timeout-fallback fires. First two calls time out; the
    // third succeeds with the fallback prompt.
    const calls = [];
    const request = (options) => {
      const callIdx = calls.length;
      const captured = { options, headers: options.headers || {}, calls };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') {
            errorCb = cb;
            // First two attempts time out so the fallback (attempt>=1) fires.
            if (callIdx < 2) {
              queueMicrotask(() => cb(new Error('Request timed out')));
            }
          }
          return req;
        },
        setTimeout() {
          return req;
        },
        destroy(err) {
          if (err && errorCb) errorCb(err);
          return req;
        },
        write(d) {
          captured.writes = (captured.writes || []);
          captured.writes.push(d);
          return req;
        },
        end(d) {
          if (d) {
            captured.writes = (captured.writes || []);
            captured.writes.push(d);
          }
          captured.body = (captured.writes || []).join('');
          if (callIdx >= 2) {
            const res = buildFakeRes(
              [JSON.stringify({ choices: [{ message: { content: 'ok' } }] })],
              { statusCode: 200 },
            );
            queueMicrotask(() => responseCb && responseCb(res));
          }
          return req;
        },
      };
      captured.req = req;
      return req;
    };

    const client = createApiClient({
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      fallbackPrompt: 'SHORT REVIEW ONLY',
    });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'ORIGINAL',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    // The 3rd call (attempt 2) must have used the fallback prompt.
    const lastCall = calls[calls.length - 1];
    const body = JSON.parse(lastCall.body);
    expect(body.messages.find((m) => m.role === 'user').content).toBe('SHORT REVIEW ONLY');
  });

  test('temperature and max_tokens flow through createApiClient.call to the request body', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    const client = createApiClient();
    await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      temperature: 0.4,
      maxTokens: 2048,
      request,
    });
    const body = JSON.parse(request.calls[0].body);
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(2048);
  });

  test('temperature and max_tokens omitted from body when client.call does not receive them', async () => {
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([JSON.stringify({ choices: [{ message: { content: 'ok' } }] })], {
        statusCode: 200,
      }),
    }));
    const client = createApiClient();
    await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      request,
    });
    const body = JSON.parse(request.calls[0].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });
});
