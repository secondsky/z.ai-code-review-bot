/**
 * The SINGLE Z.ai HTTP client used everywhere in this Action.
 *
 * Background: the two parent actions this project merges had TWO divergent
 * Z.ai clients — a no-retry one for auto-review and a full-retry one for
 * commands. This module replaces both with one client that owns retries,
 * timeouts, error categorization, and secret redaction.
 *
 * Design notes
 * ------------
 * - One endpoint, one transport (Node's built-in `https`). No streaming,
 *   no fetch/axios, no abort controllers beyond the timeout `destroy`.
 *   (YAGNI per the task brief.)
 * - The transport and `sleep` are INJECTABLE so unit tests are deterministic:
 *   no real network, no real multi-second backoff. `makeApiRequest` takes
 *   `{ request = https.request }`; `callWithRetry`/`createApiClient` take
 *   `{ sleep }`. Tests pass fakes; production uses the defaults.
 * - The apiKey is NEVER logged. `sanitizeErrorMessage` is the safety net for
 *   any error message that may have flowed through a request, but no code
 *   here prints the key proactively.
 *
 * @module src/lib/api.js
 */

import https from 'node:https';

/* ------------------------------------------------------------------ *
 * Constants (exact values per the task brief — do not change)
 * ------------------------------------------------------------------ */

export const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
export const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes — applies to a SINGLE attempt
export const DEFAULT_MAX_RETRIES = 3; // → up to 4 attempts total
export const DEFAULT_BASE_DELAY_MS = 2000; // backoff base
export const MAX_RESPONSE_SIZE = 1024 * 1024; // 1 MiB response cap
// Progressive timeout multipliers: each retry gets a shorter timeout.
const PROGRESSIVE_TIMEOUT_MULTIPLIERS = [1.0, 0.67, 0.5, 0.33];
const MIN_TIMEOUT_MS = 10000; // floor for the progressive timeout

/* ------------------------------------------------------------------ *
 * Error classification
 * ------------------------------------------------------------------ */

/**
 * Regex-extract a 4xx/5xx status code from an error message.
 *
 * Context-aware: the code must appear in an HTTP-error context — preceded by
 * "error", "status", "code", a colon, or a quote+colon — so that numbers in
 * prose (RFC 418), filenames (404.js), or other non-HTTP contexts are NOT
 * mistaken for status codes. The production error format
 * `Z.ai API error NNN: ...` always matches.
 *
 * @param {string} message
 * @returns {number | null}
 */
export function extractStatusCode(message) {
  const str = String(message ?? '');
  // Require the 3-digit code to be preceded by an HTTP-error keyword
  // ("error"/"status"/"code") OR a quote+colon (the JSON `code":NNN` form).
  // A BARE colon is intentionally NOT accepted: a message like
  // "error while reading file: 500.js" mentions a local file, not HTTP 500,
  // and must not be misclassified as a retryable provider error.
  const match = str.match(/(?:error|status|code\b|["'])\s*:?\s*([45]\d{2})\b/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Classify an error so the retry loop knows whether to keep trying and whether
 * the fallback path applies. The matrix is exact per the brief; status codes
 * are pulled from the (lowercased) message via {@link extractStatusCode}.
 *
 * @param {Error | { message?: string } | null | undefined} error
 * @returns {{ category: string, retryable: boolean }}
 */
export function categorizeError(error) {
  const message = String(error?.message ?? '').toLowerCase();

  // W18-D3-1: status-code checks run FIRST. The production error shape
  // `Z.ai API error NNN: <provider body>` embeds the real HTTP status in the
  // message, and provider bodies often contain the word "timeout" (e.g. a 400
  // whose body says "request timeout exceeded", or a 503 "gateway timeout").
  // The status the provider actually returned must win over message
  // substrings, or a permanent 400 was misclassified as a retryable timeout.
  const statusCode = extractStatusCode(message);
  if (statusCode === 429) return { category: 'rate-limit', retryable: true };
  if (statusCode === 401 || statusCode === 403) {
    return { category: 'auth', retryable: false };
  }
  if (statusCode === 400) return { category: 'validation', retryable: false };
  if (statusCode >= 500 && statusCode < 600) {
    return { category: 'provider', retryable: true };
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return { category: 'timeout', retryable: true };
  }
  // Lowercase once — `ECONNREFUSED` becomes `econnrefused`, so a single
  // lowercase check suffices (the fork had redundant mixed-case checks).
  // W15-A7-1: beyond connect-time ECONNREFUSED/ENETUNREACH, the most common
  // transient failures of long-lived LLM POSTs are mid-body connection resets
  // (ECONNRESET), broken pipes (EPIPE), premature socket closes
  // ("socket hang up"), aborted requests, and transient DNS failures
  // (EAI_AGAIN). Treating any of these as internal/non-retryable lets one
  // reset in any batch kill the entire review with no comment posted.
  // W18-D3-1: add ETIMEDOUT and EHOSTUNREACH. The OS connect-timeout errno is
  // one of the most common transient errors on GitHub runners, but 'etimedout'
  // does NOT contain the substring 'timeout', so it previously fell through to
  // internal/non-retryable and killed the whole review after ONE attempt.
  // EHOSTUNREACH is the missing sibling of the already-covered ENETUNREACH.
  if (
    message.includes('econnrefused') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('epipe') ||
    message.includes('socket hang up') ||
    message.includes('aborted') ||
    message.includes('eai_again')
  ) {
    return { category: 'provider', retryable: true };
  }
  // W15-A7-2: a 2xx body that fails JSON.parse ("invalid JSON" — e.g.
  // truncated by a proxy/gateway) is as transient as an empty 2xx body, so it
  // gets the same retryable-provider treatment. A garbled 200 must not end
  // the whole review.
  if (message.includes('empty response') || message.includes('invalid json')) {
    return { category: 'provider', retryable: true };
  }
  return { category: 'internal', retryable: false };
}

/* ------------------------------------------------------------------ *
 * Secret-aware error message sanitization
 * ------------------------------------------------------------------ */

/**
 * Produce a safe-to-log message from an arbitrary error. Runs the exact
 * 9-step redaction pipeline from the brief:
 *   1. fallback for empty message
 *   2. extract nested error.message / error.error.message from trailing JSON
 *   3. Bearer <token>      → Bearer [REDACTED]
 *   4. api_key=... / apiKey:... → <prefix>[REDACTED]
 *   5. Authorization: ...  → Authorization: [REDACTED]
 *   6. https://user:pass@  → [URL_REDACTED]
 *   7. JSON blobs with api_key/token/secret/password/credential → [REDACTED]
 *   8. truncate > 500 chars
 *   9. return
 *
 * @param {Error | { message?: string } | null | undefined} error
 * @returns {string}
 */
export function sanitizeErrorMessage(error) {
  // Accept either an Error/object with `.message` or a raw string message.
  let message;
  if (typeof error === 'string') {
    message = error;
  } else {
    message = error?.message;
  }
  if (!message) return 'An unknown error occurred';
  message = String(message);

  // (2) Extract a meaningful API message from a trailing JSON object.
  const jsonMatch = message.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const inner =
        parsed?.error?.message ||
        parsed?.error?.error?.message ||
        parsed?.message;
      if (inner) {
        message = message.slice(0, jsonMatch.index) + ': ' + inner;
      }
    } catch {
      // ignore parse failures — keep the original message
    }
  }

  // (3) Bearer tokens.
  message = message.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  // (4) api_key / apiKey / api-key assignments.
  message = message.replace(/(api[_-]?key[=:]?\s*)[^\s,}]+/gi, '$1[REDACTED]');
  // (5) Authorization header values.
  message = message.replace(/(Authorization:\s*)[^\s]+/gi, '$1[REDACTED]');
  // (6) Credential URLs.
  message = message.replace(/https?:\/\/[^\s]*:[^\s@]+@[^\s]*/gi, '[URL_REDACTED]');
  // (7) JSON blobs containing secret-like keys. Handles one level of nesting
  // so an outer object containing both a secret key and a nested sub-object
  // is fully redacted (e.g. {"token":"x","cfg":{"a":1}} → [REDACTED]).
  message = message.replace(
    /\{(?:[^{}]|\{[^{}]*\})*"(?:api[_-]?key|token|secret|password|credential)(?:[^{}]|\{[^{}]*\})*\}/gi,
    '[REDACTED]',
  );

  // (8) Truncate.
  if (message.length > 500) {
    message = message.substring(0, 500) + '...';
  }

  // (9)
  return message;
}

/* ------------------------------------------------------------------ *
 * Local sleep helper (injectable)
 * ------------------------------------------------------------------ */

/**
 * Default sleep using real `setTimeout`. Tests inject a no-op `sleep` so the
 * retry/backoff logic can be exercised without multi-second waits.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * makeApiRequest — a single POST, transport-injectable
 * ------------------------------------------------------------------ */

/**
 * Issue a single POST to {@link ZAI_API_URL} and resolve the assistant message
 * `content` string.
 *
 * Injection seam: the second argument's `request` field lets tests substitute
 * the transport. It defaults to Node's `https.request`. The chosen seam —
 * `makeApiRequest(params, { request = https.request } = {})` — is the simplest
 * robust option per the brief: `https` is built-in and synchronous to import,
 * so there is no lazy-import ceremony, and tests pass `{ request: fakeRequest }`.
 *
 * Sampling knobs: `temperature` and `maxTokens` are forwarded into the request
 * body as `temperature` and `max_tokens` ONLY when provided as numbers. They
 * are omitted otherwise (the provider applies its own defaults).
 *
 * @param {{ apiKey: string, model: string, systemPrompt: string, userPrompt: string, timeout: number, temperature?: number, maxTokens?: number }} params
 * @param {{ request?: (options: object) => any }} [deps]
 * @returns {Promise<string>} the assistant message content
 */
export function makeApiRequest(params, deps = {}) {
  const { apiKey, model, systemPrompt, userPrompt, timeout } = params;
  const { request = https.request } = deps;

  return new Promise((resolve, reject) => {
    let settled = false;
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === 'number' ? { max_tokens: params.maxTokens } : {}),
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    // Node's `https.request(url, options)` signature accepts a URL string as
    // the first arg; passing ZAI_API_URL here ensures the production transport
    // actually POSTs to Z.ai. Fake transports receive the URL as arg 0 and the
    // options object as arg 1.
    const req = request(ZAI_API_URL, options);

    // W6-3: accumulate response chunks as Buffers and decode ONCE at the end.
    // Decoding each chunk independently via chunk.toString() corrupts multi-byte
    // UTF-8 sequences (emoji, CJK, accented chars) split across TCP boundaries.
    const responseChunks = [];
    let responseBytes = 0;
    let destroyed = false;

    /**
     * Destroy the underlying request with an error that will surface via the
     * 'error' event (timeout, size-limit). Marks `destroyed` so the teardown
     * path in `fail` does not re-destroy without an argument and clobber the
     * original cause captured by callers/tests.
     */
    const destroyWithError = (err) => {
      destroyed = true;
      try {
        req.destroy(err);
      } catch {
        /* ignore — the 'error' event may have already fired */
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Best-effort teardown. Do NOT pass an error here — that would clobber
      // the original destroy error captured by callers/tests; an error-driven
      // path (timeout/size-limit) has already destroyed with the real cause.
      if (!destroyed) {
        destroyed = true;
        try {
          req.destroy();
        } catch {
          /* ignore destroy errors during teardown */
        }
      }
      reject(err);
    };

    req.setTimeout(timeout, () => {
      destroyWithError(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      // Includes the timeout destroy ('Request timed out') and size-limit
      // destroy ('Z.ai API response exceeded size limit').
      fail(err);
    });

    req.on('response', (res) => {
      res.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buf.length;
        if (responseBytes > MAX_RESPONSE_SIZE) {
          destroyWithError(new Error('Z.ai API response exceeded size limit'));
          return;
        }
        responseChunks.push(buf);
      });
      res.on('end', () => {
        if (settled) return;
        // W6-3: decode the concatenated Buffers once, so multi-byte UTF-8
        // sequences split across chunks are reconstructed correctly.
        const responseBody = Buffer.concat(responseChunks).toString('utf8');
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          let parsed;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            settled = true;
            reject(new Error('Z.ai API returned invalid JSON'));
            return;
          }
          const content = parsed?.choices?.[0]?.message?.content;
          if (!content || typeof content !== 'string') {
            settled = true;
            reject(new Error('Z.ai API returned an empty response'));
            return;
          }
          settled = true;
          resolve(content);
          return;
        }
        settled = true;
        reject(new Error(`Z.ai API error ${status}: ${responseBody.slice(0, 200)}`));
      });
      res.on('error', (err) => {
        fail(err);
      });
    });

    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * callWithRetry — owns the loop, progressive timeouts, and fallback
 * ------------------------------------------------------------------ */

/**
 * Run `fn` with retries and (optional) fallback. `fn` is built by the client's
 * `call()` and represents one attempt.
 *
 * Signature note: the brief's conceptual signature is `fn(attempt,
 * currentTimeout)`. We add a third `override` argument: `null` until a
 * fallback fires, then a `{ prompt, apiKey?, model? }` whose PRESENT keys
 * replace the closure's own prompt/apiKey/model on every subsequent attempt.
 * The override is applied as one wholesale replacement (a fresh object each
 * time the fallback fires, never mutated in place), so each attempt receives
 * a stable snapshot. This is the documented improvement to the brief's seam;
 * the first two positional args (and the test assertions about them) are
 * unchanged.
 *
 * @param {(attempt: number, currentTimeout: number, override: { prompt: string, apiKey?: string, model?: string } | null) => Promise<any>} fn
 * @param {{
 *   maxRetries?: number,
 *   baseDelay?: number,
 *   baseTimeout?: number,
 *   fallbackPrompt?: () => ({ prompt: string, apiKey?: string, model?: string } | null),
 *   onFallback?: (info: { attempt: number, originalError: Error, fallbackInfo: any }) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<{ success: boolean, data?: any, error?: { category: string, message: string, retryable: boolean, attempts: number, totalDuration: number }, usedFallback: boolean }>}
 */
export async function callWithRetry(fn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelay = DEFAULT_BASE_DELAY_MS,
    baseTimeout = DEFAULT_TIMEOUT_MS,
    fallbackPrompt = null,
    onFallback = null,
    sleep = defaultSleep,
  } = options;

  const startTime = Date.now();
  let usedFallback = false;
  const lastIdx = PROGRESSIVE_TIMEOUT_MULTIPLIERS.length - 1;
  // Per-attempt fallback override: `null` until the fallback fires, then ONE
  // wholesale replacement with the fallback spec. Each attempt gets the
  // current snapshot by value of the binding — never a mutated shared object.
  let override = null;

  let attempt = 0;
  // Loop from 0..maxRetries inclusive (≤ maxRetries+1 attempts).
  while (attempt <= maxRetries) {
    const currentTimeout = Math.max(
      MIN_TIMEOUT_MS,
      Math.floor(baseTimeout * PROGRESSIVE_TIMEOUT_MULTIPLIERS[Math.min(attempt, lastIdx)]),
    );

    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await fn(attempt, currentTimeout, override);
      return { success: true, data: result, usedFallback };
    } catch (error) {
      const { category, retryable } = categorizeError(error);

      // W19-E2-2/E2-1: the fallback fires on a timeout-category error OR a
      // 504. After the W18-D3-1 reorder, 'Z.ai API error 504: gateway
      // timeout' classifies as PROVIDER (the extractable status wins over
      // message substrings), so a `category === 'timeout'`-only gate never
      // fired on the exact gateway-timeout scenario ZAI_FALLBACK_PROMPT
      // exists for. extractStatusCode is consulted HERE (rather than widening
      // categorizeError's return shape) so the pinned {category, retryable}
      // contract is untouched; the scope is deliberately 504-only — a plain
      // 500/503 (even with "timeout" in the body) keeps the old behavior.
      const fallbackEligible =
        category === 'timeout' || extractStatusCode(error?.message) === 504;

      // Fallback fires ONLY on a fallback-eligible error at attempt >= 1,
      // when a fallback is configured and hasn't been used yet, AND there is
      // at least one remaining loop iteration to actually run the fallback
      // attempt. W5-2: previously, firing the fallback on the final attempt
      // did `attempt += 1; continue;` which pushed attempt past maxRetries,
      // exited the loop, and threw the internal "unreachable" error instead
      // of returning a clean failure.
      if (
        fallbackEligible &&
        attempt >= 1 &&
        attempt < maxRetries &&
        fallbackPrompt &&
        !usedFallback
      ) {
        const fb = fallbackPrompt();
        if (fb && fb.prompt) {
          usedFallback = true;
          // One wholesale replacement: subsequent attempts merge these keys
          // over the closure's own prompt/apiKey/model. Keys the fallback did
          // not specify (undefined) are simply absent, so the caller's own
          // values keep applying for those fields.
          override = {
            prompt: fb.prompt,
            ...(fb.apiKey !== undefined && { apiKey: fb.apiKey }),
            ...(fb.model !== undefined && { model: fb.model }),
          };
          if (onFallback) {
            onFallback({ attempt, originalError: error, fallbackInfo: fb });
          }
          // CORE-5: sleep before the fallback attempt so we don't immediately
          // hammer a struggling provider. The fallback only fires once per
          // call, so this is at most one extra backoff, and it keeps the
          // retry cadence consistent with the normal retry path.
          const fbDelay = baseDelay * 2 ** attempt + Math.floor(Math.random() * 1000);
          // eslint-disable-next-line no-await-in-loop
          await sleep(fbDelay);
          attempt += 1;
          continue;
        }
      }

      // Give up: not retryable, or we've exhausted attempts.
      if (!retryable || attempt >= maxRetries) {
        return {
          success: false,
          data: null,
          error: {
            category,
            message: sanitizeErrorMessage(error),
            retryable,
            attempts: attempt + 1,
            totalDuration: Date.now() - startTime,
          },
          usedFallback,
        };
      }

      // Retryable: exponential backoff with jitter, then next attempt.
      const delay = baseDelay * 2 ** attempt + Math.floor(Math.random() * 1000);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
      attempt += 1;
    }
  }

  // Unreachable in practice (loop returns on every path).
  throw new Error('unreachable: callWithRetry loop exited unexpectedly');
}

/* ------------------------------------------------------------------ *
 * createApiClient — the factory used everywhere in the Action
 * ------------------------------------------------------------------ */

/**
 * Build a Z.ai API client.
 *
 * `fallbackPrompt` accepts either a function (the historical shape used by
 * `withFallback`) or a plain STRING. A string is normalized to a function that
 * returns `{ prompt: <string> }` so callWithRetry's timeout-fallback mechanism
 * can fire. This is the seam Phase 6.2 wires `config.fallbackPrompt` (a string)
 * into: the index.js adapter passes the config string straight to the factory.
 *
 * @param {{ timeout?: number, maxRetries?: number, baseDelay?: number, fallbackPrompt?: (() => any) | string }} [config]
 * @returns {{
 *   call: (args: { apiKey: string, model: string, systemPrompt: string, userPrompt: string, temperature?: number, maxTokens?: number, onFallback?: Function, fallbackPrompt?: Function, request?: Function, sleep?: Function }) => Promise<any>,
 *   withFallback: (fallbackFn: () => any) => any,
 *   config: { timeout: number, maxRetries: number, baseDelay: number },
 * }}
 */
export function createApiClient(config = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    baseDelay = DEFAULT_BASE_DELAY_MS,
    fallbackPrompt: configFallbackPrompt = null,
  } = config;
  // Clamp maxRetries to [0, 10]. A misconfigured value (e.g. 1000000) would
  // otherwise cause an enormous number of retry attempts against the provider.
  const rawRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const safeRetries = Math.min(Math.max(0, rawRetries), 10);
  const maxRetries = safeRetries;

  // Normalize a string fallbackPrompt to the function shape callWithRetry
  // expects. A non-empty string becomes `() => ({ prompt: string })`; a
  // function passes through; anything falsy disables the fallback.
  const normalizedConfigFallback = (() => {
    if (typeof configFallbackPrompt === 'string') {
      const s = configFallbackPrompt.trim();
      return s.length > 0 ? () => ({ prompt: s }) : null;
    }
    return configFallbackPrompt;
  })();

  return {
    /**
     * Send one logical request with retries. `request` and `sleep` are
     * accepted here purely for test injection (defaults are real network and
     * real setTimeout). The apiKey is forwarded to `makeApiRequest` and never
     * logged. `temperature` and `maxTokens`, when provided as numbers, are
     * forwarded to `makeApiRequest` and appear in the request body as
     * `temperature` and `max_tokens`.
     */
    async call(args = {}) {
      const {
        apiKey,
        model,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
        onFallback = null,
        fallbackPrompt: callFallbackPrompt = null,
        request: requestDep,
        sleep: sleepDep,
      } = args;

      // The per-attempt work. Merges the retry loop's `override` (null until a
      // fallback fires) over this call's own prompt/apiKey/model, so a
      // timeout-triggered fallback swaps any or all of them on subsequent
      // attempts without rebuilding this closure.
      const fn = (attempt, currentTimeout, override) => {
        const spec = { prompt: userPrompt, apiKey, model, ...(override ?? {}) };
        return makeApiRequest(
          {
            apiKey: spec.apiKey,
            model: spec.model,
            systemPrompt,
            userPrompt: spec.prompt,
            timeout: currentTimeout,
            temperature,
            maxTokens,
          },
          requestDep ? { request: requestDep } : {},
        );
      };

      const deps = {};
      if (sleepDep) deps.sleep = sleepDep;
      if (callFallbackPrompt !== null) deps.fallbackPrompt = callFallbackPrompt;
      else if (normalizedConfigFallback !== null) deps.fallbackPrompt = normalizedConfigFallback;
      if (onFallback) deps.onFallback = onFallback;

      return callWithRetry(fn, {
        maxRetries,
        baseDelay,
        baseTimeout: timeout,
        ...deps,
      });
    },

    withFallback(fallbackFn) {
      return createApiClient({ ...config, fallbackPrompt: fallbackFn });
    },

    config: { timeout, maxRetries, baseDelay },
  };
}
