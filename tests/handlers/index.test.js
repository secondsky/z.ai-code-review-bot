/**
 * Tests for src/lib/handlers/index.js — the HANDLERS registry.
 *
 * The registry is the map the router injects (Task 9 wires
 * `deps.handlers = HANDLERS`). It must contain exactly the six command →
 * handler-function pairs, using the real handler implementations.
 */
import { describe, it, expect } from 'vitest';
import { HANDLERS } from '../../src/lib/handlers/index.js';
import { ALLOWED_COMMANDS } from '../../src/lib/commands.js';
import { handleAskCommand } from '../../src/lib/handlers/ask.js';
import { handleHelpCommand } from '../../src/lib/handlers/help.js';
import { handleReviewCommand } from '../../src/lib/handlers/review.js';
import { handleExplainCommand } from '../../src/lib/handlers/explain.js';
import { handleDescribeCommand } from '../../src/lib/handlers/describe.js';
import { handleImpactCommand } from '../../src/lib/handlers/impact.js';

describe('HANDLERS registry', () => {
  it('has exactly the six allowed commands as keys', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(
      [...ALLOWED_COMMANDS].sort(),
    );
  });

  it('maps each command to the correct handler function', () => {
    expect(HANDLERS.ask).toBe(handleAskCommand);
    expect(HANDLERS.help).toBe(handleHelpCommand);
    expect(HANDLERS.review).toBe(handleReviewCommand);
    expect(HANDLERS.explain).toBe(handleExplainCommand);
    expect(HANDLERS.describe).toBe(handleDescribeCommand);
    expect(HANDLERS.impact).toBe(handleImpactCommand);
  });

  it('every value is a function', () => {
    for (const key of Object.keys(HANDLERS)) {
      expect(typeof HANDLERS[key]).toBe('function');
    }
  });
});
