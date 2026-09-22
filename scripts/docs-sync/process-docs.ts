/**
 * @module process-docs
 * @description Processor workflow orchestrator - Runs Phases 2 and 3 of the docs sync pipeline.
 *
 * This script orchestrates the change detection and document chunking phases:
 * - Phase 2: detect-changes.ts - Identifies added, modified, and deleted files
 * - Phase 3: chunk-docs.ts - Splits documents into chunks for RAG ingestion
 *
 * **When to run:** Execute after sync-docs.ts (Phase 1) to process detected changes.
 * This is a convenience wrapper that runs both phases sequentially.
 *
 * **Dependencies:**
 * - state.json from Phase 1 (sync-docs.ts)
 * - Git must be installed and available in PATH
 * - @langchain/textsplitters package
 *
 * **Workflow:**
 * 1. Runs detect-changes.ts to analyze Git diffs
 * 2. Runs chunk-docs.ts to split changed documents
 * 3. Outputs ready-for-rag data for Phase 4 (ingest-chunks.ts)
 *
 * @example
 * // Run Phases 2-3: Detect changes and chunk documents
 * bun run scripts/docs-sync/process-docs.ts
 *
 * @example
 * // Full pipeline: Phase 1 + Phases 2-3 + Phase 4
 * bun run scripts/docs-sync/sync-docs.ts && bun run scripts/docs-sync/process-docs.ts && bun run scripts/docs-sync/ingest-chunks.ts
 *
 * @see sync-docs.ts - Phase 1: Source sync
 * @see detect-changes.ts - Phase 2: Change detection (called by this script)
 * @see chunk-docs.ts - Phase 3: Document chunking (called by this script)
 * @see ingest-chunks.ts - Phase 4: Chunk ingestion
 */

import { join } from 'node:path';
import { $ } from 'bun';

const scriptDir = import.meta.dir;

/**
 * Main execution function for the processor workflow.
 *
 * Sequentially executes:
 * 1. detect-changes.ts - Analyzes Git diffs and creates delta.json
 * 2. chunk-docs.ts - Processes changed files and creates ingest payloads
 *
 * @returns {Promise<void>} Resolves when both phases complete successfully
 *
 * @throws {Error} If either phase fails, the error is propagated
 *
 * @example
 * // Execute the processor workflow
 * await main();
 */
async function main() {
  console.log('== Running Detect Changes ==');
  await $`bun run ${join(scriptDir, 'detect-changes.ts')}`;

  console.log('== Running Chunk Docs ==');
  await $`bun run ${join(scriptDir, 'chunk-docs.ts')}`;

  console.log('== Processor workflow complete ==');
}

main().catch(console.error);
