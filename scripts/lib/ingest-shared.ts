/**
 * @module ingest-shared
 * @description Shared project-ingestion validation helpers.
 */

import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { SCRIPT_CONFIG } from './config.js';
import { shouldIgnorePath } from './file-helpers.js';
import { getSensitivePatterns } from './sensitive-patterns.js';

const RETIRED_INGEST_MESSAGE =
  'Convex ingest-shared runtime is retired; use bun run ingest-project for Postgres Project RAG ingestion.';

export interface IngestResult {
  success: boolean;
  sourcePath: string;
  skipped?: boolean;
  error?: string;
  chunksCount?: number;
}

export function validateFile(
  filePath: string,
  projectRoot: string
): { valid: true } | { valid: false; error: string } {
  try {
    const resolvedFile = resolve(filePath);
    const resolvedRoot = resolve(projectRoot);

    if (!resolvedFile.startsWith(resolvedRoot)) {
      return { valid: false, error: 'File path outside project source directory' };
    }

    const stats = statSync(resolvedFile);
    if (stats.size > SCRIPT_CONFIG.MAX_FILE_SIZE_BYTES) {
      return { valid: false, error: `File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB)` };
    }

    const filename = basename(resolvedFile);
    const sensitivePatterns = getSensitivePatterns();
    if (sensitivePatterns.some((rx) => rx.test(filename) || rx.test(resolvedFile))) {
      return { valid: false, error: 'Sensitive file blocked' };
    }

    if (shouldIgnorePath(resolvedFile)) {
      return { valid: false, error: 'File path in ignore list (helper)' };
    }

    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      error: `Validation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function ingestProjectFile(
  _filePath: string,
  _client: unknown,
  _options: { force?: boolean } = {}
): Promise<IngestResult> {
  // ponytail: no compatibility shim; package aliases already route to Postgres ingest.
  throw new Error(RETIRED_INGEST_MESSAGE);
}

export async function ingestFullProject(
  _client: unknown,
  _limit: unknown
): Promise<{
  results: IngestResult[];
  summary: { synced: number; skipped: number; failed: number };
}> {
  throw new Error(RETIRED_INGEST_MESSAGE);
}
