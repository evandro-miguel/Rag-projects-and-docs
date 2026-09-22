# Contributing

Contributions use the repository's Bun lockfile and TypeScript conventions.
Keep changes focused, add behavioral tests for meaningful changes, and update
user-facing documentation when behavior changes.

## Local checks

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test -- path/to/related.test.ts
```

Database and provider-backed checks require isolated local services. Do not
point a test run at production data or publish credentials, indexed content, or
unredacted logs.

Before submitting a change, review `git diff --check`, note checks that could
not run, and describe any remaining limitations.
