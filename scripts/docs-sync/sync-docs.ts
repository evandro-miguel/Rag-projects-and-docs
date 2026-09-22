/**
 * @module sync-docs
 * @description Phase 1: Source Sync - Main orchestrator for syncing external documentation sources.
 *
 * This script is responsible for:
 * - Cloning or updating Git repositories containing external documentation
 * - Tracking commit hashes for change detection in Phase 2
 * - Saving sync state for incremental processing
 *
 * **When to run:** Execute as the first phase of the external docs sync pipeline,
 * before running detect-changes.ts, chunk-docs.ts, and ingest-chunks.ts.
 *
 * **Dependencies:**
 * - Git must be installed and available in PATH
 * - sources.json must exist in the docs-sync directory
 * - Network access to Git repositories
 *
 * @example
 * // Run Phase 1: Sync all external documentation sources
 * bun run scripts/docs-sync/sync-docs.ts
 *
 * @example
 * // Run as part of the full pipeline
 * bun run scripts/docs-sync/process-docs.ts
 *
 * @see detect-changes.ts - Phase 2: Change detection
 * @see chunk-docs.ts - Phase 3: Document chunking
 * @see ingest-chunks.ts - Phase 4: Chunk ingestion
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

/**
 * Configuration for a documentation source.
 */
interface Source {
  /** Unique identifier for this source */
  id: string;
  /** Git repository URL */
  url: string;
  /** Source type (currently only 'git' is supported) */
  type: string;
  /** Git branch to sync (defaults to 'main') */
  branch?: string;
  /** Path within the repository to sync (optional) */
  path?: string;
  /** Human-readable title for the source */
  title: string;
}

const ROOT_DIR = join(import.meta.dir, '../../');
const SOURCES_PATH = join(import.meta.dir, 'sources.json');
const RAW_DOCS_DIR = join(ROOT_DIR, '.data', 'raw-docs');

// Ensure raw directory exists
if (!existsSync(RAW_DOCS_DIR)) {
  mkdirSync(RAW_DOCS_DIR, { recursive: true });
}

/**
 * Main execution function for Phase 1: Source Sync.
 *
 * Iterates through all configured sources in sources.json and:
 * 1. Clones new repositories or pulls updates for existing ones
 * 2. Records previous and current commit hashes
 * 3. Saves sync state to state.json for Phase 2
 *
 * @returns {Promise<void>} Resolves when all sources are synced
 *
 * @throws {Error} If Git operations fail for a source (continues with other sources)
 *
 * @example
 * // Execute the sync process
 * await main();
 */
async function main() {
  console.log('🚀 Starting Phase 1: Source Sync');
  const sourcesData = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8')) as {
    sources: Source[];
  };

  const syncState: Record<string, { prevHash: string | null; currHash: string; syncTime: string }> =
    {};

  for (const source of sourcesData.sources) {
    if (source.type !== 'git') {
      console.warn(`[${source.id}] Only 'git' type is supported currently. Skipping.`);
      continue;
    }

    const repoDir = join(RAW_DOCS_DIR, source.id);
    const branch = source.branch || 'main';
    let prevHash: string | null = null;
    let currHash = '';

    try {
      if (existsSync(join(repoDir, '.git'))) {
        console.log(`[${source.id}] Found existing repo. Fetching and pulling updates...`);
        // Get previous hash
        const getPrevHash = await $`git -C ${repoDir} rev-parse HEAD`.quiet();
        prevHash = getPrevHash.stdout.toString().trim();

        // Pull changes
        await $`git -C ${repoDir} fetch origin ${branch}`.quiet();
        await $`git -C ${repoDir} reset --hard origin/${branch}`.quiet();
      } else {
        console.log(`[${source.id}] No local repo found. Cloning...`);
        await $`git clone -b ${branch} ${source.url} ${repoDir}`.quiet();
      }

      const getCurrHash = await $`git -C ${repoDir} rev-parse HEAD`.quiet();
      currHash = getCurrHash.stdout.toString().trim();

      syncState[source.id] = {
        prevHash,
        currHash,
        syncTime: new Date().toISOString(),
      };

      console.log(`[${source.id}] Sync complete. HEAD is ${currHash}`);
    } catch (e: any) {
      console.error(`[${source.id}] ❌ Failed to sync: ${e.message}`);
    }
  }

  // Save state for detection phase
  const statePath = join(RAW_DOCS_DIR, 'state.json');
  writeFileSync(statePath, JSON.stringify(syncState, null, 2));
  console.log(`✅ Phase 1 complete. State saved to ${statePath}`);
}

main().catch(console.error);
