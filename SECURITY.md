# Security model

This document describes how authorization works and what is enforced in code
versus in workflow configuration. **A protection claimed here is enforced in
code or workflow — never only in docs.**

## The two things this action does

1. **Auto-review** — on every `pull_request`, post one AI review comment.
   Repo-initiated and automatic. **No user authorization** is required: the
   action itself decides to run, the Z.ai key is used only to call Z.ai
   server-side, and nothing is written to the PR beyond a single comment.
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

**Why `issue_comment` + `author_association`:** `/zai` commands are PR comments
(`issue_comment` events). A drive-by commenter on a fork PR *can* trigger
`issue_comment`, and the `GITHUB_TOKEN` *can* write that fork PR's conversation
— so without this gate, a random person could run commands. GitHub's
`author_association` is the authoritative, pre-computed mapping of a commenter's
relationship to the repo (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …).
No extra API call or token scope is needed. **Never use `pull_request_target`
for commands** — it is a secret-exfiltration footgun. Auto-review uses plain
`pull_request`; commands use `issue_comment` plus this gate.

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

A blocked user is **silently** dropped: no comment, no reaction, no feedback to
probe with. Unknown threshold values fall back to the `write` set and flag
`unknownThreshold: true` (the action fails closed, not open).

**Note on "code owners":** GitHub's `author_association` already captures repo
owner, org members, and collaborators (including code owners who hold a repo
role). For the common case, `COLLABORATOR`/`MEMBER` covers them. This action
does **not** parse `CODEOWNERS` per-path in v1; that's a documented roadmap
item if you need path-granular control.

### Fork pull requests

By default `ZAI_ALLOW_FORK_COMMANDS: false`. Fork PRs cannot run commands even
from authorized users. The `issue_comment` payload does not carry fork-ness, so
when the fork gate is active the router resolves it via `octokit.rest.pulls.get`
and passes the real value to `authorize()`. This makes the in-code fork gate
enforceable on the command path under every threshold, including `none`.

## Output safety & prompt injection

Auto-review runs on plain `pull_request` with **no `author_association` gate** —
a fork-PR author controls the diff, title, and body that reach the model. Three
layers defend against indirect prompt injection and abusive model output:

1. **Instruction hardening (prompt).** All PR content is wrapped in
   `<untrusted_input>` tags with a preamble telling the model to treat it as
   data and never obey instructions inside it. Filenames and diff close-tags
   are escaped so they cannot break the structural boundary. A non-disclosure
   clause is appended to the system prompt to resist instruction-leakage.
2. **Output sanitization (`src/lib/sanitize-output.js`).** Every model response
   is sanitized before it is posted as a GitHub comment: `@mentions` are
   neutralized (breaks notification spam), and GitHub alert banners
   (`> [!WARNING]`) are neutralized (blocks callout-banner forgery). Links,
   images, code, and HTML are deliberately left intact so legitimate reviews
   render normally.
3. **`MAX_DIFF_CHARS` cap.** Defaults to `100000` to bound prompt size and
   cost. `0` means unlimited (not recommended — a large fork PR can exhaust
   your Z.ai quota).

**The model's `Rating:` field must NEVER be used as an auto-merge signal.** It
is model-generated and can be influenced by PR content. The action itself never
merges; if your workflow auto-merges on a clean review, do not trust the rating.

## Commands are read-only by default (opt-in mutations)

`/describe` posts a generated description as a comment; `/impact` posts an
assessment. By default neither mutates the PR. Two opt-in features override
this (each defaults to OFF and requires its own token scope):

- `ZAI_DESCRIBE_WRITE_BODY: true` — `/describe` upserts a marked
  `<!-- zai-description -->` block into the PR body via `pulls.update`. Only the
  marked block is ever mutated; the rest of the body is preserved. Requires
  `pull-requests: write` (already the default).
- `ZAI_IMPACT_LABELS: true` — `/impact` applies a `zai:`-prefixed label based on
  the severity the model emits. Only `zai:` labels are managed (added/removed);
  human labels are never touched. Requires `issues: write` (add it to your
  workflow `permissions:` when enabling).

## Concurrency & rate limiting

Per-PR serialization is provided via GitHub Actions `concurrency:` groups in the
example workflows (`zai-review-<sha>` for auto-review, `zai-commands-pr-<n>`
for commands). Copy them into your workflow to prevent the cost-amplification
and duplicate-summary race that rapid force-pushes or rapid commands would
otherwise trigger. The authorization gate + fork guard stop the abuse that
matters (a random person spending your credits); per-user/per-PR budgets beyond
the concurrency group are a roadmap item.

## Reporting a vulnerability

Please open a private security advisory (GitHub "Security" tab → "Report a
vulnerance") rather than a public issue.
