# Z.ai Code Review

An AI-powered GitHub Action that reviews pull requests with [Z.ai](https://z.ai)
GLM models and (optionally) answers interactive `/zai` commands on PR comments.

- **Auto-review** on every PR — risk-scored batching for large PRs, a single
  summary comment updated in place.
- **Interactive commands** (`/zai ask`, `review`, `explain`, `describe`,
  `impact`, `help`) — **off by default**, and authorization-gated when on.
- One auditable Z.ai client (retries, backoff, timeouts, secret-aware errors).
- Tiny dependency surface: `@actions/core`, `@actions/github`, `picomatch`.

> **Security first.** Commands cannot be run by a random commenter — they are
> gated by a workflow `if:` on `author_association` **and** an in-code
> authorization check. See [`SECURITY.md`](./SECURITY.md) for the full model.

## Setup

1. Create a Z.ai API key at `z.ai`.
2. Add it to your repo as a **secret** named `ZAI_API_KEY` (Settings → Secrets
   and variables → Actions → New repository secret). Use a **secret**, not a
   variable.
3. Add a workflow (see below).

## Quickstart: auto-review

Drop this into `.github/workflows/zai-review.yml`:

```yaml
name: Z.ai Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  pull-requests: write
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: <your-org>/z.ai-code-review-bot@v1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

That's it. Every non-draft PR gets a single review comment, updated on each
push. Large PRs (default: >50 files) are automatically split into char- and
file-budgeted batches, reviewed, and synthesized.

## Optional: interactive `/zai` commands

Commands let collaborators ask questions or request targeted reviews by
commenting `/zai …` on a PR. They are **off by default** and require an
**authorization gate** in the workflow. Add a second workflow:

```yaml
name: Z.ai Commands
on:
  issue_comment:
    types: [created]
permissions:
  pull-requests: write
  contents: read
jobs:
  command:
    # PRIMARY GATE — only trusted collaborators (OWNER/MEMBER/COLLABORATOR).
    # This runs before the job starts; untrusted users get nothing.
    if: >-
      ${{ github.event.issue.pull_request != null
          && contains(fromJson('["OWNER","MEMBER","COLLABORATOR"]'),
                       github.event.comment.author_association) }}
    runs-on: ubuntu-latest
    steps:
      - uses: <your-org>/z.ai-code-review-bot@v1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_COMMANDS_ENABLED: 'true'
```

The `if:` gate is the primary control — it uses GitHub's authoritative
`author_association`. The action also re-checks in code (`ZAI_AUTH_THRESHOLD`,
default `write`) as defense in depth. See [`SECURITY.md`](./SECURITY.md) for why
this matters, especially for fork PRs.

### Commands

| Command | Description |
|---|---|
| `/zai ask <question>` | Ask a question about the PR. |
| `/zai review [file]` | Review a specific file, or the whole PR if no file given. |
| `/zai explain <start>-<end> [file]` | Explain a line range. |
| `/zai describe` | Generate a PR description (posted as a comment; does not edit the PR body). |
| `/zai impact` | Assess the change's impact/risk (posted as a comment; does not apply labels). |
| `/zai help` | Show the command list. |

## Inputs

| Input | Default | Description |
|---|---|---|
| `ZAI_API_KEY` | *(required)* | Z.ai API key. Use a **secret**. |
| `ZAI_MODEL` | `glm-5.2` | Z.ai model name. |
| `ZAI_SYSTEM_PROMPT` | *(built-in)* | System prompt; empty falls back to the built-in default. |
| `ZAI_REVIEWER_NAME` | `Z.ai Code Review` | Header label on the review comment. |
| `EXCLUDE_PATTERNS` | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated globs to exclude. |
| `MAX_DIFF_CHARS` | `100000` | Hard cap on diff chars for the small-PR path (0 = unlimited, discouraged). |
| `ZAI_LARGE_PR_FILE_THRESHOLD` | `50` | File count that triggers batched review. |
| `ZAI_MAX_BATCH_CHARS` | `120000` | Character budget per batch. |
| `ZAI_MAX_FILES_PER_BATCH` | `40` | Max distinct files per batch. |
| `ZAI_MAX_PATCH_CHARS` | `18000` | Max diff chars per file before splitting. |
| `ZAI_COMMANDS_ENABLED` | `false` | Enable `/zai` commands (requires the workflow gate). |
| `ZAI_AUTH_THRESHOLD` | `write` | Min relationship for commands: `admin\|maintain\|write\|read\|none`. |
| `ZAI_ALLOW_FORK_COMMANDS` | `false` | Allow commands on fork PRs. |
| `ZAI_TIMEOUT_MS` | `120000` | Per-attempt Z.ai request timeout (ms). |
| `ZAI_SCHEDULE_ENABLED` | `false` | Re-review open PRs on a schedule. |
| `ZAI_SCHEDULE_MAX_PRS` | `10` | Cap on PRs reviewed per scheduled run. |
| `ZAI_DESCRIBE_WRITE_BODY` | `false` | `/zai describe` writes a marked block into the PR body. |
| `ZAI_IMPACT_LABELS` | `false` | `/zai impact` applies a `zai:`-scoped severity label. |
| `ZAI_IMPACT_LABEL_MAP` | `critical=zai:critical,…` | Severity → label map. |
| `GITHUB_TOKEN` | `github.token` | GitHub token (auto-provided). |

## Development

```bash
npm install
npm test            # vitest suite (507 tests)
npm run test:coverage
npm run build       # @vercel/ncc -> dist/index.js (commit the bundle)
```

`dist/index.js` is committed on purpose — it is what the runner executes. CI
fails if it drifts from `src/`. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for
the module map and [`SECURITY.md`](./SECURITY.md) for the authorization model.

## License

MIT.
