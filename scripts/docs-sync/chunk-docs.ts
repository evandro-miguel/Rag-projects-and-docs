/**
 * @module chunk-docs
 * @description Phase 3: Chunk & Process - Split documents into chunks for RAG ingestion.
 *
 * This script processes changed documents identified in Phase 2 by:
 * - Reading document content from synced repositories
 * - Splitting content into chunks using RecursiveCharacterTextSplitter
 * - Computing SHA-256 content hashes for deduplication
 * - Generating ingest payloads for Phase 4
 *
 * **When to run:** Execute after detect-changes.ts (Phase 2) and before ingest-chunks.ts (Phase 4).
 * Requires delta.json from Phase 2 to know which files to process.
 *
 * **Dependencies:**
 * - delta.json from Phase 2 (detect-changes.ts)
 * - sources.json configuration file
 * - @langchain/textsplitters package
 *
 * **Output:** Creates ingest-payload.json for each source in .data/ready-for-rag/{source}/
 *
 * @example
 * // Run Phase 3: Chunk and process documents
 * bun run scripts/docs-sync/chunk-docs.ts
 *
 * @example
 * // Run as part of the full processor workflow
 * bun run scripts/docs-sync/process-docs.ts
 *
 * @see detect-changes.ts - Phase 2: Change detection
 * @see ingest-chunks.ts - Phase 4: Chunk ingestion
 * @see process-docs.ts - Orchestrator for Phases 2-3
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkTextWithContextProfile } from '../../lib/ingest/chunker.js';
import { calculateHash } from '../../lib/shared/hashing.js';

const ROOT_DIR = join(import.meta.dir, '../../');
const RAW_DOCS_DIR = join(ROOT_DIR, '.data', 'raw-docs');
const READY_DOCS_DIR = join(ROOT_DIR, '.data', 'ready-for-rag');

if (!existsSync(READY_DOCS_DIR)) mkdirSync(READY_DOCS_DIR, { recursive: true });

/**
 * Document ready for ingestion into the RAG system.
 */
interface DocToIngest {
  /** Source identifier from sources.json */
  source_id: string;
  /** Original source URL */
  source_url: string;
  /** Unique source path identifier (format: {source_id}/{relative_path}) */
  source_path: string;
  /** Document title extracted from filename or content */
  title: string;
  /** Full document content */
  content: string;
  /** SHA-256 hash of content for change detection */
  content_hash: string;
  /** Array of text chunks with searchableText for retrieval */
  chunks: Array<{ content: string; searchableText: string }>;
}

/**
 * Delta map from Phase 2, tracking changes per source.
 */
interface DeltaMap {
  [sourceId: string]: {
    /** Files added since last sync */
    added: string[];
    /** Files modified since last sync */
    modified: string[];
    /** Files deleted since last sync */
    deleted: string[];
  };
}

/**
 * Main execution function for Phase 3: Document Chunking.
 *
 * For each source with changes:
 * 1. Reads delta.json to identify files to process
 * 2. Splits document content into chunks (512 chars, 64 overlap)
 * 3. Computes content hashes for deduplication
 * 4. Creates ingest payload with upsert and delete operations
 * 5. Saves payload to ingest-payload.json for Phase 4
 *
 * @returns {Promise<void>} Resolves when all sources are processed
 *
 * @throws {Error} Exits with code 1 if delta.json is missing
 *
 * @example
 * // Execute document chunking
 * await main();
 */
async function main() {
  console.log('🚀 Starting Phase 3: Chunk & Process');
  const deltaPath = join(RAW_DOCS_DIR, 'delta.json');
  if (!existsSync(deltaPath)) {
    console.error('❌ No delta.json found. Phase 2 must run first.');
    process.exit(1);
  }

  const { sources } = JSON.parse(readFileSync(join(import.meta.dir, 'sources.json'), 'utf-8'));
  const deltas = JSON.parse(readFileSync(deltaPath, 'utf-8')) as DeltaMap;

  for (const source of sources) {
    if (!deltas[source.id]) continue;

    console.log(`[${source.id}] Processing documents...`);
    const { added, modified, deleted } = deltas[source.id];
    const repoDir = join(RAW_DOCS_DIR, source.id);
    const sourceReadyDir = join(READY_DOCS_DIR, source.id);

    if (!existsSync(sourceReadyDir)) mkdirSync(sourceReadyDir, { recursive: true });

    // Payload for Phase 4
    const ingestPayload = {
      source_id: source.id,
      docsToUpsert: [] as DocToIngest[],
      pathsToDelete: [] as string[],
    };

    // 1. Compute deletes (will remove the entire document from Docs RAG)
    for (const f of deleted) {
      ingestPayload.pathsToDelete.push(`${source.id}/${f}`);
    }

    // 2. Compute adds/mods
    const filesToProcess = Array.from(new Set([...added, ...modified]));
    for (const f of filesToProcess) {
      try {
        const fullPath = join(repoDir, f);
        const content = readFileSync(fullPath, 'utf-8');

        const content_hash = await calculateHash(content);
        const title = f.split('/').pop()?.replace('.mdx', '').replace('.md', '') || f;
        const source_path = `${source.id}/${f}`;
        const chunks = await chunkTextWithContextProfile(
          content,
          { title, sourcePath: source_path },
          {
            docType: 'external',
            chunkSize: 512,
            chunkOverlap: 64,
            sourcePath: fullPath,
          }
        );

        ingestPayload.docsToUpsert.push({
          source_id: source.id,
          source_url: `${source.url.replace('.git', '')}/blob/${source.branch || 'main'}/${f}`,
          source_path,
          title,
          content,
          content_hash,
          chunks: chunks.map((chunk) => ({
            content: chunk.content,
            searchableText: chunk.searchableText,
          })),
        });
      } catch (e: any) {
        console.error(`[${source.id}] ❌ Failed to chunk file ${f}: ${e.message}`);
      }
    }

    const outJsonPath = join(sourceReadyDir, 'ingest-payload.json');
    writeFileSync(outJsonPath, JSON.stringify(ingestPayload, null, 2));
    console.log(
      `✅ [${source.id}] ${ingestPayload.docsToUpsert.length} docs to upsert, ${deleted.length} paths to delete.`
    );
  }

  console.log('✅ Phase 3 complete.');
}

main().catch(console.error);
