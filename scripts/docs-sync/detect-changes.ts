/**
 * @module detect-changes
 * @description Phase 2: Watchdog - Detect changes in synced documentation sources.
 *
 * This script analyzes Git repository changes between sync states to identify:
 * - Added files (new documentation)
 * - Modified files (updated documentation)
 * - Deleted files (removed documentation)
 *
 * **When to run:** Execute after sync-docs.ts (Phase 1) and before chunk-docs.ts (Phase 3).
 * Requires state.json from Phase 1 to compare commit hashes.
 *
 * **Dependencies:**
 * - state.json from Phase 1 (sync-docs.ts)
 * - sources.json configuration file
 * - Git must be installed and available in PATH
 *
 * **Output:** Creates delta.json with change information for Phase 3.
 *
 * @example
 * // Run Phase 2: Detect changes in external documentation
 * bun run scripts/docs-sync/detect-changes.ts
 *
 * @example
 * // Run as part of the full processor workflow
 * bun run scripts/docs-sync/process-docs.ts
 *
 * @see sync-docs.ts - Phase 1: Source sync
 * @see chunk-docs.ts - Phase 3: Document chunking
 * @see ingest-chunks.ts - Phase 4: Chunk ingestion
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

/**
 * Sync state for a single source, tracking commit hashes.
 */
interface SyncState {
  [sourceId: string]: {
    /** Previous commit hash (null for new repositories) */
    prevHash: string | null;
    /** Current commit hash after sync */
    currHash: string;
    /** ISO timestamp of when sync occurred */
    syncTime: string;
  };
}

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
  /** Git branch to sync */
  branch?: string;
  /** Path within the repository to sync */
  path?: string;
  /** Human-readable title for the source */
  title: string;
}

const ROOT_DIR = join(import.meta.dir, '../../');
const RAW_DOCS_DIR = join(ROOT_DIR, '.data', 'raw-docs');
const SOURCES_PATH = join(import.meta.dir, 'sources.json');

/**
 * Main execution function for Phase 2: Change Detection.
 *
 * For each configured source:
 * 1. Compares previous and current commit hashes
 * 2. Uses git diff to identify added, modified, and deleted files
 * 3. Filters for target file types (.md, .mdx, .html)
 * 4. Performs SHA-256 hash deduplication to skip content-identical modifications
 * 5. Saves delta information to delta.json
 *
 * @returns {Promise<void>} Resolves when all sources are analyzed
 *
 * @throws {Error} Exits with code 1 if state.json is missing
 *
 * @example
 * // Execute change detection
 * await main();
 */
async function main() {
  console.log('🚀 Starting Phase 2: Watchdog (Detect Changes)');
  const statePath = join(RAW_DOCS_DIR, 'state.json');
  if (!existsSync(statePath)) {
    console.error('❌ No state.json found. Phase 1 must run first.');
    process.exit(1);
  }

  const syncState = JSON.parse(readFileSync(statePath, 'utf-8')) as SyncState;
  const sourcesData = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8')) as { sources: Source[] };

  const deltas: Record<
    string,
    {
      added: string[];
      modified: string[];
      deleted: string[];
    }
  > = {};

  for (const source of sourcesData.sources) {
    if (!syncState[source.id]) {
      console.warn(`[${source.id}] No state found, skipping...`);
      continue;
    }

    const { prevHash, currHash } = syncState[source.id];
    const repoDir = join(RAW_DOCS_DIR, source.id);
    const docsPathFilter = source.path ? `${source.path}/` : '';

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // Filter target docs: markdown or HTML
    const isTargetFile = (f: string) => {
      if (docsPathFilter && !f.startsWith(docsPathFilter)) return false;
      return f.endsWith('.md') || f.endsWith('.mdx') || f.endsWith('.html');
    };

    if (!prevHash || prevHash === currHash) {
      if (!prevHash) {
        console.log(`[${source.id}] New repository. Getting all target files...`);
        const listOutput = await $`git -C ${repoDir} ls-files`.quiet();
        const allFiles = listOutput.stdout
          .toString()
          .split('\n')
          .map((f: string) => f.trim())
          .filter(Boolean);
        added.push(...allFiles.filter(isTargetFile));
      } else {
        console.log(`[${source.id}] No commits since last sync. Delta is empty.`);
      }
    } else {
      console.log(`[${source.id}] Hashes changed. Running git diff...`);
      const diffOutput =
        await $`git -C ${repoDir} diff --name-status ${prevHash} ${currHash}`.quiet();
      const lines = diffOutput.stdout
        .toString()
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const [status, ...fileParts] = line.split(/\s+/);
        const path = fileParts[fileParts.length - 1]; // get the target path

        if (!isTargetFile(path)) continue;

        if (status.startsWith('A') || status.startsWith('C')) added.push(path);
        else if (status.startsWith('M')) modified.push(path);
        else if (status.startsWith('D')) deleted.push(path);
        else if (status.startsWith('R')) {
          // renamed means old one deleted, new one added
          const oldPath = fileParts[0];
          if (isTargetFile(oldPath)) deleted.push(oldPath);
          added.push(path);
        }
      }
    }

    // SHA-256 Hash Dedup: Remove "modified" if contents are actually identical (e.g. metadata-only commit, but same file content, ignoring git tricks)
    const dedupModified: string[] = [];
    for (const f of modified) {
      try {
        const fileHashInfo = await $`git -C ${repoDir} hash-object ${f}`.quiet();
        const newBlobHash = fileHashInfo.stdout.toString().trim();
        // Compare with older blob hash
        const oldFileHashInfo = await $`git -C ${repoDir} ls-tree ${prevHash} ${f}`.quiet();
        const oldLines = oldFileHashInfo.stdout.toString().split(' ');
        if (oldLines.length > 2 && oldLines[2].startsWith(newBlobHash)) {
          // Same blob hash in Git, skipping really unmodified text
          continue;
        }
        dedupModified.push(f);
      } catch (_e: any) {
        dedupModified.push(f); // Keep on fail
      }
    }

    deltas[source.id] = { added, modified: dedupModified, deleted };
    console.log(
      `[${source.id}] Delta: +${added.length} ~${dedupModified.length} -${deleted.length}`
    );
  }

  const deltaPath = join(RAW_DOCS_DIR, 'delta.json');
  writeFileSync(deltaPath, JSON.stringify(deltas, null, 2));
  console.log(`✅ Phase 2 complete. Delta queue saved to ${deltaPath}`);
}

main().catch(console.error);
