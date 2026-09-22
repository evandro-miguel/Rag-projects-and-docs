/**
 * Project RAG Analysis Script
 * Uses Project RAG Postgres search and symbol lookup helpers.
 */

import { createProjectSlug, inferProjectNameFromRootPath } from '../lib/shared/project-registry.js';
import { resolveProjectRagPostgresConfigWithLocalDefault } from './project-rag/config.js';
import {
  fetchProjectRagPostgresEmbeddings,
  resolveProjectRagPostgresEmbeddingConfig,
} from './project-rag/embeddings.js';
import {
  closeProjectRagPostgresSql,
  createProjectRagPostgresSql,
  findProjectRagPostgresProject,
  findProjectRagPostgresSymbols,
  type ProjectRagPostgresProject,
  type ProjectRagPostgresSearchResult,
  type ProjectRagPostgresSymbol,
  searchProjectRagPostgresChunks,
} from './project-rag/store.js';

const PROJECT_SLUG =
  process.env.PROJECT_RAG_PROJECT_SLUG ??
  createProjectSlug(inferProjectNameFromRootPath(process.cwd()));
const POSTGRES_CONFIG = resolveProjectRagPostgresConfigWithLocalDefault();
const EMBEDDING_CONFIG = resolveProjectRagPostgresEmbeddingConfig();
const sql = createProjectRagPostgresSql(POSTGRES_CONFIG);

let resolvedProject: ProjectRagPostgresProject | null = null;

// ============================================================================
// Project RAG Tool: searchProjectCode
// ============================================================================
async function searchProjectCode(query: string, limit = 20) {
  console.log(`\n🔍 [searchProjectCode] Query: "${query}" (hybrid)`);
  console.log('─'.repeat(70));

  try {
    if (!resolvedProject) {
      throw new Error(`Project "${PROJECT_SLUG}" is not resolved`);
    }

    const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(EMBEDDING_CONFIG, [
      `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${query}`,
    ]);
    const results = await searchProjectRagPostgresChunks(sql, resolvedProject.id, {
      query,
      queryEmbedding,
      embeddingModel: EMBEDDING_CONFIG.model,
      embeddingProvider: EMBEDDING_CONFIG.provider,
      embeddingDimensions: EMBEDDING_CONFIG.dimensions,
      embeddingProfileHash: EMBEDDING_CONFIG.profileHash,
      limit,
    });

    if (!results?.length) {
      console.log('❌ No results found');
      return [];
    }

    console.log(`✅ Found ${results.length} results:\n`);

    for (const r of results.slice(0, 8)) {
      const preview = r.content.slice(0, 100).replace(/\n/g, ' ');
      console.log(`📄 ${r.sourcePath}:${r.startLine ?? '?'}`);
      console.log(`   Score: ${r.score?.toFixed(4) ?? 'N/A'}`);
      console.log(`   Preview: ${preview}...`);
      console.log();
    }

    return results;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ERROR: ${msg}`);
    return [] as ProjectRagPostgresSearchResult[];
  }
}

async function resolveProject(): Promise<ProjectRagPostgresProject> {
  const project = await findProjectRagPostgresProject(sql, PROJECT_SLUG);
  if (!project) {
    throw new Error(
      `Project slug "${PROJECT_SLUG}" not found. Run: bun run register-project --root $(pwd)`
    );
  }

  return project;
}

// ============================================================================
// Project RAG Tool: findSymbolByName
// ============================================================================
async function findSymbolByName(symbolName: string) {
  console.log(`\n🔍 [findSymbolByName] Symbol: "${symbolName}"`);
  console.log('─'.repeat(70));

  try {
    if (!resolvedProject) {
      throw new Error(`Project "${PROJECT_SLUG}" is not resolved`);
    }

    const results = await findProjectRagPostgresSymbols(sql, resolvedProject.id, {
      name: symbolName,
      limit: 20,
    });
    const definitions = results.definitions;

    if (!definitions.length) {
      console.log('❌ Symbol not found');
      return null;
    }

    console.log(`✅ Found ${definitions.length} symbol(s):\n`);

    for (const s of definitions) {
      console.log(`📝 ${s.name} (${s.symbolType})`);
      console.log(`   File: ${s.sourcePath}:${s.startLine ?? '?'}`);
      console.log();
    }

    return definitions;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ERROR: ${msg}`);
    return null as ProjectRagPostgresSymbol[] | null;
  }
}

// ============================================================================
// Main Analysis
// ============================================================================
async function main() {
  resolvedProject = await resolveProject();

  console.log('═'.repeat(70));
  console.log('PROJECT RAG ANALYSIS - Using Postgres');
  console.log('═'.repeat(70));
  console.log(`Project slug: ${PROJECT_SLUG}`);
  console.log(`Project ID: ${resolvedProject.id}`);
  console.log(`Embedding model: ${EMBEDDING_CONFIG.model}`);
  console.log('═'.repeat(70));

  // 1. Search for error handling patterns
  console.log('\n\n━━━ 1. ERROR HANDLING PATTERNS ━━━');
  await searchProjectCode('catch error try exception', 15);

  // 2. Search for security issues
  console.log('\n\n━━━ 2. SECURITY PATTERNS ━━━');
  await searchProjectCode('password secret api key token', 15);
  await searchProjectCode('eval Function constructor', 10);

  // 3. Search for code quality issues
  console.log('\n\n━━━ 3. CODE QUALITY (TODO/FIXME) ━━━');
  await searchProjectCode('TODO FIXME HACK XXX', 20);

  // 4. Search for type safety issues
  console.log('\n\n━━━ 4. TYPE SAFETY ISSUES ━━━');
  await searchProjectCode(': any', 15);
  await searchProjectCode('@ts-ignore', 15);
  await searchProjectCode('as unknown', 15);

  // 5. Find specific symbols
  console.log('\n\n━━━ 5. SYMBOL LOOKUP ━━━');
  await findSymbolByName('handleError');
  await findSymbolByName('validateInput');
  await findSymbolByName('authenticate');
  await findSymbolByName('sanitize');

  // 6. Search for empty catch blocks
  console.log('\n\n━━━ 6. EMPTY CATCH BLOCKS ━━━');
  await searchProjectCode('} catch {', 10);

  // 7. Search for potential SQL injection
  console.log('\n\n━━━ 7. SQL INJECTION RISKS ━━━');
  await searchProjectCode('sql query string concatenation', 10);

  console.log('\n═'.repeat(70));
  console.log('ANALYSIS COMPLETE');
  console.log('═'.repeat(70));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (POSTGRES_CONFIG.database.url) {
      await closeProjectRagPostgresSql(POSTGRES_CONFIG.database.url);
    }
  });
