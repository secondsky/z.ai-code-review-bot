/**
 * Tests for src/lib/commands.js — the `/zai` comment parser + allowlist.
 *
 * The parser is a PURE function: no I/O, no async, no imports of actions
 * modules. It reads one comment body and returns a structured result.
 */
import { describe, it, expect } from 'vitest';
import { parseCommand, ALLOWED_COMMANDS } from '../src/lib/commands.js';

describe('ALLOWED_COMMANDS', () => {
  it('exports the exact allowlist in the specified order', () => {
    expect(ALLOWED_COMMANDS).toEqual([
      'ask',
      'review',
      'explain',
      'describe',
      'impact',
      'help',
    ]);
  });
});

describe('parseCommand — happy paths', () => {
  it('parses /zai ask with quoted args', () => {
    expect(parseCommand('/zai ask "what is this"')).toEqual({
      command: 'ask',
      args: '"what is this"',
      raw: '/zai ask "what is this"',
      error: null,
    });
  });

  it('parses /zai review with a file path', () => {
    expect(parseCommand('/zai review src/index.js')).toEqual({
      command: 'review',
      args: 'src/index.js',
      raw: '/zai review src/index.js',
      error: null,
    });
  });

  it('parses /zai explain with a range', () => {
    expect(parseCommand('/zai explain 10-20')).toEqual({
      command: 'explain',
      args: '10-20',
      raw: '/zai explain 10-20',
      error: null,
    });
  });

  it('parses /zai help with empty args', () => {
    expect(parseCommand('/zai help')).toEqual({
      command: 'help',
      args: '',
      raw: '/zai help',
      error: null,
    });
  });

  it('aliases @zai mention prefix', () => {
    expect(parseCommand('@zai describe')).toEqual({
      command: 'describe',
      args: '',
      raw: '@zai describe',
      error: null,
    });
  });

  it('aliases /zai-bot prefix', () => {
    expect(parseCommand('/zai-bot impact')).toEqual({
      command: 'impact',
      args: '',
      raw: '/zai-bot impact',
      error: null,
    });
  });

  it('aliases @zai-bot prefix', () => {
    expect(parseCommand('@zai-bot ask hi')).toEqual({
      command: 'ask',
      args: 'hi',
      raw: '@zai-bot ask hi',
      error: null,
    });
  });
});

describe('parseCommand — case-insensitive', () => {
  it('lowercases the prefix and the command', () => {
    expect(parseCommand('/Zai ASK hi')).toEqual({
      command: 'ask',
      args: 'hi',
      raw: '/Zai ASK hi',
      error: null,
    });
  });

  it('lowercases mixed-case @zai-Bot prefix', () => {
    expect(parseCommand('@ZaI-BoT HELP')).toEqual({
      command: 'help',
      args: '',
      raw: '@ZaI-BoT HELP',
      error: null,
    });
  });
});

describe('parseCommand — leading whitespace', () => {
  it('trims leading whitespace before the prefix', () => {
    expect(parseCommand('   /zai ask hi')).toEqual({
      command: 'ask',
      args: 'hi',
      raw: '   /zai ask hi',
      error: null,
    });
  });
});

describe('parseCommand — error paths', () => {
  it('returns NOT_A_COMMAND for ordinary text', () => {
    expect(parseCommand('nice PR!')).toEqual({
      command: null,
      args: null,
      raw: 'nice PR!',
      error: 'NOT_A_COMMAND',
    });
  });

  it('returns NOT_A_COMMAND for a prefix that is not at the start', () => {
    expect(parseCommand('hey /zai ask hi')).toEqual({
      command: null,
      args: null,
      raw: 'hey /zai ask hi',
      error: 'NOT_A_COMMAND',
    });
  });

  it('returns MALFORMED_INPUT when the prefix has no command', () => {
    expect(parseCommand('/zai')).toEqual({
      command: null,
      args: null,
      raw: '/zai',
      error: 'MALFORMED_INPUT',
    });
  });

  it('returns MALFORMED_INPUT when only whitespace follows the prefix', () => {
    expect(parseCommand('/zai    ')).toEqual({
      command: null,
      args: null,
      raw: '/zai    ',
      error: 'MALFORMED_INPUT',
    });
  });

  it('returns UNKNOWN_COMMAND with the lowercased command for an unrecognized verb', () => {
    expect(parseCommand('/zai frobnicate')).toEqual({
      command: 'frobnicate',
      args: '',
      raw: '/zai frobnicate',
      error: 'UNKNOWN_COMMAND',
    });
  });

  it('returns UNKNOWN_COMMAND preserving args', () => {
    expect(parseCommand('/zai frobnicate a b c')).toEqual({
      command: 'frobnicate',
      args: 'a b c',
      raw: '/zai frobnicate a b c',
      error: 'UNKNOWN_COMMAND',
    });
  });
});

describe('parseCommand — multi-line input', () => {
  it('parses only the first line', () => {
    const input = '/zai ask hi\nsecond line\nthird line';
    expect(parseCommand(input)).toEqual({
      command: 'ask',
      args: 'hi',
      raw: input,
      error: null,
    });
  });

  it('returns NOT_A_COMMAND when the first line is not a command but a later line is', () => {
    const input = 'hello there\n/zai ask hi';
    expect(parseCommand(input)).toEqual({
      command: null,
      args: null,
      raw: input,
      error: 'NOT_A_COMMAND',
    });
  });
});

describe('parseCommand — defensive inputs', () => {
  it('returns MALFORMED_INPUT for a non-string input (number)', () => {
    expect(parseCommand(42)).toEqual({
      command: null,
      args: null,
      raw: 42,
      error: 'MALFORMED_INPUT',
    });
  });

  it('returns MALFORMED_INPUT for null', () => {
    expect(parseCommand(null)).toEqual({
      command: null,
      args: null,
      raw: null,
      error: 'MALFORMED_INPUT',
    });
  });

  it('returns MALFORMED_INPUT for undefined', () => {
    expect(parseCommand(undefined)).toEqual({
      command: null,
      args: null,
      raw: undefined,
      error: 'MALFORMED_INPUT',
    });
  });

  it('returns MALFORMED_INPUT for an object', () => {
    expect(parseCommand({ body: '/zai ask hi' })).toEqual({
      command: null,
      args: null,
      raw: { body: '/zai ask hi' },
      error: 'MALFORMED_INPUT',
    });
  });
});
