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
from authorized users. (Note: for `issue_comment` events the action cannot
always determine fork-ness from the event payload alone; Layer 1 is the primary
fork control. `ZAI_ALLOW_FORK_COMMANDS` is the in-code guard where fork-ness is
known.)

## Commands are read-only in v1

`/describe` posts a generated description as a comment but does **not** rewrite
the PR body (no `pulls.update`). `/impact` posts an assessment but does **not**
apply labels (no `issues.addLabels`). The fork this action merges from did both
as side effects; v1 deliberately rejects them. There are dedicated tests
asserting these calls are never made.

## Secret handling

- `ZAI_API_KEY` and `GITHUB_TOKEN` are masked in logs via `core.setSecret` at
  startup.
- The Z.ai client (`src/lib/api.js`) never logs the API key. Error messages are
  run through `sanitizeErrorMessage`, which redacts `Bearer …`, `api_key=…`,
  `Authorization: …`, credential URLs, and JSON blobs containing
  `api_key`/`token`/`secret`/`password`/`credential`, then truncates to 500
  chars.
- Store `ZAI_API_KEY` as a GitHub **secret**, not a variable. Non-secret
  configuration (model, reviewer name, system prompt) may use `vars.*`.

## Rate limiting (not implemented in v1)

The fork *claimed* per-user/per-PR rate limits but never implemented them (a
doc-vs-code drift we explicitly reject). v1 does not ship rate-limit inputs. The
authorization gate + fork guard stop the abuse that matters (a random person
spending your credits). Per-user/per-PR budgets are a roadmap item.

## Reporting a vulnerability

Please open a private security advisory (GitHub "Security" tab → "Report a
vulnerance") rather than a public issue.
