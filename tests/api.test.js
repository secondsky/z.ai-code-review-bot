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
  test('extracts a 4xx/5xx number from an HTTP error message', () => {
    expect(extractStatusCode('Z.ai API error 429: rate limited')).toBe(429);
    expect(extractStatusCode('Z.ai API error 503: unavailable')).toBe(503);
    expect(extractStatusCode('error 401 unauthorized')).toBe(401);
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

  // W15-A7-1: the most common transient failures for long-lived LLM POSTs —
  // mid-body resets (read ECONNRESET), broken pipes (write EPIPE), premature
  // socket close ("socket hang up"), aborted requests, and transient DNS
  // (EAI_AGAIN) — must classify as provider/retryable. Classifying them as
  // internal/non-retryable lets ONE reset in any batch kill the entire review
  // with no comment posted.
  test('W15-A7-1: transient connection failures → provider/retryable', () => {
    const messages = [
      'read ECONNRESET',
      'write EPIPE',
      'socket hang up',
      'aborted',
      'getaddrinfo EAI_AGAIN api.z.ai:443',
    ];
    for (const message of messages) {
      expect(categorizeError(new Error(message))).toEqual({
        category: 'provider',
        retryable: true,
      });
    }
  });

  // W15-A7-2: a 2xx body that fails JSON.parse (truncated by a proxy/gateway)
  // rejects "invalid JSON". Like its sibling "empty response" case, it is a
  // transient provider hiccup — one garbled 200 must not end the whole review.
  test('W15-A7-2: "invalid JSON" → provider/retryable', () => {
    expect(categorizeError(new Error('Z.ai API returned invalid JSON'))).toEqual({
      category: 'provider',
      retryable: true,
    });
  });

  // W18-D3-1: OS connect-time errno codes. 'connect ETIMEDOUT' is one of the
  // most common transient failures on GitHub runners, but 'etimedout' does NOT
  // contain the substring 'timeout', so it fell through to internal/
  // NON-retryable and killed the whole review after a single attempt. Its
  // sibling EHOSTUNREACH was equally missing while ENETUNREACH was covered.
  test('W18-D3-1: connect ETIMEDOUT and EHOSTUNREACH → provider/retryable', () => {
    expect(categorizeError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toEqual({
      category: 'provider',
      retryable: true,
    });
    expect(categorizeError(new Error('connect EHOSTUNREACH 1.2.3.4:443'))).toEqual({
      category: 'provider',
      retryable: true,
    });
  });

  // W18-D3-1: the provider's HTTP status must WIN over message substrings.
  // A 4xx body containing the word "timeout" (e.g. a 400 whose body says
  // "request timeout exceeded") is a validation error, NOT a retryable
  // timeout — retrying a deterministic 400 only burns the review budget.
  test('W18-D3-1: 400 body containing "timeout" stays validation/non-retryable', () => {
    expect(
      categorizeError(new Error('Z.ai API error 400: request timeout exceeded')),
    ).toEqual({ category: 'validation', retryable: false });
  });

  test('W18-D3-1: 5xx body containing "timeout" classifies by status → provider/retryable', () => {
    expect(
      categorizeError(new Error('Z.ai API error 503: gateway timeout')),
    ).toEqual({ category: 'provider', retryable: true });
  });

  // The new retryable classifications must NOT bleed into genuinely internal
  // errors: unrelated messages still fall through to internal/non-retryable.
  test('W15-A7-1: unrelated internal errors remain non-retryable', () => {
    expect(categorizeError(new Error('something else entirely'))).toEqual({
      category: 'internal',
      retryable: false,
    });
    expect(categorizeError(new Error('a bug in our own code'))).toEqual({
      category: 'internal',
      retryable: false,
    });
    expect(categorizeError(new Error('Z.ai API error 413: too large'))).toEqual({
      category: 'internal',
      retryable: false,
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

  // W6-3: a multi-byte UTF-8 character (emoji, CJK, accented) split across TCP
  // chunk boundaries corrupts when each chunk is decoded independently via
  // chunk.toString(). The 4-byte UTF-8 encoding of 😀 (F0 9F 98 80) split into
  // [F0 9F] + [98 80] produces U+FFFD replacement chars if decoded per-chunk.
  // Fix: accumulate Buffer chunks and decode once at the end.
  test('W6-3: multi-byte UTF-8 split across chunks decodes correctly', async () => {
    // 😀 = U+1F600 = F0 9F 98 80 in UTF-8. Split into two chunks mid-character.
    const fullJson = JSON.stringify({ choices: [{ message: { content: 'review 😀 emoji' } }] });
    const buf = Buffer.from(fullJson, 'utf8');
    // Find a split point inside the 😀 bytes (offset of F0 in the buffer).
    const emojiOffset = buf.indexOf('😀');
    const splitAt = emojiOffset + 2; // mid-character (after F0 9F, before 98 80)
    const chunk1 = buf.slice(0, splitAt);
    const chunk2 = buf.slice(splitAt);
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([chunk1, chunk2], { statusCode: 200 }),
    }));
    const content = await makeApiRequest(
      { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
      { request },
    );
    expect(content).toBe('review 😀 emoji');
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

  test('2xx with non-string content (array) → rejects, never resolves with array (CORE-6)', async () => {
    // Some providers return `content` as an array of typed segments
    // (`[{type:'text', text:'...'}]`). The guard must reject this; previously
    // the truthy array slipped past `if (!content)` and resolved raw.
    const request = makeFakeRequest(() => ({
      res: buildFakeRes(
        [
          JSON.stringify({
            choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }],
          }),
        ],
        { statusCode: 200 },
      ),
    }));
    await expect(
      makeApiRequest(
        { apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u', timeout: 1000 },
        { request },
      ),
    ).rejects.toThrow(/empty response|invalid response|non-string/i);
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

  // W18-D3-1: an OS connect timeout (ETIMEDOUT) is a transient network error.
  // Before the fix it classified as internal/non-retryable, so an
  // always-ETIMEDOUT fn got exactly ONE attempt instead of maxRetries+1.
  test('W18-D3-1: always-ETIMEDOUT fn is retried → maxRetries+1 attempts', async () => {
    const fn = recordingFn([
      new Error('connect ETIMEDOUT 1.2.3.4:443'),
      new Error('connect ETIMEDOUT 1.2.3.4:443'),
      new Error('connect ETIMEDOUT 1.2.3.4:443'),
      new Error('connect ETIMEDOUT 1.2.3.4:443'),
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
    });
    expect(out.success).toBe(false);
    expect(out.error.retryable).toBe(true);
    expect(out.error.attempts).toBe(4); // maxRetries(3) + 1
    expect(fn.calls).toHaveLength(4);
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

  // CORE-5: the fallback path previously did `attempt += 1; continue;` WITHOUT
  // calling sleep(), so the post-fallback attempt fired immediately with no
  // backoff. This test instruments `sleep` and asserts that sleep IS called
  // between the fallback-triggering attempt and the fallback attempt itself.
  test('fallback path sleeps before the fallback attempt (CORE-5 backoff)', async () => {
    const sleepCalls = [];
    const fn = recordingFn([
      new Error('Request timed out'), // attempt 0 — timeout, attempt < 1, no fallback
      new Error('Request timed out'), // attempt 1 — timeout + attempt>=1 → fallback triggers
      'FALLBACK_OK', // attempt 2 — succeeds with fallback prompt
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async (ms) => { sleepCalls.push(ms); },
      fallbackPrompt: () => ({ prompt: 'FALLBACK_PROMPT' }),
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    // sleep was called at least once: the normal retry after attempt 0's
    // timeout (attempt 0 → 1) AND the fallback backoff (attempt 1 → 2).
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
    // All sleep durations should be positive (backoff, not zero).
    for (const ms of sleepCalls) {
      expect(ms).toBeGreaterThan(0);
    }
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

  // W19-E2-2/E2-1: after the W18-D3-1 reorder, 'Z.ai API error 504: gateway
  // timeout' classifies as PROVIDER (extractable status wins over message
  // substrings), so the `category === 'timeout'` fallback gate never fired
  // for gateway timeouts — the configured ZAI_FALLBACK_PROMPT silently never
  // ran on the exact scenario it exists for. The fallback must ALSO fire for
  // a 504 (scoped deliberately: 504 is THE gateway-timeout status; a plain
  // 500/503 without 504 still does not fire — see the test below).
  test('W19-E2-2: 504 gateway timeout FIRES the fallback; retries still happen per config', async () => {
    let fallbackCalled = 0;
    const fn = recordingFn([
      new Error('Z.ai API error 504: gateway timeout'), // attempt 0 — 504, but attempt < 1, no fallback
      new Error('Z.ai API error 504: gateway timeout'), // attempt 1 — 504 + attempt>=1 → fallback
      'FB_OK', // attempt 2 — the fallback attempt succeeds
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FALLBACK_PROMPT' }),
      onFallback: (info) => {
        fallbackCalled++;
        // The triggering error is surfaced to the observer.
        expect(info.originalError.message).toContain('504');
      },
    });
    expect(out.success).toBe(true);
    expect(out.data).toBe('FB_OK');
    expect(out.usedFallback).toBe(true);
    expect(fallbackCalled).toBe(1);
    // Retry cadence unchanged: attempts 0, 1 (504s) and 2 (fallback) all ran.
    expect(fn.calls).toHaveLength(3);
  });

  test('W19-E2-2: plain 500 (no timeout text) and 503 still do NOT fire the fallback (scope: 504 only)', async () => {
    let fallbackCalled = 0;
    const opts = {
      maxRetries: 3,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FB' }),
      onFallback: () => {
        fallbackCalled++;
      },
    };
    // Plain 500 (regression guard for the existing behavior).
    const out500 = await callWithRetry(
      recordingFn([new Error('Z.ai API error 500: oops'), 'OK']),
      opts,
    );
    expect(out500.usedFallback).toBe(false);
    // 503 with "timeout" in the body: provider-category, but NOT the 504
    // gateway-timeout status — the fallback stays out (deliberate scoping).
    const out503 = await callWithRetry(
      recordingFn([new Error('Z.ai API error 503: gateway timeout'), 'OK']),
      opts,
    );
    expect(out503.usedFallback).toBe(false);
    expect(fallbackCalled).toBe(0);
  });

  // Regression: client-side timeouts (no extractable status) still fire the
  // fallback exactly as before the 504 gate was added.
  test('W19-E2-2: client timeout (no status code) still fires the fallback (regression)', async () => {
    const fn = recordingFn([
      new Error('Request timed out'), // attempt 0 — timeout, but attempt < 1
      new Error('Request timed out'), // attempt 1 — timeout + attempt>=1 → fallback
      'FB_OK', // attempt 2 — fallback attempt succeeds
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 10,
      baseTimeout: 1000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FB' }),
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
  });

  // W5-2: when a timeout triggers the fallback on the FINAL allowed attempt
  // (attempt === maxRetries), the old code did `attempt += 1; continue;` which
  // pushed attempt past maxRetries, exited the loop, and threw the internal
  // "unreachable" error — instead of returning a clean failure. The fallback
  // attempt was never executed. Realistic scenario: rate-limited 429s that
  // transition to a timeout on the last retry, with ZAI_FALLBACK_PROMPT set.
  test('W5-2: timeout on the final attempt does not crash with "unreachable"', async () => {
    const fn = recordingFn([
      new Error('Z.ai API error 429: rate limited'), // attempt 0 — retryable
      new Error('Request timed out'), // attempt 1 (=== maxRetries) — timeout → fallback would fire
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 1, // only attempts 0 and 1 are allowed
      baseDelay: 10,
      baseTimeout: 1000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FB' }),
    });
    // Must return a structured failure, NOT throw "unreachable".
    expect(out.success).toBe(false);
    expect(out.error).toBeDefined();
  });

  test('W5-2: timeout on a non-final attempt still uses the fallback successfully', async () => {
    // Regression guard: the fix must not break the normal fallback path
    // (timeout before the last attempt → fallback attempt succeeds).
    const fn = recordingFn([
      new Error('Request timed out'), // attempt 0 — timeout, attempt < 1, no fallback
      new Error('Request timed out'), // attempt 1 — timeout → fallback
      'FB_OK', // attempt 2 — fallback attempt succeeds
    ]);
    const out = await callWithRetry(fn, {
      maxRetries: 3,
      baseDelay: 10,
      baseTimeout: 1000,
      sleep: async () => {},
      fallbackPrompt: () => ({ prompt: 'FB' }),
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
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

  // W15-A7-1: a connection reset MID-BODY (2xx response, partial body chunk
  // received, then ECONNRESET) is transient. client.call must retry it and
  // resolve when the second attempt returns a full body — previously the reset
  // classified as internal/non-retryable and a single attempt killed the call.
  test('W15-A7-1: call() retries a mid-body ECONNRESET and resolves on attempt 2', async () => {
    const calls = [];
    const request = (url, options) => {
      const callIdx = calls.length;
      const captured = { url, options, headers: options?.headers || {} };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') errorCb = cb;
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
        end() {
          captured.body = (captured.writes || []).join('');
          queueMicrotask(() => {
            if (callIdx === 0) {
              // Attempt 1: response starts 2xx, a partial body chunk arrives,
              // then the connection resets — a real IncomingMessage 'error'.
              const res = new Readable({ read() {} });
              res.statusCode = 200;
              responseCb(res);
              res.push(Buffer.from('{"choices":[{"mess'));
              res.destroy(new Error('read ECONNRESET'));
            } else {
              // Attempt 2: a full, valid body.
              responseCb(
                buildFakeRes(
                  [JSON.stringify({ choices: [{ message: { content: 'recovered' } }] })],
                  { statusCode: 200 },
                ),
              );
            }
          });
          return req;
        },
      };
      captured.req = req;
      return req;
    };
    const client = createApiClient({ maxRetries: 3 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(true);
    expect(out.data).toBe('recovered');
    expect(calls).toHaveLength(2); // exactly 2 attempts: reset, then success
  });

  // W15-A7-2: a truncated 2xx body (proxy/gateway cut the transfer mid-JSON)
  // fails JSON.parse and rejects "invalid JSON". Two garbled 200s then a valid
  // one → the client must retry and resolve, not give up on the first attempt.
  test('W15-A7-2: call() retries invalid-JSON 2xx responses and resolves on attempt 3', async () => {
    let attempt = 0;
    const bodies = [
      '{"choices":[{"mess', // truncated by the proxy
      '{"partial": tru', // truncated again
      JSON.stringify({ choices: [{ message: { content: 'ok after garbage' } }] }),
    ];
    const request = makeFakeRequest(() => ({
      res: buildFakeRes([bodies[attempt++] ?? bodies[bodies.length - 1]], {
        statusCode: 200,
      }),
    }));
    const client = createApiClient({ maxRetries: 3 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(true);
    expect(out.data).toBe('ok after garbage');
    expect(request.calls).toHaveLength(3); // garbage, garbage, then success
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

  // F-API-CTX: the fallback spec's apiKey and model must reach the transport,
  // not just the prompt. A fallback returning all three fields swaps ALL THREE
  // on subsequent attempts: the user message in the body, the `model` field in
  // the body, and the Bearer apiKey in the Authorization header.
  test('call() fallback end-to-end: a fallback returning { prompt, apiKey, model } swaps ALL THREE at the transport', async () => {
    // Same hand-rolled fake as the prompt-only test above: attempts 0 and 1
    // time out (firing the fallback at attempt >= 1), attempt 2 succeeds.
    const calls = [];
    const request = (url, options) => {
      const callIdx = calls.length;
      const captured = { url, options, headers: options.headers || {}, calls };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') {
            errorCb = cb;
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

    const client = createApiClient({ maxRetries: 3, baseDelay: 2000, baseTimeout: 120000 });
    const out = await client.call({
      apiKey: 'K1',
      model: 'M1',
      systemPrompt: 's',
      userPrompt: 'ORIGINAL_PROMPT',
      sleep: async () => {},
      request,
      fallbackPrompt: () => ({ prompt: 'FALLBACK_PROMPT', apiKey: 'K2', model: 'M2' }),
    });
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    // Pre-fallback attempts carried the ORIGINAL key/model at the transport.
    const firstBody = JSON.parse(calls[0].body);
    expect(firstBody.model).toBe('M1');
    expect(calls[0].headers.Authorization).toBe('Bearer K1');
    // The fallback attempt (3rd call) swapped ALL THREE at the transport.
    const lastCall = calls[calls.length - 1];
    const body = JSON.parse(lastCall.body);
    expect(body.messages.find((m) => m.role === 'user').content).toBe('FALLBACK_PROMPT');
    expect(body.model).toBe('M2');
    expect(lastCall.headers.Authorization).toBe('Bearer K2');
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

  test('BUG3: maxRetries is clamped to [0,10] — a runaway maxRetries does not cause ~1M attempts', async () => {
    // A misconfigured maxRetries: 1000000 would cause ~1M attempts on a
    // retryable error. The factory must clamp it to a sane ceiling.
    let attemptCount = 0;
    const request = makeFakeRequest(() => {
      attemptCount++;
      // Always 500 → retryable, so the loop runs until it gives up.
      return { res: buildFakeRes(['err'], { statusCode: 500 }) };
    });
    const client = createApiClient({ maxRetries: 1000000, baseDelay: 2000, baseTimeout: 120000 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(false);
    // Clamped to 10 → at most 11 attempts (0..10 inclusive).
    expect(attemptCount).toBeLessThanOrEqual(11);
    expect(attemptCount).toBeLessThan(100); // hard guard against runaway
  });

  test('BUG3: negative maxRetries is clamped to 0 (a single attempt, no retries)', async () => {
    let attemptCount = 0;
    const request = makeFakeRequest(() => {
      attemptCount++;
      return { res: buildFakeRes(['err'], { statusCode: 500 }) };
    });
    const client = createApiClient({ maxRetries: -5, baseDelay: 2000, baseTimeout: 120000 });
    const out = await client.call({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      sleep: async () => {},
      request,
    });
    expect(out.success).toBe(false);
    // maxRetries clamped to 0 → exactly 1 attempt.
    expect(attemptCount).toBe(1);
  });
});

/* ============================================================ *
 * EDGE-CASE TESTS (Task 4)
 *
 * These pin down known limitations and boundary conditions of
 * the existing implementation. They do NOT change production
 * code; they lock in current behavior so regressions surface.
 * ============================================================ */

/* ------------------------------------------------------------ *
 * extractStatusCode — context-aware extraction (FIXED)
 * ------------------------------------------------------------ */

describe('extractStatusCode (edge cases)', () => {
  test('does NOT extract a 3-digit code from a filename (context-aware)', () => {
    // FIX: "404.js" is a filename, not an HTTP status. The extractor now
    // requires the code to appear in an HTTP-error context (e.g. after
    // "error", "status", "code") rather than glued to a file extension.
    expect(extractStatusCode('error in file 404.js')).toBeNull();
  });

  test('does NOT extract a 4xx code from prose like "RFC 418" (context-aware)', () => {
    // FIX: "418" in "RFC 418" is an RFC number, not an HTTP status.
    expect(extractStatusCode('see RFC 418 for details')).toBeNull();
  });

  test('extracts code from the production error format "Z.ai API error NNN:"', () => {
    expect(extractStatusCode('Z.ai API error 429: rate limited')).toBe(429);
    expect(extractStatusCode('Z.ai API error 500: internal')).toBe(500);
    expect(extractStatusCode('Z.ai API error 403: forbidden')).toBe(403);
  });

  test('extracts code after "status" or "code" keyword', () => {
    expect(extractStatusCode('HTTP status 502')).toBe(502);
    expect(extractStatusCode('status code 401 unauthorized')).toBe(401);
    expect(extractStatusCode('response code": 403')).toBe(403);
  });

  test('returns null when no 3-digit 4xx/5xx code is present anywhere', () => {
    // 2xx/3xx codes are ignored; pure text yields null.
    expect(extractStatusCode('Request timed out')).toBeNull();
    expect(extractStatusCode('all good: 200 ok')).toBeNull();
    expect(extractStatusCode('redirect 301')).toBeNull();
    expect(extractStatusCode('code is only 2 digits: 50')).toBeNull();
  });

  test('returns null for null / undefined / non-string input', () => {
    expect(extractStatusCode(null)).toBeNull();
    expect(extractStatusCode(undefined)).toBeNull();
  });
});

/* ------------------------------------------------------------ *
 * categorizeError — full table-driven branch coverage
 * ------------------------------------------------------------ */

describe('categorizeError (table-driven branches)', () => {
  // Each case drives exactly one branch of the if/else chain in categorizeError.
  const cases = [
    // timeout branch — keyword match (no extractable status code in these
    // messages; per W18-D3-1 an extractable status code now wins over the
    // timeout keyword)
    { name: 'message containing "timeout" → timeout/retryable', message: 'Request timeout', expected: { category: 'timeout', retryable: true } },
    { name: 'message containing "timed out" → timeout/retryable', message: 'operation timed out', expected: { category: 'timeout', retryable: true } },
    // rate-limit branch
    { name: 'status 429 → rate-limit/retryable', message: 'Z.ai API error 429: slow down', expected: { category: 'rate-limit', retryable: true } },
    // auth branch
    { name: 'status 401 → auth/non-retryable', message: 'Z.ai API error 401: unauthorized', expected: { category: 'auth', retryable: false } },
    { name: 'status 403 → auth/non-retryable', message: 'Z.ai API error 403: forbidden', expected: { category: 'auth', retryable: false } },
    // validation branch
    { name: 'status 400 → validation/non-retryable', message: 'Z.ai API error 400: bad request', expected: { category: 'validation', retryable: false } },
    // provider branch via 5xx status
    { name: 'status 500 → provider/retryable', message: 'Z.ai API error 500: oops', expected: { category: 'provider', retryable: true } },
    { name: 'status 502 → provider/retryable', message: 'Z.ai API error 502: bad gateway', expected: { category: 'provider', retryable: true } },
    { name: 'status 503 → provider/retryable', message: 'Z.ai API error 503: unavailable', expected: { category: 'provider', retryable: true } },
    // provider branch via network errors (message is lowercased; the source
    // matches the lowercase forms, so ECONNREFUSED → econnrefused matches).
    { name: 'ECONNREFUSED → provider/retryable', message: 'connect ECONNREFUSED 1.2.3.4:443', expected: { category: 'provider', retryable: true } },
    { name: 'ENETUNREACH → provider/retryable', message: 'ENETUNREACH', expected: { category: 'provider', retryable: true } },
    // provider branch via empty response
    { name: '"empty response" → provider/retryable', message: 'Z.ai API returned an empty response', expected: { category: 'provider', retryable: true } },
    // fallback: unknown error
    { name: 'unrecognized message → internal/non-retryable', message: 'something completely unknown', expected: { category: 'internal', retryable: false } },
    // fallback: 4xx that isn't 400/401/403/429 (e.g. 413) → internal
    { name: 'status 413 (not in matrix) → internal/non-retryable', message: 'Z.ai API error 413: too large', expected: { category: 'internal', retryable: false } },
  ];

  it.each(cases)('$name', ({ message, expected }) => {
    expect(categorizeError(new Error(message))).toEqual(expected);
  });

  it.each([
    { name: 'null error → internal/non-retryable', error: null },
    { name: 'undefined error → internal/non-retryable', error: undefined },
    { name: 'empty object → internal/non-retryable', error: {} },
  ])('$name', ({ error, name: _name }) => {
    // The source reads `error?.message ?? ''`; with no message it falls through
    // to the final `return { category: 'internal', retryable: false }`.
    expect(categorizeError(error)).toEqual({ category: 'internal', retryable: false });
  });

  test('timeout keyword still wins when the embedded 5xx number is NOT extractable', () => {
    // W18-D3-1 reordered categorizeError so an EXTRACTABLE status code wins
    // over the timeout keyword. The 503 here sits in '(503)' — no
    // error/status/code keyword in front — so extractStatusCode returns null
    // and the timeout branch classifies it. Pin that a bare parenthesized
    // number does not get mistaken for an HTTP status.
    expect(categorizeError(new Error('Request timed out (503)'))).toEqual({
      category: 'timeout',
      retryable: true,
    });
  });
});

/* ------------------------------------------------------------ *
 * sanitizeErrorMessage — boundary & known limitation cases
 * ------------------------------------------------------------ */

describe('sanitizeErrorMessage (edge cases)', () => {
  test('nested JSON containing a secret key is fully redacted (FIXED)', () => {
    // FIX: Step 7 now handles one level of nesting, so a JSON object with a
    // secret key AND a nested object is fully redacted.
    // Before the fix: {"token":"x","nested":{"a":1}} was NOT matched because
    // [^{}]* cannot span the inner braces, leaking the key name "token".
    const out = sanitizeErrorMessage('err {"token":"topsecret","nested":{"a":1}} done');
    // The secret key and value must not appear.
    expect(out).not.toContain('topsecret');
    expect(out).toContain('[REDACTED]');
  });

  test('nested JSON with secret in inner object is fully redacted (FIXED)', () => {
    // {"a":{"token":"x"}} — the inner object with the secret is redacted.
    const out = sanitizeErrorMessage('err {"a":{"token":"x"}} done');
    expect(out).not.toContain('"token"');
    expect(out).not.toContain(':x}');
    expect(out).toContain('[REDACTED]');
  });

  test('camelCase "apiKey" is redacted (separator is optional in the regex)', () => {
    // The regex `api[_-]?key` makes the separator optional, so camelCase
    // `apiKey` matches. Verify both `apiKey=...` and `apiKey: ...` forms.
    const out = sanitizeErrorMessage('err apiKey=topsecret boom');
    expect(out).toContain('apiKey=[REDACTED]');
    expect(out).not.toContain('topsecret');
  });

  test('camelCase "apiKey" with a colon is redacted', () => {
    const out = sanitizeErrorMessage('err apiKey: topsecret boom');
    expect(out).toContain('apiKey: [REDACTED]');
    expect(out).not.toContain('topsecret');
  });

  test('a message of exactly 500 chars is NOT truncated', () => {
    const msg = 'a'.repeat(500);
    const out = sanitizeErrorMessage(msg);
    expect(out.length).toBe(500);
    expect(out.endsWith('...')).toBe(false);
  });

  test('a message of 501 chars IS truncated with "..."', () => {
    const msg = 'a'.repeat(501);
    const out = sanitizeErrorMessage(msg);
    // Truncated to the first 500 chars + '...' (503 total).
    expect(out.length).toBe(503);
    expect(out.endsWith('...')).toBe(true);
    expect(out.startsWith('a'.repeat(500))).toBe(true);
  });

  test('Bearer token with mixed case prefix is redacted (Bearer abc123)', () => {
    const out = sanitizeErrorMessage('Bearer abc123 failed');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc123');
  });

  test('lowercase "bearer" prefix is also redacted', () => {
    // The Bearer regex uses the /i flag, so case variants match.
    const out = sanitizeErrorMessage('bearer xyz boom');
    expect(out).toContain('bearer [REDACTED]');
    expect(out).not.toContain('xyz');
  });

  test('credential URL https://user:pass@host.com/path is redacted', () => {
    const out = sanitizeErrorMessage('failed https://user:pass@host.com/path boom');
    expect(out).toContain('[URL_REDACTED]');
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('pass@host.com');
  });

  test('a raw string (not an Error object) is sanitized directly', () => {
    // The function accepts a string message; verify it passes through and
    // that redaction still applies.
    const out = sanitizeErrorMessage('Authorization: Bearer leak');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('leak');
  });

  test('an Error-like object with .message works the same as a string', () => {
    const out = sanitizeErrorMessage(new Error('Authorization: Bearer obj'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('obj');
  });

  test('empty string message returns the fallback', () => {
    // `if (!message)` catches the empty string.
    expect(sanitizeErrorMessage('')).toBe('An unknown error occurred');
  });
});

/* ------------------------------------------------------------ *
 * callWithRetry — maxRetries boundaries
 * ------------------------------------------------------------ */

describe('callWithRetry (edge cases)', () => {
  test('maxRetries: 0 → exactly ONE attempt with no retry, even for a retryable error', async () => {
    // A 5xx error is normally retryable, but with maxRetries 0 the loop runs
    // attempt 0 only and then gives up because attempt >= maxRetries.
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error('Z.ai API error 500: oops'));
    };
    const out = await callWithRetry(fn, {
      maxRetries: 0,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {},
    });
    expect(out.success).toBe(false);
    expect(out.error.attempts).toBe(1);
    expect(out.error.category).toBe('provider');
    expect(out.error.retryable).toBe(true);
    expect(calls).toBe(1);
  });

  test('non-retryable error (auth) fails immediately even with maxRetries > 0', async () => {
    // 401 is non-retryable; the loop must bail on the first attempt without
    // sleeping or retrying, regardless of maxRetries.
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error('Z.ai API error 401: no'));
    };
    const out = await callWithRetry(fn, {
      maxRetries: 5,
      baseDelay: 2000,
      baseTimeout: 120000,
      sleep: async () => {
        throw new Error('sleep should not be called for a non-retryable error');
      },
    });
    expect(out.success).toBe(false);
    expect(out.error.category).toBe('auth');
    expect(out.error.attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

/* ------------------------------------------------------------ *
 * createApiClient — maxRetries clamping & fallbackPrompt normalization
 * ------------------------------------------------------------ */

describe('createApiClient (edge cases)', () => {
  test('maxRetries: 1000000 is clamped to 10', () => {
    const client = createApiClient({ maxRetries: 1000000 });
    expect(client.config.maxRetries).toBe(10);
  });

  test('maxRetries: 0 stays at 0', () => {
    const client = createApiClient({ maxRetries: 0 });
    expect(client.config.maxRetries).toBe(0);
  });

  test('maxRetries: -5 (negative) is clamped to 0', () => {
    const client = createApiClient({ maxRetries: -5 });
    expect(client.config.maxRetries).toBe(0);
  });

  test('maxRetries: undefined falls back to the default (3)', () => {
    const client = createApiClient({});
    expect(client.config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  test('string fallbackPrompt is normalized to a function and activates the timeout-fallback path', async () => {
    // Build a client with `fallbackPrompt: 'SHORT'` (a string). The factory
    // must wrap it into `() => ({ prompt: 'SHORT' })` so the retry loop's
    // timeout-fallback fires. First two attempts time out (triggering the
    // fallback at attempt 1); the third succeeds with the fallback prompt.
    const calls = [];
    const request = (url, options) => {
      const callIdx = calls.length;
      const captured = { url, options, headers: options?.headers || {} };
      calls.push(captured);
      let responseCb = null;
      let errorCb = null;
      const req = {
        on(event, cb) {
          if (event === 'response') responseCb = cb;
          else if (event === 'error') {
            errorCb = cb;
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
    // The normalization worked → fallback fired and the call succeeded.
    expect(out.success).toBe(true);
    expect(out.usedFallback).toBe(true);
    // The third attempt carried the normalized fallback prompt.
    const lastCall = calls[calls.length - 1];
    const body = JSON.parse(lastCall.body);
    expect(body.messages.find((m) => m.role === 'user').content).toBe('SHORT REVIEW ONLY');
  });
});
