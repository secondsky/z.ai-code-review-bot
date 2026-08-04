# Plan: `z.ai-code-review-bot` — merged v1 with a *real* authorization model

## The core ask, answered up front

> "make sure unused `isCollaborator`, `AUTHORIZED_*` constants are not useful… implement a proper github action constraint so only the repo owner / collaborators / code owners can use this (not some random person with a PR)."

**Confirmed: in the fork (`AndreiDrang/zai-code-bot`) these are dead and useless *as written*.**
- `checkAuthorization()` / `checkForkAuthorization()` both short-circuit to `return { authorized: true, reason: 'identifiable_user' }` for anyone with a `login`. Everything below the early `return` is unreachable.
- `AUTHORIZED_ASSOCIATIONS` is a set containing *every* possible association (`OWNER`…`NONE`…`MANNEQUIN`) → a no-op even if it were called.
- `isCollaborator()` is actually *well-implemented* (`getCollaboratorPermission` + 10 s `Promise.race` timeout + 404→false), but it is never reached in the live path. Its unit tests even assert the broken `authorized: true` as "expected."

**Conclusion:** don't carry the dead symbols over. Keep the *intent* (collaborator gating), throw away the permissive implementation, and enforce it in two layers — a workflow-level `if:` gate (primary, blocks before the runner/secrets are touched) and an in-code `authorize()` (defense-in-depth, catches misconfigured workflows).

Since you chose **trusted collaborators** (OWNER + MEMBER + COLLABORATOR) and **author_association semantics** (no CODEOWNERS parsing), the design below uses GitHub's authoritative pre-computed `author_association` as the single signal — no extra permission API calls needed, no new token scopes.

---

## Authorization design (the centerpiece)

### Layer 1 — Workflow `if:` gate (primary)

Interactive `/zai` commands are PR comments → trigger `issue_comment: [created]`, restricted to PRs. A drive-by commenter on a **fork** PR *can* trigger `issue_comment` and the `GITHUB_TOKEN` *can* write that PR's conversation — so without this gate, a random person burns your Z.ai credits. This gate stops them before the job starts.

`.github/workflows/zai-commands.example.yml`:
```yaml
on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  contents: read       # bump to write only if you enable /describe or /impact

jobs:
  command:
    # PRIMARY GATE — runs before checkout, secrets, or our code
    if: ${ github.event.issue.pull_request != null
           && contains(fromJson('["OWNER","MEMBER","COLLABORATOR"]'),
                        github.event.comment.author_association) }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./            # or <you>/z.ai-code-review-bot@v1
        with:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
          ZAI_COMMANDS_ENABLED: 'true'
```

Notes baked into the example/comments:
- **Never** use `pull_request_target` for the command path — it's a secret-exfiltration footgun. Auto-review uses plain `pull_request`; commands use `issue_comment` + this gate.
- The gate is the *clean UX*: untrusted users get no runner minutes, no reaction, no secret surface.

### Layer 2 — In-code `authorize()` (defense-in-depth, single source of truth)

`src/lib/auth.js` (rewritten, replacing the fork's bypass):
```js
// Threshold → association set. author_association is GitHub's authoritative,
// pre-computed signal (includes team membership + pending invites). No API call needed.
const THRESHOLD_ASSOCIATIONS = {
  admin:    ['OWNER'],
  maintain: ['OWNER', 'MEMBER'],
  write:    ['OWNER', 'MEMBER', 'COLLABORATOR'],   // default
  read:     ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'],
  none:     null,                                   // gate disabled (fork+ratelimit still apply)
};

function authorize({ comment, sender, isFork, config }) {
  const assoc = comment?.author_association || sender?.author_association;
  const allowed = THRESHOLD_ASSOCIATIONS[config.authThreshold] ?? THRESHOLD_ASSOCIATIONS.write;
  if (allowed && !allowed.includes(assoc)) {
    return { authorized: false, silent: true };      // match fork's silent-block UX for non-trusted
  }
  if (isFork && !config.allowForkCommands) {
    return { authorized: false, silent: true };
  }
  return { authorized: true };
}
```
- Pure function → trivially unit-testable (no octokit mock needed for the core decision).
- `isFork` derived once from the PR payload in `events.js` (`pull_request.head.repo.fork`).
- **Drops entirely:** `AUTHORIZED_PERMISSIONS`, `AUTHORIZED_ASSOCIATIONS`, the dead `isCollaborator` API call, `API_TIMEOUT_MS`, `isRepoOwner`, `getCommentAuthorAssociation`, `isTrustedCommentAuthor`. If you later want a stricter per-role check, `getCollaboratorPermission` can be added behind an opt-in input — not in v1.

### What's gated, what isn't
- **Auto-review** (`pull_request` events): repo-initiated, automatic → **no user auth**. Uses plain `pull_request` (safe on forks: secrets are used only to call Z.ai server-side, never written to the PR). One summary comment, updated in place via `<!-- zai-code-review -->` marker.
- **`/zai` commands** (`issue_comment`): user-initiated → **auth required**, off by default (`ZAI_COMMANDS_ENABLED: false`). Commands: `ask`, `review [file]`, `explain <lines>`, `describe`, `impact`, `help`.
- **Scheduled tasks** (`schedule`/`workflow_dispatch`, e.g. AGENTS.md regen): repo-initiated → no user auth. Off by default, needs `contents: write`.

### Rate-limiting — kept honest
The fork *claimed* rate limits but didn't implement them (the drift we're rejecting). For v1 I recommend **dropping the `ZAI_RATE_LIMIT_*` inputs from `action.yml`** and documenting rate-limiting as a roadmap item. The association gate + fork guard already stop the abuse you care about (a random person spending your credits). If you want them in v1, say so and I'll implement them via a hidden JSON marker comment on the PR (no new deps, persists per-PR) — but I will *not* ship inputs that aren't enforced.

---

## What's carried over from each parent (and what's rejected)

**From upstream `tarmojussila/zai-code-review`** — the auditable hygiene:
- Idempotent summary comment via `<!-- zai-code-review -->` marker (Issues API), update-in-place.
- `core.setSecret()` masking for **both** `ZAI_API_KEY` and `GITHUB_TOKEN`.
- Configurable `ZAI_SYSTEM_PROMPT`, `ZAI_REVIEWER_NAME`, `EXCLUDE_PATTERNS`; the `vars.*` (variables) vs `secrets.*` doc pattern.
- Minimal permissions (`pull-requests: write`), default `github.token`.
- node20 + `@vercel/ncc` → committed `dist/index.js`.

**From fork `AndreiDrang/zai-code-bot`** — the engineering depth:
- `lib/api.js` retry client → becomes the **single** Z.ai transport (exponential backoff `baseDelay·2^attempt + jitter`, progressive timeouts 100/67/50/33%, `categorizeError` matrix, `sanitizeErrorMessage` Bearer/api_key/Authorization/URL redaction, 500-char truncation, optional `fallbackPrompt`).
- `auto-review.js` pure pipeline → `scoreFile` (size≤+40, added/renamed +8, HIGH_RISK_PATTERNS +24), `splitTextByLines` (line-aware chunking), `createReviewEntries` + `createReviewBatches` (char AND distinct-file budgeted), `buildSynthesisPrompt` + `buildFallbackReview`, `isContextLimitError`, recursive halving in `executeReviewBatch`.
- 6 command handlers (`ask`/`review`/`explain`/`describe`/`impact`/`help`) with the `deps = {}` DI seam for testability.
- vitest + coverage, Node 20/22 matrix, `dist-drift` CI gate.

**Rejected / fixed (not carried forward):**
- ❌ The auth bypass (`authorized: true`) and all dead symbols above.
- ❌ Two divergent Z.ai transports → **one** client used by both auto-review and commands.
- ❌ Hardcoded/duplicated system prompt → centralized in `src/lib/prompt.js`.
- ❌ Upstream's lossy `MAX_DIFF_CHARS` greedy truncation as the *only* large-PR strategy → batching/synthesis is primary; `MAX_DIFF_CHARS` survives only as an optional hard total cap.
- ❌ Upstream's sentinel-byte (`\x00`) glob hack → **`picomatch`** (handles `**`, `?`, `[a-z]`, leading-slash correctly).
- ❌ Tests that asserted `authorized: true` as expected → rewritten to assert real enforcement.
- ❌ Doc-vs-code drift on rate limits → inputs removed until implemented.

---

## Target file structure

```
action.yml                      # inputs (incl. ZAI_COMMANDS_ENABLED, ZAI_AUTH_THRESHOLD, ZAI_ALLOW_FORK_COMMANDS)
package.json                    # @actions/core, @actions/github, picomatch; dev: ncc, vitest, yaml
vitest.config.js
README.md  SECURITY.md  ARCHITECTURE.md  CONTRIBUTING.md  LICENSE
.github/workflows/
  ci.yml                        # test (node 20/22) + coverage + dist-drift gate
  zai-review.example.yml        # auto-review consumer example (pull_request)
  zai-commands.example.yml      # command consumer example (issue_comment + the if: gate)
src/
  index.js                      # entry; event routing (pull_request vs issue_comment vs schedule)
  lib/
    config.js                   # read inputs → validated config object
    api.js                      # SINGLE Z.ai client (from fork lib/api.js, used everywhere)
    auth.js                     # authorize() — rewritten, association-based (above)
    prompt.js                   # DEFAULT_SYSTEM_PROMPT + all prompt builders (single source)
    glob.js                     # picomatch-based exclude matcher
    comments.js                 # marker upsert (idempotent summary comment)
    events.js                   # eventName / isPullRequest / isFork / getCommenter helpers
    changed-files.js            # paginated pulls.listFiles
    auto-review.js              # scoring/chunking/batching/synthesis (pure) + orchestration hooks
    commands.js                 # /zai parser + allowlist
    handlers/{index,ask,review,explain,describe,impact,help}.js
dist/index.js                   # ncc bundle, committed, drift-gated
tests/
  auth.test.js                  # REWRITTEN — asserts OWNER/MEMBER/COLLAB pass, CONTRIBUTOR/NONE/fork blocked
  api.test.js  glob.test.js  auto-review.test.js  commands.test.js  comments.test.js
  handlers/{ask,review,explain,describe,impact,help}.test.js
  integration/{pr-auto-review,command-pipeline}.test.js
```

## Build order (TDD per module — tests first, then impl)

1. **Project scaffold:** `package.json`, `vitest.config.js`, `.gitignore`, `git init`, install deps, ncc build wiring. CI skeleton.
2. **`config.js` + `events.js` + `glob.js`** (pure, fast wins; tests for picomatch exclude behavior).
3. **`api.js`** — port fork's client verbatim-ish; port + adapt its test suite (retry/backoff/categorize/sanitize). Verify it's the *only* transport.
4. **`auth.js`** — write failing tests first (trusted associations pass; `CONTRIBUTOR`/`NONE`/`MANNEQUIN` blocked; fork blocked unless allowed; threshold `admin` rejects MEMBER; `silent:true` UX). Then implement `authorize()`. This is the module you care most about — it gets the most thorough tests.
5. **`comments.js` + `changed-files.js` + `prompt.js`** — marker upsert, paginated fetch, centralized prompts.
6. **`auto-review.js`** — port the pure pipeline + recursive-halving orchestration; port/adapt `auto-review.test.js`.
7. **`index.js` event routing** — `pull_request` → auto-review (batching path); `issue_comment` → parse → **`authorize()`** → dispatch; bot-self-comment anti-loop.
8. **Handlers** — port the 6 from the fork, standardize the `deps = {}` seam on all (fix `describe.js`/`help.js` which lacked it), wire them to the single `api.js` client. `/explain` keeps the fallback-prompt; `/describe` & `/impact` mutate PR state (documented, auth-gated).
9. **Integration tests** — `pr-auto-review` (marker idempotency, no-duplicate-on-synchronize, no-patchable short-circuit); `command-pipeline` (parse→auth→dispatch for all 6, `@zai`/`@zai-bot` alias, non-PR skip, bot skip, **untrusted-user blocked**).
10. **`action.yml` + example workflows** (with the `if:` gate) + docs (README/SECURITY/ARCHITECTURE).
11. **`ncc build` → commit `dist/`** → confirm CI `dist-drift` passes.

## Execution approach
Following **test-driven-development**: each module gets failing tests first, then the minimal implementation, then refactor — auth especially. Following **subagent-driven-development**: I'll dispatch focused subagents per module with explicit file targets and the parent-repo patterns above as reference, verifying tests pass before moving on. `dist/` rebuilt and committed only at the end (and whenever `src/` changes), enforced by the CI drift gate.

## Open point for you
**Rate limits in v1?** Default plan = **drop** `ZAI_RATE_LIMIT_*` inputs (honest; association+fork gates are the real fix). Alternative = implement now via a hidden per-PR JSON marker comment (no new deps). I'll go with "drop" unless you tell me otherwise when approving.