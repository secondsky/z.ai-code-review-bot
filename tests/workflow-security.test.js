import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/* ------------------------------------------------------------------ *
 * Workflow security policy — regression lock on our own GitHub Actions
 *
 * These tests parse every ACTIVE workflow in .github/workflows/*.yml and
 * enforce the supply-chain hardening policy, so a future edit that regresses
 * any invariant fails CI instead of silently re-opening an attack surface:
 *
 *   - SHA-pinned `uses:` refs (tj-actions/Trivy-style mutable-tag retagging)
 *   - `persist-credentials: false` on every checkout (no leftover GITHUB_TOKEN
 *     credentials on the runner for a compromised step to exfiltrate)
 *   - per-job `timeout-minutes` (runaway jobs burning Actions minutes)
 *   - no `pull_request_target` / `workflow_run` triggers (untrusted-code
 *     execution with secrets access)
 *   - no `${{ }}` expression interpolation inside `run:` (script injection)
 *   - workflow-level `permissions` + `concurrency` present
 *   - pinned `ubuntu-24.04` runner image (no mutable `ubuntu-latest` drift)
 *
 * Parsed with the `yaml` package (YAML 1.2): the `on:` key stays the string
 * 'on' — js-yaml (YAML 1.1) would parse it as boolean true.
 * ------------------------------------------------------------------ */

const WORKFLOW_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

// The exact set of active workflows. The *.yml.example files are inert
// consumer templates with intentional placeholders and are out of scope —
// if a new active workflow appears, this list must grow with it.
const ACTIVE_FILES = ['ci.yml', 'codeql.yml', 'scorecard.yml'];

// `owner/repo[/path]@<ref>` where <ref> must be a full commit SHA. The
// leading `@` in the pattern tolerates `docker://@sha256:...`-style values.
const SHA_REF = /^@?[0-9a-f]{40}$/;
const REQUIRED_RUNNER = 'ubuntu-24.04';
const FORBIDDEN_TRIGGERS = ['pull_request_target', 'workflow_run'];

const discovered = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .sort();

const workflows = discovered.map((name) => ({
  name,
  doc: parse(readFileSync(path.join(WORKFLOW_DIR, name), 'utf8')),
}));

/** Yield every node (objects, arrays, scalars) in a parsed YAML tree. */
function* walkNodes(node) {
  yield node;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkNodes(item);
  } else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) yield* walkNodes(value);
  }
}

/** Every step-like node: an object carrying a string `uses` key. */
function collectSteps(doc) {
  return [...walkNodes(doc)].filter(
    (node) =>
      node !== null && typeof node === 'object' && !Array.isArray(node) &&
      typeof node.uses === 'string'
  );
}

/** jobs as [{ id, job }] pairs. */
function getJobs(doc) {
  return Object.entries(doc?.jobs ?? {}).map(([id, job]) => ({ id, job }));
}

/** Trigger names of a workflow's `on:` (string, list, or mapping form). */
function getTriggers(doc) {
  const on = doc.on;
  if (on === null || on === undefined) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on);
}

describe('active workflow discovery', () => {
  it('finds exactly the three active workflow files (no more, no fewer)', () => {
    expect(discovered).toEqual(ACTIVE_FILES);
  });

  // Vacuity guard: the policy tests below must never pass because they
  // scanned nothing. Today the pinned 3 files carry exactly 6 checkout
  // steps (4 in ci.yml, 1 in codeql.yml, 1 in scorecard.yml); if this
  // count changes, update it deliberately.
  it('actually scans the expected number of checkout steps', () => {
    const checkouts = workflows.flatMap(({ doc }) =>
      collectSteps(doc).filter((s) => s.uses.startsWith('actions/checkout@'))
    );
    expect(checkouts).toHaveLength(6);
  });
});

describe('supply-chain hardening policy', () => {
  it('pins every uses: ref to a full 40-hex commit SHA', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const step of collectSteps(doc)) {
        const ref = step.uses.slice(step.uses.lastIndexOf('@') + 1);
        if (!SHA_REF.test(ref)) violations.push(`${name}: ${step.uses}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('sets persist-credentials: false on every actions/checkout step', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const step of collectSteps(doc)) {
        if (
          step.uses.startsWith('actions/checkout@') &&
          step.with?.['persist-credentials'] !== false
        ) {
          violations.push(`${name}: ${step.uses}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never triggers on pull_request_target or workflow_run', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const trigger of getTriggers(doc)) {
        if (FORBIDDEN_TRIGGERS.includes(trigger)) {
          violations.push(`${name}: on: ${trigger}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('runaway-job and injection hardening policy', () => {
  it('gives every job a numeric timeout-minutes within 1..60', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const { id, job } of getJobs(doc)) {
        const t = job?.['timeout-minutes'];
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 1 || t > 60) {
          violations.push(`${name}: job ${id} timeout-minutes=${JSON.stringify(t)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never interpolates ${{ }} expressions into run: scripts', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const node of walkNodes(doc)) {
        if (
          node !== null && typeof node === 'object' && !Array.isArray(node) &&
          typeof node.run === 'string' && node.run.includes('${{')
        ) {
          violations.push(`${name}: run: ${node.run}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares workflow-level permissions (scalar or mapping)', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      const p = doc.permissions;
      const ok =
        typeof p === 'string' ||
        (p !== null && p !== undefined && typeof p === 'object' && !Array.isArray(p));
      if (!ok) violations.push(`${name}: missing permissions`);
    }
    expect(violations).toEqual([]);
  });

  it('declares workflow-level concurrency', () => {
    const violations = workflows
      .filter(({ doc }) => doc.concurrency === undefined)
      .map(({ name }) => `${name}: missing concurrency`);
    expect(violations).toEqual([]);
  });

  it('runs every job on the pinned ubuntu-24.04 runner image', () => {
    const violations = [];
    for (const { name, doc } of workflows) {
      for (const { id, job } of getJobs(doc)) {
        const r = job?.['runs-on'];
        const ok =
          r === REQUIRED_RUNNER ||
          (Array.isArray(r) && r.length > 0 && r.every((x) => x === REQUIRED_RUNNER));
        if (!ok) violations.push(`${name}: job ${id} runs-on=${JSON.stringify(r)}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
