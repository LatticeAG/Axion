# Contributing

Thanks for your interest in Axion. This is an early-phase project, so expect rough edges.

## Development

Requirements: Node 20+ and npm.

```bash
npm ci          # install dependencies
npm run dev     # run the Worker locally (wrangler dev)
npm test        # run the test suite (vitest)
npm run check   # typecheck + tests; run this before opening a PR
```

Copy `.dev.vars.example` to `.dev.vars` and fill in the values you need for local runs.

## Pull requests

- Keep changes focused. One logical change per PR.
- Run `npm run check` and make sure it passes before opening a PR.
- Match the existing code style; don't reformat unrelated files.
- Describe what changed and why in the PR description.

## Reporting security issues

Do not open a public issue for security problems. See [SECURITY.md](./SECURITY.md).
