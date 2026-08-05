# Security model

This document describes how authorization works and what is enforced in code
versus in workflow configuration. **A protection claimed here is enforced in
code or workflow — never only in docs.**

## The two things this action does

1. **Auto-review** — on every `pull_request`, run deterministic scanners + a
   Z.ai model review, then post **inline line-level review comments** + a
   **walkthrough summary**. Repo-initiated and automatic. **No user
   authorization** is required: the action itself decides to run, the Z.ai key
   is used only to call Z.ai server-side.
2. **Interactive `/zai` commands** — `ask`, `review`, `explain`, `describe`,
   `impact`, `help`, triggered by PR comments. **User-initiated, so
   authorization is mandatory.** This is where abuse lives: without a gate, any
   commenter (including a random person on a fork PR) could run `/zai ask` and
   spend your Z.ai API credits.

## Authorization for `/zai` commands: defense in depth

Commands are gated by **two independent layers**. Both must agree.

### Layer 1 — workflow `if:` gate (primary)

The consuming repo's workflow gates the job on `author_association` *before the
job starts* — before checkout, secrets, or our code. See
`.github/workflows/zai-commands.example.yml`:

```yaml
on:
  issue_comment:
    types: [created]
jobs:
  command:
    if: >-
      ${{ github.event.issue.pull_request != null
          && contains(fromJson('["OWNER","MEMBER","COLLABORATOR"]'),
                       github.event.comment.author_association) }}
```

Untrusted users are stopped here with zero runner minutes, zero reaction, and
zero secret surface.

### Layer 2 — in-code `authorize()` (defense in depth)

`src/lib/auth.js` re-checks authorization so that a **misconfigured workflow**
(a missing or wrong `if:` gate) still cannot let an untrusted user run commands.
The check is a pure function of `author_association`, the configured threshold,
and fork status:

| `ZAI_AUTH_THRESHOLD` | Associations allowed |
|---|---|
| `admin` | OWNER |
| `maintain` | OWNER, MEMBER |
| `write` (default) | OWNER, MEMBER, COLLABORATOR |
| `read` | OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR |
| `none` | *(in-code gate disabled — relies entirely on Layer 1; not recommended)* |

A blocked user is **silently** dropped. Unknown thresholds fall back to `write`
and flag `unknownThreshold: true` (fail closed, not open).

### Fork pull requests

`ZAI_ALLOW_FORK_COMMANDS: false` (default). Fork PRs cannot run commands even
from authorized users. The `issue_comment` payload doesn't carry fork-ness, so
the router resolves it via `octokit.rest.pulls.get` and **fails closed**
(treats as fork) if the lookup throws.

## Auto-review: output safety & prompt injection

Auto-review runs on plain `pull_request` with **no `author_association` gate** —
a fork-PR author controls the diff, title, body, `.zai.yml`, and CODEOWNERS that
reach the model and scanners. Defense layers:

### 1. Prompt hardening
All PR content is wrapped in `<untrusted_input>` tags with a preamble telling
the model to treat it as data and never obey instructions inside it. Filenames,
diff close-tags, and repo-config (`path_instructions`, `tone_instructions`) are
escaped so they cannot break the structural boundary. A non-disclosure clause
is appended to the system prompt to resist instruction-leakage.

### 2. Output sanitization (`src/lib/sanitize-output.js`)
**Every** model response is sanitized before posting — inline review comment
bodies, the review summary body, command responses, and fallback comments:
- `@mentions` are neutralized with a zero-width space (breaks notification spam).
- GitHub alert banners (`> [!WARNING]`) are defanged (blocks callout forgery).
- Output is length-capped (16 KiB).
- Links, images, code, and HTML are left intact so legitimate reviews render.

### 3. Structured findings validation
Model output is parsed as JSON findings, each validated against a strict schema,
and **filtered by the actual changed-files list** (anti-hallucination: a finding
for a file not in the diff is dropped). Scanner findings carry provenance
(`rule: '<scanner>:<id>'`).

### 4. Cost controls
`MAX_DIFF_CHARS` (default 100000), `ZAI_MAX_FINDINGS` (default 8), and
`ZAI_BATCH_CONCURRENCY` (default 3) bound prompt size, output volume, and API
fan-out.

**The model's severity/confidence fields must NEVER be used as an auto-merge
signal.** They are model-generated and influenceable by PR content. The action
never merges. `ZAI_STRICT_MODE` (opt-in, default off) posts `REQUEST_CHANGES`
on critical/high findings — this blocks merge but is advisory, not a security
verdict.

## Untrusted input surfaces (v2)

Every external input is treated as untrusted and validated:

### `.zai.yml` repo config — narrowing-only contract
Fetched from the PR head SHA. In fork PRs this file is **attacker-controllable**.
The security control is `mergeRepoConfig` (`src/lib/repo-config.js`): the repo
config can only **narrow** behavior — lower `maxFindings`, add `path_filters`
(union with action excludes), disable scanners. It **cannot** raise caps,
enable a scanner the action disabled, change auth thresholds, or reduce
excludes. Action inputs always win on security/cost knobs. Unknown keys are
dropped. On any error (missing, malformed, oversized) → warn + empty config.

### CODEOWNERS
Fetched from the PR head SHA for reviewer suggestions. The parser strips `!`
negation patterns (picomatch interprets `!` as gitignore negation — an
attacker-controlled CODEOWNERS could otherwise match everything). Suggested
reviewer `@mentions` in the summary are sanitized (zero-width space break).

### Scanner output
Scanner findings flow through the same `validateFinding` + anti-hallucination
file-filter pipeline as LLM findings. Scanner binary output (gitleaks/ast-grep
JSON) is parsed defensively; parse failures degrade to the regex fallback.

## Write surfaces (GitHub API mutations)

| Surface | API | Permission | Default |
|---|---|---|---|
| Inline review comments + summary | `pulls.createReview` | `pull-requests: write` | on |
| Dismiss stale bot reviews on re-push | `pulls.dismissReview` | `pull-requests: write` | on |
| Summary comment (no-inline fallback) | `issues.create/updateComment` | `pull-requests: write` | fallback only |
| Commit status (pending/success/failure) | `repos.createCommitStatus` | `statuses: write` | on (`ZAI_COMMIT_STATUS`) |
| Strict mode (blocks merge) | `pulls.createReview` event=`REQUEST_CHANGES` | `pull-requests: write` | off (`ZAI_STRICT_MODE`) |
| `/describe` PR body mutation | `pulls.update` (marked block only) | `pull-requests: write` | off (`ZAI_DESCRIBE_WRITE_BODY`) |
| `/impact` labels | `issues.addLabels/removeLabel` (`zai:` scoped only) | `issues: write` | off (`ZAI_IMPACT_LABELS`) |
| CODEOWNERS auto-assign | `pulls.requestReviewers` | `pull-requests: write` | off (`ZAI_AUTO_ASSIGN_REVIEWERS`) |

All write surfaces are **fail-soft** — a permission error logs a warning and
continues; it never breaks the review.

## Scanner binary trust chain

The deterministic scanners (gitleaks for secrets, ast-grep for code patterns)
download binaries from GitHub Releases on first use:

1. **Fetch** the release asset for the runner's platform/arch.
2. **Verify** SHA256 against the pinned checksum in
   `src/lib/scanners/{secrets,patterns}.js` (fail-closed: mismatch → throw).
3. **Extract** via the system `tar` binary (no npm `tar` dependency — avoids
   its CVE history).
4. **Cache** in `ZAI_SCANNERS_CACHE_DIR` (default `~/.zai-cache/scanners`).
5. **Execute** via `child_process.execFile` with the diff's added lines.

On ANY failure (network, checksum, extraction, execution), the scanner
**degrades to the built-in regex fallback** and logs a warning. The review is
never blocked by a scanner failure. The checksums are pinned in source;
version bumps require updating both the version and the SHA256 values.

## Incremental review dedup

Re-pushes store a content hash of each finding in a hidden HTML comment
(`<!-- zai-hashes:... -->`) in the review body. On the next run, findings whose
hash already exists are suppressed (only new/changed findings surface). The
hash block is a separate comment from the `<!-- zai-code-review -->` marker;
both coexist without interfering with idempotency detection.

## Concurrency & rate limiting

Per-PR serialization via GitHub Actions `concurrency:` groups in the example
workflows (`zai-review-<sha>`, `zai-commands-pr-<n>`, `zai-schedule`). Copy
them to prevent cost-amplification and duplicate-review races from rapid
force-pushes.

## Reporting a vulnerability

Please open a private security advisory (GitHub "Security" tab → "Report a
vulnerability") rather than a public issue.
