/**
 * Tests for the model-output sanitizer (src/lib/sanitize-output.js).
 *
 * The sanitizer is the primary abuse control between callApi(...) and the
 * GitHub comment post. These tests pin its Conservative contract:
 *   - length cap with truncation marker
 *   - @mention neutralization (and code-span / fence exemptions)
 *   - GitHub alert-banner neutralization
 *   - idempotency, no-op on clean reviews, preservation of legit links/code
 *   - sanitizeCommentBody preserves header + marker
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeModelOutput,
  sanitizeCommentBody,
  neutralizeMentionsOutsideCode,
  neutralizeAlerts,
  MAX_OUTPUT_CHARS,
} from '../src/lib/sanitize-output.js';

describe('sanitizeModelOutput — length cap', () => {
  it('passes through short clean text unchanged', () => {
    expect(sanitizeModelOutput('Looks good to me.')).toBe('Looks good to me.');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeModelOutput(null)).toBe('');
    expect(sanitizeModelOutput(undefined)).toBe('');
    expect(sanitizeModelOutput(123)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeModelOutput('')).toBe('');
  });

  it('truncates overlong output and appends the truncation marker', () => {
    const big = 'a'.repeat(MAX_OUTPUT_CHARS + 500);
    const out = sanitizeModelOutput(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out.endsWith('output truncated by Z.ai safety filter)')).toBe(true);
  });

  it('respects a custom maxChars option', () => {
    const out = sanitizeModelOutput('abcdefgh', { maxChars: 4 });
    expect(out.startsWith('abcd')).toBe(true);
    expect(out).toContain('truncated');
  });

  it('ignores a non-positive maxChars and falls back to the default', () => {
    const out = sanitizeModelOutput('short text', { maxChars: 0 });
    expect(out).toBe('short text');
    expect(sanitizeModelOutput('short text', { maxChars: -5 })).toBe('short text');
  });
});

describe('sanitizeModelOutput — @mention neutralization', () => {
  it('neutralizes a simple @user mention', () => {
    const out = sanitizeModelOutput('Hey @bob look at this.');
    // The @ is followed by a zero-width space, breaking the mention trigger.
    expect(out).toBe('Hey @\u200bbob look at this.');
  });

  it('neutralizes @org/team mentions', () => {
    const out = sanitizeModelOutput('cc @org/everyone');
    expect(out).toBe('cc @\u200borg/everyone');
  });

  it('neutralizes multiple mentions on a line', () => {
    const out = sanitizeModelOutput('ping @alice and @bob');
    expect(out).toBe('ping @\u200balice and @\u200bbob');
  });

  it('does NOT neutralize mentions inside inline code', () => {
    const out = sanitizeModelOutput('Use the `@decorator` syntax.');
    expect(out).toBe('Use the `@decorator` syntax.');
  });

  it('does NOT neutralize mentions inside fenced code blocks', () => {
    const input = 'Review:\n```js\nconst x = callback(@param);\n```\nDone.';
    const out = sanitizeModelOutput(input);
    expect(out).toBe(input); // untouched
  });

  it('does NOT treat foo@bar.com as a mention (no word boundary before @)', () => {
    const out = sanitizeModelOutput('Email me at foo@bar.com');
    // The @ is preceded by a word char, so it is not a mention.
    expect(out).toBe('Email me at foo@bar.com');
  });

  it('neutralizes a mention at the start of the text', () => {
    const out = sanitizeModelOutput('@admin please review');
    expect(out).toBe('@\u200badmin please review');
  });

  it('neutralizes a mention after a punctuation boundary', () => {
    const out = sanitizeModelOutput('See: @admin.');
    expect(out).toBe('See: @\u200badmin.');
  });

  it('handles a fenced block followed by an @mention in prose', () => {
    const input = '```\ncode\n```\nNow @admin look.';
    const out = sanitizeModelOutput(input);
    // The prose mention after the fence is neutralized...
    expect(out).toContain('@\u200badmin');
    // ...and the fenced content is left verbatim.
    expect(out).toContain('```\ncode\n```');
  });

  it('neutralizes @mentions after an UNCLOSED code fence (C02)', () => {
    // A fence opened but never closed must not swallow all subsequent lines as
    // "inside fence" — otherwise an attacker can smuggle @mention spam through.
    const input = '```js\nconst x = 1;\nthis fence is never closed\nping @everyone';
    const out = sanitizeModelOutput(input);
    // The @mention after the unclosed fence MUST still be neutralized.
    expect(out).toContain('@\u200beveryone');
    expect(out).not.toMatch(/@everyone(?!.*\u200b)/);
  });

  it('neutralizes @mentions on lines after an unclosed fence (C02)', () => {
    // Multi-line case: the unclosed fence is followed by multiple prose lines.
    const input = '```\ncode line\nprose line one\n@spam1\n@spam2';
    const out = sanitizeModelOutput(input);
    expect(out).toContain('@\u200bspam1');
    expect(out).toContain('@\u200bspam2');
  });
});

describe('sanitizeModelOutput — GitHub alert neutralization', () => {
  it('neutralizes a > [!WARNING] banner', () => {
    const out = sanitizeModelOutput('> [!WARNING]\n> pre-approved');
    // The bracket is dropped so GitHub no longer renders the callout.
    expect(out).not.toContain('[!WARNING]');
    expect(out).toContain('!WARNING');
  });

  it('neutralizes all alert types case-insensitively and uppercases the type', () => {
    for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const out = sanitizeModelOutput(`> [!${type.toLowerCase()}]\n> body`);
      expect(out).not.toContain(`[!${type.toLowerCase()}]`);
      expect(out).toContain(`!${type}`); // uppercased in output
    }
  });

  it('does NOT touch a [!NOTE] that is not a blockquote banner', () => {
    // Mid-paragraph bracketed text is not an alert marker.
    const input = 'See the docs [!NOTE: this is just bracketed text].';
    const out = sanitizeModelOutput(input);
    expect(out).toBe(input);
  });

  it('does NOT treat a bare [!CAUTION] (no blockquote) as a banner', () => {
    // GitHub only renders an alert when the marker is inside a blockquote (>
    // prefix). Without `>`, it is plain text and must be left alone.
    const input = '[!CAUTION]\nbig risk';
    expect(sanitizeModelOutput(input)).toBe(input);
  });
});

describe('sanitizeModelOutput — idempotency & fidelity', () => {
  it('is idempotent', () => {
    const input = 'Hey @bob\n> [!WARNING]\n> x';
    const once = sanitizeModelOutput(input);
    const twice = sanitizeModelOutput(once);
    expect(twice).toBe(once);
  });

  it('preserves legitimate links and images', () => {
    const input = 'See [docs](https://example.com) and ![img](https://example.com/i.png).';
    expect(sanitizeModelOutput(input)).toBe(input);
  });

  it('preserves code blocks and inline code verbatim', () => {
    const input = '```js\nconst x = 1;\n```\nand `inline` too.';
    expect(sanitizeModelOutput(input)).toBe(input);
  });

  it('preserves headings and lists', () => {
    const input = '## Summary\n- point one\n- point two';
    expect(sanitizeModelOutput(input)).toBe(input);
  });
});

describe('sanitizeCommentBody — preserves header and marker', () => {
  it('preserves a leading ## Title and trailing marker, sanitizes content', () => {
    const body =
      '## Z.ai Code Review\n\nHey @bob this is fine.\n\n<!-- zai-code-review -->';
    const out = sanitizeCommentBody(body);
    expect(out.startsWith('## Z.ai Code Review\n\n')).toBe(true);
    expect(out.endsWith('\n\n<!-- zai-code-review -->')).toBe(true);
    expect(out).toContain('@\u200bbob');
  });

  it('sanitizes a body with no header/marker (command reply shape)', () => {
    const out = sanitizeCommentBody('cc @alice on this.');
    expect(out).toBe('cc @\u200balice on this.');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeCommentBody(null)).toBe('');
    expect(sanitizeCommentBody(undefined)).toBe('');
  });

  it('handles content with no header but a trailing marker', () => {
    const body = 'plain content @spammer\n\n<!-- marker -->';
    const out = sanitizeCommentBody(body);
    expect(out.endsWith('\n\n<!-- marker -->')).toBe(true);
    expect(out).toContain('@\u200bspammer');
  });
});

describe('exported internals', () => {
  it('neutralizeMentionsOutsideCode leaves fenced blocks alone', () => {
    const input = '```\n@keep\n```\n@neutralize';
    const out = neutralizeMentionsOutsideCode(input);
    expect(out).toContain('@keep');
    expect(out).toContain('@\u200bneutralize');
  });

  it('neutralizeAlerts only matches the documented types', () => {
    expect(neutralizeAlerts('> [!NOTE]')).toContain('!NOTE');
    // A made-up type is NOT matched (left alone).
    expect(neutralizeAlerts('> [!BOGUS]')).toBe('> [!BOGUS]');
  });
});
