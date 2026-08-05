# Z.ai Code Review

An AI-powered GitHub Action that reviews pull requests with [Z.ai](https://z.ai)
GLM models — with **inline line-level review comments**, **deterministic
scanners**, a **walkthrough summary**, and (optionally) interactive `/zai`
commands.

## What it does

- **Inline review comments** anchored to diff lines (like CodeRabbit / Copilot),
  not just a summary block. Each finding carries severity, confidence, quoted
  evidence, and a concrete suggestion.
- **Deterministic scanners beneath the LLM** — secret detection (gitleaks +
  regex fallback) and code-pattern analysis (ast-grep + regex fallback) run
  BEFORE the model, catching what LLMs miss and suppressing hallucinations.
- **Structured findings** with a noise cap (default 8/PR), severity ranking,
  and anti-hallucination file validation.
- **Walkthrough summary** — findings grouped into dependency-ordered cohorts
  (database → API → logic → UI → tests) in collapsible sections.
- **Commit-status feedback** — pending → success/failure so developers see
  review progress instead of a silent PR.
- **`.zai.yml` repo config** — per-path review instructions, tone, and scanner
  toggles without editing your workflow (the `.coderabbit.yaml` pattern).
- **Incremental review** — re-pushes only surface new/changed findings
  (content-hash dedup), not the same resolved issues.
- **Interactive commands** (`/zai ask`, `review`, `explain`, `describe`,
  `impact`, `help`) — off by default, authorization-gated when on.

> **Security first.** Every untrusted surface (diffs, `.zai.yml`, CODEOWNERS,
> scanner output) flows through prompt-injection defenses and an output
> sanitizer. Commands are gated by a workflow `if:` on `author_association`
> **and** an in-code check. See [`SECURITY.md`](./SECURITY.md).

## Setup

1. Create a Z.ai API key at `z.ai`.
2. Add it to your repo as a **secret** named `ZAI_API_KEY`.
3. Add a workflow (see below).

## Quickstart: auto-review

```yaml
name: Z.ai Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  pull-requests: write
  statuses: write          # for commit-status feedback (or set ZAI_COMMIT_STATUS: false)
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: <your-org>/z.ai-code-review-bot@v2
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

Every non-draft PR gets a review with inline comments on findings + a
walkthrough summary. Prior reviews are dismissed on re-push (idempotent per
SHA). Bounded-concurrent batch fan-out handles large PRs.

## Optional: `.zai.yml` repo config

Commit a `.zai.yml` to configure review behavior without editing the workflow:

```yaml
reviews:
  profile: chill              # chill (default) | assertive
  max_findings: 8             # can only LOWER the action's cap
  path_instructions:
    - path: "src/auth/**"
      instructions: "Scrutinize auth flows; flag hardcoded secrets."
    - path: "**/*.test.js"
      instructions: "Check edge-case coverage."
  path_filters:
    - "!dist/**"
  tone_instructions: "Be terse. Cite line numbers."
scanners:
  gitleaks: true              # can only DISABLE (false), never enable
  ast_grep: false
```

The `.zai.yml` is treated as **untrusted** — it can only narrow behavior (add
excludes, lower caps, disable scanners). Action inputs always win on
security/cost knobs.

## Optional: interactive `/zai` commands

Commands let collaborators ask questions by commenting `/zai …` on a PR.
**Off by default**; requires an authorization gate. See
[`SECURITY.md`](./SECURITY.md) for why this matters, especially for fork PRs.

| Command | Description |
|---|---|
| `/zai ask <question>` | Ask a question about the PR. |
| `/zai review [file]` | Review a specific file, or the whole PR. |
| `/zai explain <start>-<end> [file]` | Explain a line range. |
| `/zai describe` | Generate a PR description. |
| `/zai impact` | Assess change impact/risk. |
| `/zai help` | Show the command list. |

## Inputs

### Core review
| Input | Default | Description |
|---|---|---|
| `ZAI_API_KEY` | *(required)* | Z.ai API key. Use a **secret**. |
| `ZAI_MODEL` | `glm-5.2` | Z.ai model name. |
| `ZAI_SYSTEM_PROMPT` | *(built-in)* | System prompt; empty uses the built-in default. |
| `ZAI_REVIEWER_NAME` | `Z.ai Code Review` | Header label on the review. |
| `ZAI_TEMPERATURE` | `0.2` | Sampling temperature, clamped [0, 2]. Low = deterministic. |
| `ZAI_MAX_TOKENS` | `4096` | Max tokens per model call. |
| `ZAI_TIMEOUT_MS` | `120000` | Per-attempt request timeout (ms). |
| `ZAI_FALLBACK_PROMPT` | *(empty)* | Shorter prompt used on repeated timeout (activates retry fallback). |

### Findings & noise control
| Input | Default | Description |
|---|---|---|
| `ZAI_MAX_FINDINGS` | `8` | Max findings after rank+cap (clamped [1, 50]). |
| `ZAI_MIN_SEVERITY` | `info` | Lowest severity to include. |
| `ZAI_WALKTHROUGH` | `true` | Group findings into dependency-ordered cohort sections. |
| `ZAI_INCREMENTAL_REVIEW` | `true` | Suppress previously-reported findings on re-push. |
| `ZAI_STRICT_MODE` | `false` | Post REQUEST_CHANGES (blocks merge) when critical/high findings exist. |

### Batching & filtering
| Input | Default | Description |
|---|---|---|
| `EXCLUDE_PATTERNS` | `*.lock,package-lock.json,…` | Comma globs to exclude. |
| `MAX_DIFF_CHARS` | `100000` | Hard cap on diff chars (0 = unlimited, discouraged). |
| `ZAI_LARGE_PR_FILE_THRESHOLD` | `50` | Retained for reporting; batching handles all sizes. |
| `ZAI_MAX_BATCH_CHARS` | `120000` | Character budget per batch. |
| `ZAI_MAX_FILES_PER_BATCH` | `40` | Max distinct files per batch. |
| `ZAI_MAX_PATCH_CHARS` | `18000` | Max diff chars per file before splitting. |
| `ZAI_BATCH_CONCURRENCY` | `3` | Concurrent batch reviews (clamped [1, 8]). |

### Scanners
| Input | Default | Description |
|---|---|---|
| `ZAI_SCANNERS_ENABLED` | `true` | Master switch for deterministic scanners (gitleaks + ast-grep). |
| `ZAI_SCANNERS_CACHE_DIR` | `~/.zai-cache/scanners` | Where scanner binaries are cached. |

### Status & repo config
| Input | Default | Description |
|---|---|---|
| `ZAI_COMMIT_STATUS` | `true` | Post pending/success commit status (needs `statuses: write`). |
| `ZAI_REPO_CONFIG_ENABLED` | `true` | Load `.zai.yml` from the repo. |

### Reviewer suggestions
| Input | Default | Description |
|---|---|---|
| `ZAI_SUGGEST_REVIEWERS` | `false` | Suggest reviewers from CODEOWNERS in the summary. |
| `ZAI_AUTO_ASSIGN_REVIEWERS` | `false` | Auto-assign suggested reviewers via the API. |

### Commands & schedule
| Input | Default | Description |
|---|---|---|
| `ZAI_COMMANDS_ENABLED` | `false` | Enable `/zai` commands (requires the workflow gate). |
| `ZAI_AUTH_THRESHOLD` | `write` | Min relationship for commands. |
| `ZAI_ALLOW_FORK_COMMANDS` | `false` | Allow commands on fork PRs. |
| `ZAI_SCHEDULE_ENABLED` | `false` | Re-review open PRs on a schedule. |
| `ZAI_SCHEDULE_MAX_PRS` | `10` | Cap on PRs reviewed per scheduled run. |
| `ZAI_DESCRIBE_WRITE_BODY` | `false` | `/zai describe` writes a marked block into the PR body. |
| `ZAI_IMPACT_LABELS` | `false` | `/zai impact` applies a `zai:`-scoped severity label. |
| `ZAI_IMPACT_LABEL_MAP` | `critical=zai:critical,…` | Severity → label map. |
| `GITHUB_TOKEN` | `github.token` | GitHub token (auto-provided). |

## How it works (review pipeline)

```
pull_request event
  → getChangedFiles → filter excludes → filter patchable
  → loadRepoConfig (.zai.yml)      [untrusted, narrows only]
  → setReviewStatus (pending)
  → runScanners                     [gitleaks + ast-grep + metrics]
  → runStructuredReview             [bounded-concurrent batches]
      → buildStructuredReviewPrompt [JSON findings, evidence mandate]
      → callApi (Z.ai GLM)          [temperature/max_tokens wired]
      → parseStructuredReview       [anti-hallucination file check]
      → mergeFindings               [deterministic wins over LLM]
      → rankAndCapFindings          [severity sort, noise cap]
  → filterIncrementalFindings       [suppress prior-reported]
  → partitionFindings               [inline-mappable vs summary-only]
  → upsertReview                    [dismiss stale, post inline + summary]
  → setReviewStatus (success/failure)
```

## vs CodeRabbit / Copilot Code Review

| | Z.ai Code Review | CodeRabbit | Copilot Review |
|---|---|---|---|
| **Self-hostable** | ✅ runs on your runner | ❌ hosted (clones your repo) | ❌ hosted |
| **Provider** | Z.ai GLM only | multiple | GitHub/OpenAI |
| **Deterministic scanners** | ✅ gitleaks + ast-grep | ✅ 40+ tools | partial |
| **Inline comments** | ✅ | ✅ | ✅ |
| **Repo config file** | ✅ `.zai.yml` | ✅ `.coderabbit.yaml` | ❌ |
| **Cost** | your Z.ai API cost only | subscription | subscription |
| **Auditable core** | ✅ ~10k LOC, 3 deps, 1244 tests | black box | black box |

## Development

```bash
npm install
npm test            # vitest suite (1244 tests)
npm run test:coverage
npm run build       # @vercel/ncc -> dist/index.js (commit the bundle)
npm audit           # 0 vulnerabilities
```

`dist/index.js` is committed on purpose — it is what the runner executes. CI
fails if it drifts from `src/`. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for
the module map and [`SECURITY.md`](./SECURITY.md) for the authorization model.

## License

MIT.
