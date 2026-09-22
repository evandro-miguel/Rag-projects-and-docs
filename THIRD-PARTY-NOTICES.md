# Third-party notices

RAG-v2 source is released under the MIT license in [LICENSE](LICENSE).

The Bun lockfile records the exact dependency graph and integrity metadata.
Each dependency keeps its upstream license and notice; downstream users must
retain those notices when redistributing a build. This repository does not
intentionally vendor third-party source code.

The Docker path also pulls upstream images and model/runtime assets, including
Postgres/pgvector, Bun, and the optional reranker. Their licenses and notices
are supplied by their respective projects and image distributions; this
repository does not replace them. Review image manifests and upstream notices
before redistribution.

Run `bun pm pack --dry-run` and inspect the resulting file list before any
separately authorized package publication. The package remains private in this
alpha.
