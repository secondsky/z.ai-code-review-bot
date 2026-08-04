# Contributing

Contributions welcome. A few conventions:

## Development loop

```bash
npm install
npm test                 # vitest, globals enabled
npm run test:coverage    # v8 coverage over src/
npm run build            # rebuild dist/index.js after changing src/
```

## Workflow

- The source under `src/` is ESM (`"type": "module"`). Tests live under
  `tests/`, mirroring the source layout; integration tests under
  `tests/integration/`.
- Write tests first (TDD). Watch them fail, then implement.
- Every module takes its collaborators (octokit, core, callApi, handlers) as
  parameters — keep that DI seam intact so the suite stays network-free.
- After changing `src/`, run `npm run build` and commit the regenerated
  `dist/index.js`. CI fails on `dist/` drift.

## Security-sensitive changes

Anything touching `src/lib/auth.js`, `src/lib/api.js`, or the command dispatch
path in `src/index.js` needs extra care:

- Authorization must be enforced in **code**, not only in docs or workflow
  config. A misconfigured workflow must still not let an untrusted user run a
  command.
- Never log `ZAI_API_KEY` or `GITHUB_TOKEN`. Error messages flow through
  `sanitizeErrorMessage`; extend it if new secret shapes appear.
- Add or update tests that assert the security property (e.g. an unauthorized
  commenter is blocked), not just the happy path.

See [`SECURITY.md`](./SECURITY.md) for the model and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the module map.
