import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/**
 * Stable identity of the canonical Docs RAG chunker. Any behavior change that
 * can alter chunk boundaries MUST bump this id so the processing profile hash
 * changes and cached derived data is invalidated.
 */
export const DOCS_RAG_CHUNKER_ID = 'docs-rag-canonical-chunker-v1';

export interface DocsRagChunkContext {
  readonly title?: string;
  readonly sourcePath?: string;
  readonly section?: string;
}

export interface DocsRagChunkOptions {
  readonly docType?: string;
  readonly chunkSize?: number;
  readonly chunkOverlap?: number;
  readonly sourcePath?: string;
}

export interface DocsRagChunkWithContext {
  readonly content: string;
  readonly searchableText: string;
  readonly heading?: string;
  readonly section?: string;
}

/** Default canonical chunk parameters shared by every Docs RAG caller. */
export const DOCS_RAG_DEFAULT_CHUNK_SIZE = 1_000;
export const DOCS_RAG_DEFAULT_CHUNK_OVERLAP = 50;

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Effective Docs RAG chunk parameters. Both corpus ingest and external sync
 * must use this resolver so `CHUNK_SIZE`/`CHUNK_OVERLAP` cannot stamp two
 * processing identities onto the same corpus.
 */
export function resolveDocsRagChunkConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
} {
  return {
    chunkSize: Math.max(1, parseNonNegativeInt(env.CHUNK_SIZE, DOCS_RAG_DEFAULT_CHUNK_SIZE)),
    chunkOverlap: parseNonNegativeInt(env.CHUNK_OVERLAP, DOCS_RAG_DEFAULT_CHUNK_OVERLAP),
  };
}

function generateContextHeader(context: DocsRagChunkContext): string {
  return [context.title, context.sourcePath, context.section]
    .filter((value): value is string => Boolean(value))
    .map((value) => `[${value}]`)
    .join(' > ');
}

function splitBySemanticBoundaries(text: string): string[] {
  const parts = text.split(/^(#{1,2}\s+.*)$/gm);
  const sections: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]?.trim() ?? '';
    if (!part) continue;
    if (/^#{1,6}\s+/.test(part)) {
      sections.push(`${part}\n${parts[i + 1]?.trim() ?? ''}`);
      i++;
    } else {
      sections.push(part);
    }
  }
  return sections.filter((section) => section.trim().length > 0);
}

function firstSectionHeading(section: string): string | undefined {
  return /^#{1,6}\s+(.+)$/mu.exec(section)?.[1]?.trim();
}

/**
 * The single canonical chunker used by every Docs RAG ingestion surface
 * (external sync refinement pipeline and direct corpus ingest). Chunk
 * boundaries depend only on the input text and the explicit options.
 *
 * Retrieved document content — including anything that looks like
 * instructions, system prompts, or metadata markers — is treated strictly as
 * untrusted data: it is never interpreted, executed, or allowed to influence
 * anything beyond the produced chunk text.
 */
export async function chunkDocsRagTextWithContext(
  text: string,
  context: DocsRagChunkContext,
  options: DocsRagChunkOptions = {}
): Promise<DocsRagChunkWithContext[]> {
  const chunkSize = options.chunkSize ?? DOCS_RAG_DEFAULT_CHUNK_SIZE;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: options.chunkOverlap ?? DOCS_RAG_DEFAULT_CHUNK_OVERLAP,
    separators: ['\n\n', '\n', ' ', ''],
    keepSeparator: true,
  });
  interface CanonicalSection {
    readonly body: string;
    readonly heading?: string;
  }
  const sections: CanonicalSection[] = splitBySemanticBoundaries(text).map((body) => ({
    body,
    heading: firstSectionHeading(body),
  }));
  const chunks: Array<{ content: string; section?: string; heading?: string }> = [];
  for (const section of sections) {
    if (section.body.length <= chunkSize) {
      chunks.push({
        content: section.body.trim(),
        section: section.heading,
        heading: section.heading,
      });
      continue;
    }
    chunks.push(
      ...(await splitter.createDocuments([section.body]))
        .map((doc) => ({
          content: doc.pageContent.trim(),
          section: section.heading,
          heading: section.heading,
        }))
        .filter((chunk) => chunk.content.length > 0)
    );
  }
  const fullHeader = generateContextHeader(context);
  const docHeader = generateContextHeader({
    title: context.title,
    sourcePath: context.sourcePath,
  });

  return chunks.map((chunk, index) => {
    const header = index === 0 ? fullHeader : docHeader;
    return {
      content: chunk.content,
      searchableText: header ? `${header} ${chunk.content}` : chunk.content,
      ...(chunk.section ? { section: chunk.section } : {}),
      ...(chunk.heading ? { heading: chunk.heading } : {}),
    };
  });
}
