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
  neutralizeMentionsInLine,
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

describe('sanitizeModelOutput — injected hash-block stripping (SCN-15)', () => {
  it('strips a spoofed <!-- zai-hashes:... --> line from model output', () => {
    const input = 'Some review text\n<!-- zai-hashes:abc123 -->\nMore text';
    const out = sanitizeModelOutput(input);
    expect(out).not.toContain('zai-hashes');
    expect(out).toContain('Some review text');
    expect(out).toContain('More text');
  });

  it('strips a spoofed <!-- zai-description:... --> line', () => {
    const input = 'Review\n<!-- zai-description:fake summary -->';
    const out = sanitizeModelOutput(input);
    expect(out).not.toContain('zai-description');
  });

  // ----- W2-2: the scheduled-review SHA marker (`<!-- zai-sha:... -->`) is a
  // forged-able HTML comment just like zai-hashes/zai-description. An attacker
  // who coaxs the model into emitting one could fool hasReviewForSha into
  // suppressing future scheduled reviews. The stripper must cover ALL zai-*
  // comment markers, not just hashes/description.
  it('strips a spoofed <!-- zai-sha:... --> line (W2-2)', () => {
    const input = 'Review body\n<!-- zai-sha:abc123 -->\nMore text';
    const out = sanitizeModelOutput(input);
    expect(out).not.toContain('zai-sha');
    expect(out).toContain('Review body');
    expect(out).toContain('More text');
  });

  it('strips a mid-line forged <!-- zai-hashes:... --> comment (W2-SEC-2A)', () => {
    // The forger does not have to put the marker on its own line. A comment
    // embedded mid-line must also be stripped so it cannot survive into the
    // posted body.
    const input = 'text <!-- zai-hashes:def --> more';
    const out = sanitizeModelOutput(input);
    expect(out).not.toContain('zai-hashes');
    // The surrounding text is preserved.
    expect(out).toContain('text');
    expect(out).toContain('more');
  });

  it('strips a mid-line forged <!-- zai-sha:... --> comment', () => {
    const input = 'leading <!-- zai-sha:deadbeef --> trailing';
    const out = sanitizeModelOutput(input);
    expect(out).not.toContain('zai-sha');
    expect(out).toContain('leading');
    expect(out).toContain('trailing');
  });

  it('preserves a legitimate (non-zai) HTML comment', () => {
    // A normal HTML comment that is NOT a zai marker must survive sanitization.
    const input = 'Review\n<!-- regular comment -->\nMore';
    const out = sanitizeModelOutput(input);
    expect(out).toContain('<!-- regular comment -->');
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

// ============================================================================
// Task 7: adversarial edge-case tests.
// These pin precise regex behavior and the security-critical ordering
// (sanitize-then-truncate) that the headline tests above only touch lightly.
// ============================================================================

describe('neutralizeMentionsInLine — regex boundary cases', () => {
  it('does NOT treat foo@bar.com (email) as a mention', () => {
    // The @ is preceded by a word char ('o'), so the [^\w`\\/] boundary fails
    // and the @ is left intact.
    const out = neutralizeMentionsInLine('Email me at foo@bar.com please');
    expect(out).toBe('Email me at foo@bar.com please');
    expect(out).not.toContain('\u200b');
  });

  it('does NOT treat array@head (identifier-like) as a mention', () => {
    // 'y' before @ is a word char → no boundary match → @ left intact.
    const out = neutralizeMentionsInLine('use array@head here');
    expect(out).toBe('use array@head here');
    expect(out).not.toContain('\u200b');
  });

  it('neutralizes a mention at the start of the line (^ anchor)', () => {
    const out = neutralizeMentionsInLine('@everyone listen up');
    expect(out).toBe('@\u200beveryone listen up');
  });

  it('neutralizes a mention after a punctuation boundary', () => {
    // Comma is a non-word char, so the boundary matches.
    const out = neutralizeMentionsInLine('Hello, @alice how are you?');
    expect(out).toBe('Hello, @\u200balice how are you?');
  });

  it('neutralizes multiple mentions on one line', () => {
    const out = neutralizeMentionsInLine('@alice and @bob chat');
    expect(out).toBe('@\u200balice and @\u200bbob chat');
  });

  // SCN-17: a backtick IMMEDIATELY before `@` previously bypassed neutralization
  // because the backtick was in the negated boundary class `[^\w`\\/]`, leaving
  // the @ without a usable boundary. The regex now also matches a leading
  // backtick as a boundary (re-emitting it verbatim). An attacker who can plant
  // an unmatched backtick right before a mention must not bypass the sanitizer.
  it('neutralizes a mention preceded immediately by a backtick (SCN-17)', () => {
    const out = neutralizeMentionsInLine('see `@evilspammer');
    expect(out).toBe('see `@\u200bevilspammer');
    expect(out).toContain('\u200b');
  });

  it('neutralizes a mention preceded immediately by a backtick at line start (SCN-17)', () => {
    const out = neutralizeMentionsInLine('`@evilspammer');
    expect(out).toBe('`@\u200bevilspammer');
  });

  it('org/team mention stops at the first space (W11-1: no \\s in char class)', () => {
    // GitHub team names cannot contain whitespace. The regex used to include \s
    // in the team-name char class, which let a greedy match swallow the space
    // before a following mention and bypass its neutralization. The name now
    // stops at the first non-team char (space), so '@org/team name' neutralizes
    // only the @org/team mention and leaves 'name' as prose.
    const out = neutralizeMentionsInLine('cc @org/team name here');
    expect(out).toContain('@\u200borg/team');
    // The space after the team name is preserved.
    expect(out).toBe('cc @\u200borg/team name here');
  });
});

describe('neutralizeAlerts — alert-type & positioning cases', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])(
    'neutralizes the > [!%s] banner type',
    (type) => {
      const out = neutralizeAlerts(`> [!${type}]\n> body`);
      expect(out).not.toContain(`[!${type}]`);
      expect(out).toContain(`!${type}`);
    },
  );

  it.each(['[!warning]', '[!Warning]', '[!WaRnInG]'])(
    'neutralizes %s case-insensitively and uppercases the type',
    (marker) => {
      const out = neutralizeAlerts(`> ${marker}\n> body`);
      expect(out).not.toContain(marker);
      expect(out).toContain('!WARNING');
    },
  );

  it('does NOT neutralize a bare [!NOTE] at start of text (no blockquote)', () => {
    // The ALERT_RE requires a `>` quote prefix; without it the marker is plain
    // text and must be left alone. This is intentional: GitHub itself only
    // renders a callout when the marker is inside a blockquote.
    const input = '[!NOTE]\nThis is text';
    expect(neutralizeAlerts(input)).toBe(input);
  });

  it('does NOT neutralize a [!WARNING] mid-paragraph (not at line start)', () => {
    // The regex anchors on (^|\n); a marker preceded by inline text on the
    // same line does not match.
    const input = 'Some text [!WARNING] more text';
    expect(neutralizeAlerts(input)).toBe(input);
  });
});

describe('sanitizeModelOutput — idempotency (property test)', () => {
  // A sanitizer that runs between the model and GitHub must be stable: running
  // it twice must not double-rewrite or otherwise drift. This catches regressions
  // like "the ZWSP itself becomes part of a new mention match on the second pass."
  it.each([
    ['clean text only', 'Looks good to me.'],
    ['text with mentions', 'Hey @bob and @alice please review'],
    ['text with alert banner', '> [!WARNING]\n> dangerous'],
    ['code fence containing @mention', '```js\nconst x = callback(@param);\n```\nDone.'],
    [
      'mixed mentions, alerts, and code',
      '## Review\n\n- ping @alice\n- see `@decorator`\n\n> [!CAUTION]\n> note\n\n```js\n@keep\n```\n@neutralize',
    ],
  ])('is idempotent on %s', (_label, input) => {
    const once = sanitizeModelOutput(input);
    const twice = sanitizeModelOutput(once);
    expect(twice).toBe(once);
  });
});

describe('sanitizeModelOutput — sanitize-before-truncate ordering', () => {
  it('neutralizes @mentions that fall in the KEPT portion of an overlong input', () => {
    // Sanitizer runs on the full text BEFORE slicing. Place a @mention near the
    // slice boundary; the portion that survives the slice must already have the
    // ZWSP (i.e. sanitization happened first, truncation second).
    const before = 'a'.repeat(MAX_OUTPUT_CHARS - 50);
    const tail = 'cc @boundaryuser and then more text ' + 'b'.repeat(100);
    const out = sanitizeModelOutput(before + tail);
    expect(out.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
    expect(out.endsWith('output truncated by Z.ai safety filter)')).toBe(true);
    // The mention in the kept portion carries the ZWSP — proving sanitize ran
    // before truncate.
    expect(out).toContain('@\u200bboundaryuser');
    expect(out).not.toMatch(/@boundaryuser/);
  });

  it('produces zero-width spaces even when input is mostly mention spam', () => {
    // An attacker spams thousands of @mentions hoping the truncation marker
    // hides un-neutralized ones. The sanitizer processes every line first, so
    // every @mention in the kept prefix is neutralized.
    let spam = '';
    for (let i = 0; i < 1000; i++) spam += `ping @user${i} spam text. `;
    const out = sanitizeModelOutput(spam);
    expect(out).toContain('\u200b');
    // No raw @<alphanum> mention (without a following ZWSP) survives in output.
    expect(out).not.toMatch(/@[A-Za-z0-9]/);
  });
});

describe('sanitizeModelOutput — exact-length truncation boundary', () => {
  it('does NOT truncate input that is exactly MAX_OUTPUT_CHARS long', () => {
    const exact = 'a'.repeat(MAX_OUTPUT_CHARS);
    const out = sanitizeModelOutput(exact);
    expect(out).toBe(exact);
    expect(out).not.toContain('truncated');
  });

  it('truncates input that is one char over MAX_OUTPUT_CHARS', () => {
    const over = 'a'.repeat(MAX_OUTPUT_CHARS + 1);
    const out = sanitizeModelOutput(over);
    expect(out.length).toBeGreaterThan(MAX_OUTPUT_CHARS); // marker adds length
    expect(out.endsWith('output truncated by Z.ai safety filter)')).toBe(true);
    // The first MAX_OUTPUT_CHARS chars of the input are preserved as the prefix.
    expect(out.startsWith('a'.repeat(100))).toBe(true);
  });
});

describe('sanitizeCommentBody — marker / header positioning', () => {
  it('leaves an HTML marker mid-content untouched (regex only matches trailing)', () => {
    // The marker regex is anchored on `$`, so an HTML comment that is NOT the
    // final trailing marker is treated as ordinary content and passed through
    // the sanitizer verbatim (it contains nothing to neutralize here).
    const body = '## Title\n\nSome content\n\n<!-- comment -->\n\nMore content';
    const out = sanitizeCommentBody(body);
    // Header preserved, mid marker preserved, no trailing-marker stripping.
    expect(out).toBe(body);
  });

  it('preserves header and sanitizes content when there is no marker', () => {
    const body = '## Title\n\nping @alice about this';
    const out = sanitizeCommentBody(body);
    expect(out.startsWith('## Title\n\n')).toBe(true);
    expect(out).toContain('@\u200balice');
    // No marker was injected.
    expect(out).not.toContain('<!--');
  });

  it('sanitizes content and preserves trailing marker when there is no header', () => {
    const body = 'plain content cc @spammer\n\n<!-- marker -->';
    const out = sanitizeCommentBody(body);
    expect(out.endsWith('\n\n<!-- marker -->')).toBe(true);
    expect(out).toContain('@\u200bspammer');
    // No header was synthesized.
    expect(out.startsWith('## ')).toBe(false);
  });
});

// ============================================================================
// W11-1 / W11-2: adversarial audit fixes.
// ============================================================================

describe('W11-1: mention neutralization — slash-team greedy-space bypass', () => {
  // The org/team alternative used to include \s, which let the greedy match
  // swallow the space between two mentions. The second @mention then had no
  // boundary char in front of it and survived — a real notification-spam path.
  it('neutralizes a second @mention following a slash-team mention', () => {
    const out = sanitizeModelOutput('cc @org/whatever @maintainer');
    const zwspCount = (out.match(/@\u200b/g) || []).length;
    expect(zwspCount).toBe(2);
    expect(out).toContain('@\u200bmaintainer');
  });

  it('neutralizes every mention in a chain of slash-team + plain mentions', () => {
    const out = sanitizeModelOutput('@org/team @alice @bob');
    const zwspCount = (out.match(/@\u200b/g) || []).length;
    expect(zwspCount).toBe(3);
  });

  it('still neutralizes a plain @org/team mention (no regression)', () => {
    const out = sanitizeModelOutput('cc @org/everyone');
    expect(out).toBe('cc @\u200borg/everyone');
  });
});

describe('W11-2: alert-banner neutralizer — nested blockquotes & code fences', () => {
  it('neutralizes a nested >> [!WARNING] banner (two-level blockquote)', () => {
    const out = neutralizeAlerts('>> [!WARNING] hi');
    expect(out).not.toContain('[!WARNING]');
    expect(out).toContain('!WARNING');
  });

  it('neutralizes a deeply-nested >>> [!NOTE] banner', () => {
    const out = neutralizeAlerts('>>> [!NOTE] deep');
    expect(out).not.toContain('[!NOTE]');
    expect(out).toContain('!NOTE');
  });

  it('does NOT mangle alert-syntax text inside a fenced code block', () => {
    const input = '```markdown\n> [!WARNING] demo\n```';
    const out = sanitizeModelOutput(input);
    // The fenced content is preserved verbatim (the banner marker survives
    // because it's inside code, not rendered by GitHub as a banner).
    expect(out).toContain('> [!WARNING] demo');
    expect(out).not.toContain('> !WARNING');
  });
});
