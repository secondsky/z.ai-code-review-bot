# Architecture

A Node 20 GitHub Action that reviews pull requests with Z.ai GLM models —
producing **structured findings** posted as **inline review comments** + a
**walkthrough summary**, backed by **deterministic scanners**. Optionally
answers interactive `/zai` commands. The runtime entry is the ncc bundle
`dist/index.js`; the maintained source is under `src/`.

**Design goals:** auditable core (~10k LOC), tiny dependency surface
(`@actions/core`, `@actions/github`, `picomatch`), one Z.ai HTTP client,
deterministic-before-generative review, and security enforced in code.

## Data flow

```
GitHub event
  │
  ▼
src/index.js  run(context, deps)   ← entry; routes by eventName
  │
  ├── pull_request ──────────────────────────────────────────────────┐
  │     getChangedFiles → filterExcludedFiles → filterPatchable      │
  │     loadRepoConfig (.zai.yml)         [untrusted, narrows only]  │
  │     setReviewStatus (pending)                                     │
  │     runScanners                      [gitleaks + ast-grep + metrics] │
  │     runStructuredReview              [bounded-concurrent batches] │
  │       buildStructuredReviewPrompt → callApi(Z.ai) → parseFindings │
  │       mergeFindings (deterministic wins) → rankAndCapFindings     │
  │     filterIncrementalFindings        [suppress prior-reported]   │
  │     partitionFindings                [inline-mappable vs summary]│
  │     resolveReviewEvent               [COMMENT or REQUEST_CHANGES]│
  │     upsertReview                     [dismiss stale, post review]│
  │       → on failure: postFallbackComment (never lose a review)    │
  │     setReviewStatus (success/failure)                            │
  │                                                                   │
  ├── issue_comment ─────────────────────────────────────────────────┤
  │     commandsEnabled? → bot? → is PR? → parseCommand              │
  │     → authorize()  ← THE GATE (silent block if unauthorized)     │
  │     → handlers[command]({ callApi, octokit, … })                 │
  │                                                                   │
  └── schedule → runScheduledReview (SHA-deduped re-review)           │
                                                                      ▼
                                                    src/lib/api.js  (SINGLE Z.ai client)
                                                    retry · backoff · timeout · sanitize
```

## Module map

### Core pipeline
| Module | Responsibility |
|---|---|
| `src/index.js` | Entry point. `run(context, deps)` routes events; `main()` reads inputs. |
| `src/lib/config.js` | Reads/validates action inputs into a typed config (`loadConfig`). |
| `src/lib/events.js` | Pure helpers over the GitHub `context` shape. |
| `src/lib/glob.js` | `matchesAnyPattern` — picomatch-based exclude matching. |
| `src/lib/auth.js` | `authorize()` — association-based authorization gate (security centerpiece). |
| `src/lib/api.js` | The **single** Z.ai client: retry, backoff, progressive timeouts, secret-aware error sanitization, temperature/max_tokens wiring. |
| `src/lib/changed-files.js` | Paginated `pulls.listFiles`; `filterPatchableFiles`, `filterExcludedFiles`. |

### Structured findings & review
| Module | Responsibility |
|---|---|
| `src/lib/findings.js` | The finding schema, `parseFindings`/`parseStructuredReview` (anti-hallucination file check), `rankAndCapFindings`, `mergeFindings`, `formatFindingsAsSummary`, incremental-dedup helpers (`hashFinding`, `buildFindingsHashBlock`, `filterIncrementalFindings`). |
| `src/lib/prompt.js` | `buildStructuredReviewPrompt` (JSON findings, evidence mandate, scanner/path/tone context, `<untrusted_input>` hardening), `resolveSystemPrompt` (non-disclosure clause), escapers. |
| `src/lib/auto-review.js` | Risk-scored batching (`createReviewBatches`), `executeStructuredBatch` (recursive halving), `runStructuredReview` (bounded-concurrent fan-out via `runWithConcurrency`). |
| `src/lib/diff.js` | Pure unified-diff parsing: `parseHunks`, `isValidCommentLine`, `findNearestValidLine`, `mapFindingToComment`, `partitionFindings`. Re-exports `parseHunkHeader`. |
| `src/lib/review.js` | GitHub review submission: `buildReviewBody`, `buildReviewComments`, `upsertReview` (dismiss-stale-then-post), `postFallbackComment`, `resolveReviewEvent`. |
| `src/lib/comments.js` | `upsertReviewComment` — idempotent summary comment via marker (fully paginated). |
| `src/lib/walkthrough.js` | Cohort classification + dependency-ordered collapsible summary (`formatWalkthroughSummary`). |

### Deterministic scanners
| Module | Responsibility |
|---|---|
| `src/lib/scanners/index.js` | `runScanners` orchestrator + `formatScannerContext`. |
| `src/lib/scanners/secrets.js` | gitleaks binary + regex fallback (8 secret patterns). |
| `src/lib/scanners/patterns.js` | ast-grep binary + regex fallback (9 code-pattern rules). |
| `src/lib/scanners/metrics.js` | Pure diff metrics (test/source ratio, large/generated files, TODOs). |
| `src/lib/scanners/ensure-binary.js` | Fetch+cache+SHA256-verify helper for runtime binaries. |
| `src/lib/scanners/_patch.js` | Pure unified-diff parser (added-lines + line numbers), shared. |

### Configuration & status
| Module | Responsibility |
|---|---|
| `src/lib/repo-config.js` | `.zai.yml` loader: hand-rolled YAML parser, `validateRepoConfig`, `mergeRepoConfig` (security: repo can only narrow). |
| `src/lib/learnings.js` | `.zai/learnings.yml` loader: parseLearnings, matchesLearning (glob + substring), filterFindingsByLearnings. Untrusted context. |
| `src/lib/codeowners.js` | CODEOWNERS parser, `matchCodeowners` (last-match-wins), `suggestReviewers`, `loadCodeowners`. |
| `src/lib/status.js` | `setReviewStatus` (commit statuses, fail-soft), `buildStatusDescription`. |
| `src/lib/sanitize-output.js` | Output sanitizer: length cap, `@mention` neutralization, alert-banner neutralization. Applied before every comment post. |

### Commands
| Module | Responsibility |
|---|---|
| `src/lib/commands.js` | `/zai` parser + `ALLOWED_COMMANDS`. |
| `src/lib/handlers/*.js` | The six command handlers + `HANDLERS` registry + shared helpers. |
| `src/lib/schedule.js` | Scheduled batch re-review: `runScheduledReview`, SHA-deduped. |

## Key invariants

- **One Z.ai client.** `src/lib/api.js` is the only transport. All callers
  receive an injected `callApi`. Temperature/max_tokens flow through the
  adapter → client → request body.
- **Deterministic before generative.** Scanners run before the LLM. Their
  findings carry `confidence:'high'` and `rule:'<scanner>:<id>'` provenance.
  The LLM receives scanner context ("already detected, don't re-report").
- **Authorization precedes dispatch.** `authorize()` runs before any handler.
  A blocked user triggers no `callApi`, no comment.
- **Idempotent review.** `upsertReview` dismisses prior bot reviews (referencing
  the new SHA) before posting. Re-runs don't pile up duplicates. The marker
  `<!-- zai-code-review -->` + hash block `<!-- zai-hashes:... -->` coexist.
- **Never lose a review.** If `createReview` fails (422, API error), the
  fallback posts the findings as a sanitized issue comment.
- **Output safety.** Every comment body passes through `sanitizeModelOutput`.
  `@mentions` are neutralized outside code; GitHub alert banners are defanged.
- **Repo config narrows only.** `.zai.yml` can lower `maxFindings`, add
  excludes, disable scanners — never raise caps, enable scanners the action
  disabled, or change auth. Action inputs always win on security/cost knobs.
- **Dependency injection everywhere.** Every module takes collaborators as
  parameters. Binary execution (`deps.runBinary`), fetch (`deps.ensureBinary`),
  and all I/O are injected — fully testable without network or real binaries.
- **Handlers never throw.** A `callApi` failure becomes a short error comment.

## Build & test

- Source is ESM. `npm run build` produces the committed `dist/index.js` via
  `@vercel/ncc`; runtime is `node20`.
- CI runs vitest on Node 20/22, gates on `dist/` drift, and runs
  `npm audit --audit-level=high`.
- Dependabot watches npm + github-actions ecosystems (weekly).
- 1337 tests across 37 files. `dist/` is committed intentionally.
