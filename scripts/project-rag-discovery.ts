/**
 * @module project-rag-discovery
 * @description Strategic queries to discover Project RAG codebase structure.
 *
 * This script performs targeted searches to understand:
 * - Main modules and their responsibilities
 * - Critical dependencies
 * - Complexity hotspots
 * - Public APIs
 * - Code patterns
 */

import dotenv from 'dotenv';
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
  type ProjectRagPostgresProject,
  type ProjectRagPostgresSearchResult,
  searchProjectRagPostgresChunks,
} from './project-rag/store.js';

dotenv.config({ path: '.env.local' });

const PROJECT_SLUG =
  process.env.PROJECT_RAG_PROJECT_SLUG ??
  createProjectSlug(inferProjectNameFromRootPath(process.cwd()));
const POSTGRES_CONFIG = resolveProjectRagPostgresConfigWithLocalDefault();
const EMBEDDING_CONFIG = resolveProjectRagPostgresEmbeddingConfig();
const sql = createProjectRagPostgresSql(POSTGRES_CONFIG);

let resolvedProject: ProjectRagPostgresProject | null = null;

interface DiscoveryQuery {
  id: string;
  query: string;
  description: string;
  limit?: number;
}

const QUERIES: DiscoveryQuery[] = [
  {
    id: 'export-const',
    query: 'export const',
    description: 'Public constants and configurations',
    limit: 20,
  },
  {
    id: 'export-function',
    query: 'export function',
    description: 'Exported utility and helper functions',
    limit: 20,
  },
  {
    id: 'schema-definition',
    query: 'defineSchema defineTable',
    description: 'Database schema definitions',
    limit: 15,
  },
  {
    id: 'index-definition',
    query: '.index(',
    description: 'Database index definitions',
    limit: 15,
  },
  {
    id: 'search-implementation',
    query: 'search hybrid vector BM25',
    description: 'Search implementation code',
    limit: 20,
  },
  {
    id: 'api-definition',
    query: 'http.router',
    description: 'HTTP API route definitions',
    limit: 10,
  },
  {
    id: 'handler-implementation',
    query: 'handler MCP tool',
    description: 'MCP tool handlers',
    limit: 20,
  },
  {
    id: 'class-definition',
    query: 'export class',
    description: 'Class definitions and OOP patterns',
    limit: 15,
  },
  {
    id: 'interface-type',
    query: 'export interface export type',
    description: 'Type and interface definitions',
    limit: 20,
  },
  {
    id: 'dependency-import',
    query: 'import { } from',
    description: 'Module import patterns and dependencies',
    limit: 20,
  },
  {
    id: 'error-handling',
    query: 'try catch throw new Error',
    description: 'Error handling patterns',
    limit: 15,
  },
  {
    id: 'async-await',
    query: 'async await Promise',
    description: 'Async patterns and Promise handling',
    limit: 15,
  },
];

interface SearchResult {
  file: string;
  line: number;
  content: string;
  score?: number;
}

interface QueryResult {
  queryId: string;
  description: string;
  resultCount: number;
  uniqueFiles: number;
  files: string[];
  topResults: SearchResult[];
}

/**
 * Search Project RAG for a query.
 */
async function searchProjectCode(query: string, limit = 20): Promise<SearchResult[]> {
  try {
    if (!resolvedProject) {
      throw new Error(`Project "${PROJECT_SLUG}" is not resolved`);
    }

    const [queryEmbedding] = await fetchProjectRagPostgresEmbeddings(EMBEDDING_CONFIG, [
      `Instruct: Given a code search query, retrieve relevant repository chunks.\nQuery: ${query}`,
    ]);
    const result = await searchProjectRagPostgresChunks(sql, resolvedProject.id, {
      query,
      queryEmbedding,
      embeddingModel: EMBEDDING_CONFIG.model,
      embeddingProvider: EMBEDDING_CONFIG.provider,
      embeddingDimensions: EMBEDDING_CONFIG.dimensions,
      embeddingProfileHash: EMBEDDING_CONFIG.profileHash,
      limit,
    });

    return result.map((r: ProjectRagPostgresSearchResult) => ({
      file: r.sourcePath,
      line: r.startLine ?? 0,
      content: r.content,
      score: r.score,
    }));
  } catch (error) {
    console.error(`Error searching for "${query}" (hybrid):`, error);
    return [];
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

/**
 * Run a single discovery query.
 */
async function runDiscoveryQuery(q: DiscoveryQuery): Promise<QueryResult> {
  console.log(`\n[${q.id}] ${q.description}`);
  console.log(`  Query: "${q.query}" (mode: hybrid, limit: ${q.limit})`);

  const results = await searchProjectCode(q.query, q.limit);

  const uniqueFiles = [...new Set(results.map((r) => r.file))];

  console.log(`  ✓ Found ${results.length} matches in ${uniqueFiles.length} unique files`);

  return {
    queryId: q.id,
    description: q.description,
    resultCount: results.length,
    uniqueFiles: uniqueFiles.length,
    files: uniqueFiles,
    topResults: results.slice(0, 5),
  };
}

/**
 * Analyze results to extract patterns.
 */
function analyzePatterns(results: QueryResult[]) {
  const fileFrequency = new Map<string, number>();
  const allFiles = new Set<string>();

  for (const result of results) {
    for (const file of result.files) {
      allFiles.add(file);
      fileFrequency.set(file, (fileFrequency.get(file) || 0) + 1);
    }
  }

  // Sort by frequency
  const sortedFiles = [...fileFrequency.entries()].sort((a, b) => b[1] - a[1]);

  console.log('\n\n=== ANALYSIS ===\n');
  console.log(`Total unique files discovered: ${allFiles.size}`);

  console.log('\n📊 Top files by appearance across queries:');
  sortedFiles.slice(0, 20).forEach(([file, count], i) => {
    console.log(`  ${i + 1}. ${file} (${count} queries)`);
  });

  return {
    totalUniqueFiles: allFiles.size,
    topFiles: sortedFiles.slice(0, 20),
    allFiles: [...allFiles],
  };
}

/**
 * Main discovery workflow.
 */
async function main() {
  resolvedProject = await resolveProject();

  console.log('🚀 Project RAG Discovery - Strategic Codebase Analysis (Postgres)\n');
  console.log(`Project slug: ${PROJECT_SLUG}`);
  console.log(`Project ID: ${resolvedProject.id}`);
  console.log(`Embedding model: ${EMBEDDING_CONFIG.model}`);
  console.log(`Queries to run: ${QUERIES.length}`);

  const results: QueryResult[] = [];

  for (const query of QUERIES) {
    const result = await runDiscoveryQuery(query);
    results.push(result);
  }

  // Analyze patterns
  const analysis = analyzePatterns(results);

  // Write summary to file
  const summary = {
    timestamp: new Date().toISOString(),
    projectId: resolvedProject.id,
    projectSlug: PROJECT_SLUG,
    queriesRun: QUERIES.length,
    results: results.map((r) => ({
      queryId: r.queryId,
      description: r.description,
      resultCount: r.resultCount,
      uniqueFiles: r.uniqueFiles,
    })),
    analysis: {
      totalUniqueFiles: analysis.totalUniqueFiles,
      topFiles: analysis.topFiles,
    },
  };

  console.log('\n\n📄 Summary:');
  console.log(JSON.stringify(summary, null, 2));

  // Write to file for later use
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outputPath = path.join(process.cwd(), '.data/map/project-rag-discovery.json');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));

  console.log(`\n💾 Results saved to: ${outputPath}`);
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
