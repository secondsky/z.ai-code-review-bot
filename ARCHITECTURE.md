# Architecture

A single-file Node 20 GitHub Action that reviews pull requests with Z.ai GLM
models and (optionally) answers interactive `/zai` commands. The runtime entry
point is the ncc bundle `dist/index.js`; the maintained source is under `src/`.

**Design goals:** auditable in one sitting, tiny dependency surface
(`@actions/core`, `@actions/github`, `picomatch`), one Z.ai HTTP client, and an
authorization model that is enforced in code (not just docs).

## Data flow

```
GitHub event
  │
  ▼
src/index.js  run(context, deps)   ← entry; routes by eventName
  │
  ├── pull_request ──────────────────────────────────────────────┐
  │     getChangedFiles → filterExcludedFiles → filterPatchable  │
  │     small PR?  buildAutoReviewPrompt + callApi(×1)           │
  │     large PR?  runAutoReview (batch + synthesize, callApi×N) │
  │     → upsertReviewComment (idempotent via <!-- marker -->)   │
  │                                                              │
  ├── issue_comment ─────────────────────────────────────────────┤
  │     commandsEnabled? → bot? → is PR comment? → parseCommand │
  │     → authorize()  ← THE GATE (silent block if unauthorized)│
  │     → handlers[command]({ callApi, octokit, … })            │
  │                                                              │
  └── schedule / other → no-op (v1)                              │
                                                                 ▼
                                                    src/lib/api.js  (SINGLE Z.ai client)
                                                    retry · backoff · timeout · sanitize
```

Auto-review is repo-initiated (no user auth). Commands are user-initiated and
**auth-gated** by two layers: the workflow `if:` on `author_association`
(primary; see `.github/workflows/zai-commands.example.yml`) and the in-code
`authorize()` (defense in depth).

## Module map

| Module | Responsibility |
|---|---|
| `src/index.js` | Entry point. `run(context, deps)` routes events; `main()` reads inputs and is import-safe. |
| `src/lib/config.js` | Reads/validates action inputs into a typed config object (`loadConfig`). |
| `src/lib/events.js` | Pure helpers over the GitHub `context` shape (eventName, getPullNumber, isForkPullRequest, getCommenter, isBotComment). |
| `src/lib/glob.js` | `matchesAnyPattern` — picomatch-based exclude matching (path OR basename). |
| `src/lib/auth.js` | `authorize()` — association-based authorization gate (the security centerpiece). Pure, never throws. |
| `src/lib/api.js` | The **single** Z.ai client: retry, exponential backoff + jitter, progressive timeouts, error categorization, secret-aware error sanitization. |
| `src/lib/comments.js` | `upsertReviewComment` — idempotent summary comment via a hidden marker (fully paginated). |
| `src/lib/changed-files.js` | Paginated `pulls.listFiles`; `filterPatchableFiles`, `filterExcludedFiles`. |
| `src/lib/sanitize-output.js` | Conservative model-output sanitizer: length cap, `@mention` neutralization, GitHub alert-banner neutralization. Applied before every comment post. |
| `src/lib/prompt.js` | Centralized prompts: `DEFAULT_SYSTEM_PROMPT`, `resolveSystemPrompt` (with non-disclosure clause), `buildAutoReviewPrompt` (with `<untrusted_input>` hardening + escapers). |
| `src/lib/auto-review.js` | Risk-scored batching + synthesis pipeline: `scoreFile`, `splitTextByLines` (guarded against non-positive `maxChars`), `createReviewBatches`, recursive halving on context overflow, synthesis + fallback. |
| `src/lib/schedule.js` | Scheduled batch re-review: `runScheduledReview`, `listOpenPrs`, `hasReviewForSha`, `reviewOnePr`. Opt-in via `ZAI_SCHEDULE_ENABLED`. |
| `src/lib/commands.js` | `/zai` parser + `ALLOWED_COMMANDS`. |
| `src/lib/handlers/*.js` | The six command handlers (`ask`, `review`, `explain`, `describe`, `impact`, `help`) + `HANDLERS` registry + shared helpers. |

## Key invariants

- **One Z.ai client.** `src/lib/api.js` is the only transport. Auto-review and
  every handler receive an injected `callApi` that wraps it. No module imports
  `api.js` to call the network directly except the router (which builds
  `callApi`).
- **Authorization precedes dispatch.** In `run()`, `authorize()` runs before any
  handler is constructed or called. A blocked user triggers no `callApi`, no
  comment, and no reaction. See `SECURITY.md`.
- **Idempotent review comment.** Auto-review updates a single comment in place
  via the `<!-- zai-code-review -->` marker; re-runs on `synchronize` do not
  create duplicates.
- **Handlers never throw.** A `callApi` failure becomes a short user-facing
  comment; the error never propagates out of the handler.
- **Read-only commands.** `/describe` and `/impact` post comments only — no
  PR-body mutation, no label application (tested invariants).
- **Dependency injection everywhere.** Every module takes its collaborators
  (octokit, core, callApi, handlers, pure helpers) as parameters, so the whole
  flow is unit-testable without network or GitHub.

## Build & test

- Source is ESM (`"type": "module"`). `npm run build` produces the committed
  `dist/index.js` bundle via `@vercel/ncc`; the runtime is `node20`.
- CI (`.github/workflows/ci.yml`) runs the vitest suite on Node 20/22 and gates
  on `dist/` drift (the committed bundle must match `src/`).
- `dist/` is committed intentionally — it is what the action runner executes.
