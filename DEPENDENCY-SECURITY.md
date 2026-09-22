# Dependency security

The Bun lockfile records the dependency graph used by this alpha. Before
preparing a release candidate, run:

```bash
BUN_CONFIG_DOTENV_DISABLE=1 bun audit --json
```

Review every advisory against the affected dependency and the code paths used
by this project. Do not describe an audit as clean unless the command ran on
the exact candidate tree. Do not publish with an unresolved high-severity
advisory.

The npm package remains private and unpublished.
