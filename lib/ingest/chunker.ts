'use node';
/**
 * @module ingest/chunker
 * @description Text chunking utilities with multiple chunking profiles.
 *
 * This module provides text splitting functionality with three chunking strategies:
 *
 * **Profiles:**
 * - `fixed`: Fixed-size chunks using RecursiveCharacterTextSplitter
 * - `structure`: Code-aware splitting preserving classes, functions, headings
 * - `semantic`: Split by semantic boundaries (paragraphs, sections)
 *
 * **Features:**
 * - Contextual Chunk Headers (CCH) for improved retrieval (+15-25% nDCG)
 * - Auto-selection based on docType or content analysis
 * - Manual override capability
 *
 * @example
 * // Basic usage with auto-profile selection
 * import { chunkTextWithProfile } from './chunker.js';
 * const chunks = await chunkTextWithProfile(content, { docType: 'project' });
 *
 * @example
 * // With explicit profile override
 * const chunks = await chunkTextWithProfile(content, { profile: 'structure' });
 *
 * @example
 * // With Contextual Chunk Headers (CCH)
 * import { chunkTextWithContext } from './chunker.js';
 * const chunks = await chunkTextWithContext(
 *   largeDocument,
 *   { title: 'Getting Started', sourcePath: 'docs/intro.md', section: 'Installation' },
 *   500,
 *   50
 * );
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import {
  type ChunkingProfile,
  type ChunkingProfileConfig,
  type DocType,
  detectProfile,
  getChunkingProfile,
  getProfileConfig,
} from './config.js';

// NOTE: symbol-parser uses web-tree-sitter which requires Node.js runtime.
// For non-Node runtimes, symbol parsing is not available.
// The actual symbol parsing is available in scripts that run in Node.js.
//
const _SYMBOL_PARSER_AVAILABLE = false;

/**
 * Document context for Contextual Chunk Headers (CCH).
 * Used to prefix searchableText with document metadata for improved retrieval.
 */
export interface DocumentContext {
  /** Document title (e.g., "Getting Started Guide") */
  title?: string;
  /** Source path (e.g., "docs/api/auth.md") */
  sourcePath?: string;
  /** Current section/heading (e.g., "Authentication") */
  section?: string;
}

/**
 * Result from chunking with CCH support.
 * - content: Clean text for LLM consumption
 * - searchableText: Text used for search (includes CCH prefix)
 * - startLine/endLine: 1-based line range in the original source (when known)
 */
export interface ChunkWithContext {
  content: string;
  searchableText: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Locate successive chunk texts in the original source and derive 1-based
 * line ranges. Uses a forward cursor so overlapping chunks still map stably.
 */
export function lineRangeForChunkContent(
  fullText: string,
  chunkContent: string,
  searchFrom = 0
): { readonly startLine?: number; readonly endLine?: number; readonly nextSearchFrom: number } {
  if (!chunkContent) {
    return { nextSearchFrom: searchFrom };
  }
  let idx = fullText.indexOf(chunkContent, searchFrom);
  if (idx < 0 && searchFrom > 0) {
    idx = fullText.indexOf(chunkContent);
  }
  if (idx < 0) {
    return { nextSearchFrom: searchFrom };
  }
  const startLine = fullText.slice(0, idx).split('\n').length;
  const lineCount = chunkContent.split('\n').length;
  return {
    startLine,
    endLine: startLine + lineCount - 1,
    // Advance at least one char so identical consecutive chunks still progress.
    nextSearchFrom: idx + Math.max(1, Math.floor(chunkContent.length / 2)),
  };
}

/**
 * Options for chunkTextWithProfile function.
 */
export interface ChunkOptions {
  /** Document type for auto-profile selection */
  docType?: DocType;
  /** Explicit profile override (ignores docType if provided) */
  profile?: ChunkingProfile;
  /** Custom chunk size override */
  chunkSize?: number;
  /** Custom chunk overlap override */
  chunkOverlap?: number;
  /** File extension for symbol-aware chunking (e.g., '.ts', '.py') */
  fileExt?: string;
  /** Source path for extension detection */
  sourcePath?: string;
}

// Re-export profile types for convenience
export type { ChunkingProfile, ChunkingProfileConfig, DocType } from './config.js';

/**
 * Configuration for chunkText function.
 * Provides a simple interface for chunking with optional overrides.
 */
export interface ChunkingConfig {
  /** The chunking profile to use ('fixed', 'structure', or 'semantic') */
  profile: ChunkingProfile;
  /** Optional chunk size override (uses profile default if not specified) */
  chunkSize?: number;
  /** Optional overlap override (uses profile default if not specified) */
  overlap?: number;
}

/**
 * Generate contextual chunk header from document context.
 *
 * @param context - Document context (title, sourcePath, section)
 * @returns Formatted header like "[Getting Started Guide] > [API Reference] > [Authentication]"
 */
export function generateContextHeader(context: DocumentContext): string {
  const parts: string[] = [];

  if (context.title) {
    parts.push(`[${context.title}]`);
  }
  if (context.sourcePath) {
    parts.push(`[${context.sourcePath}]`);
  }
  if (context.section) {
    parts.push(`[${context.section}]`);
  }

  return parts.join(' > ');
}

// ============================================================================
// CHUNKING STRATEGIES
// ============================================================================

/**
 * Fixed-size chunking strategy.
 * Uses RecursiveCharacterTextSplitter with standard separators.
 *
 * @param text - Text to chunk
 * @param config - Profile configuration
 * @returns Array of text chunks
 */
async function chunkFixed(text: string, config: ChunkingProfileConfig): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    separators: config.separators as string[],
    keepSeparator: config.keepSeparator,
  });

  const documents = await splitter.createDocuments([text]);
  return documents
    .map((doc) => doc.pageContent)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Structure-aware chunking strategy.
 * Preserves code structures (classes, functions, code blocks).
 *
 * @param text - Text to chunk
 * @param config - Profile configuration
 * @returns Array of text chunks
 */
async function chunkStructure(text: string, config: ChunkingProfileConfig): Promise<string[]> {
  // If code block preservation is enabled, extract and protect them
  const { protectedText, codeBlocks } = protectCodeBlocks(text);

  // Use custom separators for code structure
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    separators: config.separators as string[],
    keepSeparator: config.keepSeparator,
  });

  const documents = await splitter.createDocuments([protectedText]);
  let chunks = documents
    .map((doc) => doc.pageContent)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  // Restore code blocks in chunks
  if (config.preserveCodeBlocks && codeBlocks.size > 0) {
    chunks = restoreCodeBlocks(chunks, codeBlocks);
  }

  return chunks;
}

/**
 * Semantic chunking strategy.
 * Splits on semantic boundaries (paragraphs, sections).
 *
 * @param text - Text to chunk
 * @param config - Profile configuration
 * @returns Array of text chunks
 */
async function chunkSemantic(text: string, config: ChunkingProfileConfig): Promise<string[]> {
  // Split by major semantic boundaries first
  const sections = splitBySemanticBoundaries(text, config);

  // Further chunk each section if needed
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    separators: ['\n\n', '\n', ' ', ''],
    keepSeparator: config.keepSeparator,
  });

  const allChunks: string[] = [];

  for (const section of sections) {
    if (section.length <= config.chunkSize) {
      // Section fits in one chunk
      const trimmed = section.trim();
      if (trimmed.length > 0) {
        allChunks.push(trimmed);
      }
    } else {
      // Section needs further splitting
      const documents = await splitter.createDocuments([section]);
      const chunks = documents
        .map((doc) => doc.pageContent)
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      allChunks.push(...chunks);
    }
  }

  return allChunks;
}

/**
 * Symbol-aware chunking strategy.
 * Uses tree-sitter to split code at symbol boundaries (functions, classes).
 * Falls back to structure-based chunking for unsupported languages.
 *
 * @param text - Text to chunk
 * @param config - Profile configuration
 * @param ext - File extension for language detection
 * @returns Array of text chunks
 */
async function chunkSymbols(
  text: string,
  config: ChunkingProfileConfig,
  ext: string
): Promise<string[]> {
  // Symbol parser requires Node.js runtime (web-tree-sitter).
  // Use structure-based chunking as replacement for symbol-based chunking
  console.warn(
    `[chunker] Symbol parsing unavailable in this runtime, using structure chunking for '${ext}'`
  );
  return chunkStructure(text, config);
}

/**
 * Protect code blocks by replacing them with placeholders.
 * This prevents code blocks from being split mid-block.
 */
function protectCodeBlocks(text: string): {
  protectedText: string;
  codeBlocks: Map<string, string>;
} {
  const codeBlocks = new Map<string, string>();
  let protectedText = text;
  let counter = 0;

  // Match fenced code blocks
  const codeBlockRegex = /```[\s\S]*?```/g;
  protectedText = protectedText.replace(codeBlockRegex, (match) => {
    const placeholder = `__CODE_BLOCK_${counter}__`;
    codeBlocks.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Match indented code blocks (4 spaces)
  const indentedCodeRegex = /^( {4}[^\n]*(\n {4}[^\n]*)*)/gm;
  protectedText = protectedText.replace(indentedCodeRegex, (match) => {
    const placeholder = `__CODE_BLOCK_${counter}__`;
    codeBlocks.set(placeholder, match);
    counter++;
    return placeholder;
  });

  return { protectedText, codeBlocks };
}

/**
 * Restore protected code blocks in chunks.
 */
function restoreCodeBlocks(chunks: string[], codeBlocks: Map<string, string>): string[] {
  const entries = Array.from(codeBlocks.entries());
  return chunks.map((chunk) => {
    let restored = chunk;
    for (const [placeholder, code] of entries) {
      restored = restored.replace(placeholder, code);
    }
    return restored;
  });
}

/**
 * Split text by semantic boundaries (headings, horizontal rules).
 */
function splitBySemanticBoundaries(text: string, config: ChunkingProfileConfig): string[] {
  const sections: string[] = [];

  // Split by headings if enabled
  if (config.splitOnHeadings && config.maxHeadingLevel > 0) {
    const headingRegex = new RegExp(`^(#{1,${config.maxHeadingLevel}}\\s+.*)$`, 'gm');
    const parts = text.split(headingRegex);

    // Combine heading with following content
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part.length === 0) continue;

      // If this part is a heading, combine with next content
      if (part.match(/^#{1,6}\s+/)) {
        const nextContent = parts[i + 1]?.trim() || '';
        sections.push(`${part}\n${nextContent}`);
        i++; // Skip next part as it's already included
      } else {
        sections.push(part);
      }
    }
  } else {
    // Split by paragraph breaks
    sections.push(...text.split(/\n\n+/));
  }

  return sections.filter((s) => s.trim().length > 0);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Detect file extension from source path.
 * Extracts the extension from a file path (e.g., 'src/utils/foo.ts' -> '.ts')
 */
function detectExtension(sourcePath: string): string {
  if (!sourcePath) return '.txt';
  const match = sourcePath.match(/\.([^./\\]+)$/);
  return match ? `.${match[1]}` : '.txt';
}

/**
 * Split text into chunks using the appropriate profile.
 *
 * This is the main entry point for chunking. It:
 * 1. Determines the best profile (explicit, by docType, or content detection)
 * 2. Applies the chunking strategy
 * 3. Returns clean text chunks
 *
 * @param text - The input text to chunk
 * @param options - Chunking options (docType, profile, chunkSize, chunkOverlap)
 * @returns Promise resolving to an array of text chunks
 *
 * @example
 * // Auto-select based on docType
 * const chunks = await chunkTextWithProfile(content, { docType: 'project' });
 *
 * @example
 * // Explicit profile
 * const chunks = await chunkTextWithProfile(content, { profile: 'semantic' });
 */
export async function chunkTextWithProfile(
  text: string,
  options: ChunkOptions = {}
): Promise<string[]> {
  // Determine profile
  let profile: ChunkingProfile;
  if (options.profile) {
    profile = options.profile;
  } else if (options.docType) {
    profile = getChunkingProfile(options.docType);
  } else {
    profile = detectProfile(text);
  }

  // Get profile config
  const config = { ...getProfileConfig(profile) };

  // Apply overrides
  if (options.chunkSize !== undefined) {
    config.chunkSize = options.chunkSize;
  }
  if (options.chunkOverlap !== undefined) {
    config.chunkOverlap = options.chunkOverlap;
  }

  // Apply the appropriate chunking strategy
  if (profile === 'structure') {
    return chunkStructure(text, config);
  }
  if (profile === 'semantic') {
    return chunkSemantic(text, config);
  }
  if (profile === 'symbols') {
    // Extract file extension from options or detect from source path
    const ext = options.fileExt || detectExtension(options.sourcePath || '');
    return chunkSymbols(text, config, ext);
  }
  return chunkFixed(text, config);
}

/**
 * Split text into overlapping chunks using LangChain's RecursiveCharacterTextSplitter.
 *
 * The splitter uses a hierarchical approach, attempting to split at natural boundaries:
 * 1. Paragraph breaks (\n\n)
 * 2. Line breaks (\n)
 * 3. Word boundaries (spaces)
 * 4. Character level (if necessary)
 *
 * This ensures chunks maintain semantic coherence while fitting size constraints.
 *
 * @param text - The input text to chunk. Should be plain text or markdown.
 * @param chunkSizeOrConfig - Maximum size of each chunk in characters (default: 500), OR a ChunkingConfig object
 * @param chunkOverlap - Number of characters to overlap between consecutive chunks.
 *                       Default: 50. Helps maintain context across chunk boundaries.
 *
 * @returns Promise resolving to an array of text chunks OR ChunkWithContext objects depending on config type.
 *          Each chunk is trimmed and empty chunks are filtered out.
 *
 * @example
 * // Split a document with default settings (returns string[])
 * const chunks = await chunkText(documentContent);
 *
 * @example
 * // Custom chunk size for finer granularity (returns string[])
 * const chunks = await chunkText(documentContent, 256, 32);
 *
 * @example
 * // Using ChunkingConfig (returns ChunkWithContext[])
 * const chunks = await chunkText(documentContent, { profile: 'fixed' });
 *
 * @example
 * // Using ChunkingConfig with custom size (returns ChunkWithContext[])
 * const chunks = await chunkText(codeContent, { profile: 'structure', chunkSize: 800 });
 */
export async function chunkText(
  text: string,
  chunkSizeOrConfig: number | ChunkingConfig = 500,
  chunkOverlap = 50
): Promise<string[] | ChunkWithContext[]> {
  // Handle ChunkingConfig overload
  if (typeof chunkSizeOrConfig === 'object' && chunkSizeOrConfig !== null) {
    const config = chunkSizeOrConfig as ChunkingConfig;
    const profileConfig = getProfileConfig(config.profile);

    // Apply overrides if provided
    const chunkSize = config.chunkSize ?? profileConfig.chunkSize;
    const overlap = config.overlap ?? profileConfig.chunkOverlap;

    // Use chunkTextWithProfile to get the text chunks
    const chunks = await chunkTextWithProfile(text, {
      profile: config.profile,
      chunkSize,
      chunkOverlap: overlap,
    });

    // Return chunks with searchableText (same as content)
    return chunks.map((chunk) => ({
      content: chunk,
      searchableText: chunk,
    }));
  }

  // Original signature: chunkText(text, chunkSize, chunkOverlap)
  const chunkSize = chunkSizeOrConfig;
  // Use fixed profile with custom size parameters
  return chunkTextWithProfile(text, {
    profile: 'fixed',
    chunkSize,
    chunkOverlap,
  });
}

/**
 * Split text into chunks with Contextual Chunk Headers (CCH).
 *
 * This function splits text like chunkText() but returns chunks with:
 * - content: Clean text for LLM consumption
 * - searchableText: Text with CCH prefix for search (e.g., "[Doc] > [Source] > [Section]")
 *
 * The CCH pattern improves retrieval relevance by 15-25% nDCG by providing
 * document context directly in the searchable text.
 *
 * @param text - The input text to chunk. Should be plain text or markdown.
 * @param context - Document context (title, sourcePath, section) for CCH
 * @param chunkSize - Maximum size of each chunk in characters. Default: 500.
 * @param chunkOverlap - Number of characters to overlap between consecutive chunks. Default: 50.
 *
 * @returns Promise resolving to an array of chunks with content and searchableText.
 *
 * @example
 * // Split with full context
 * const chunks = await chunkTextWithContext(
 *   documentContent,
 *   { title: 'Getting Started Guide', sourcePath: 'docs/api.md', section: 'Authentication' },
 *   500,
 *   50
 * );
 * // Returns: [{ content: '...', searchableText: '[Getting Started Guide] > [docs/api.md] > [Authentication] ...' }]
 */
export async function chunkTextWithContext(
  text: string,
  context: DocumentContext,
  chunkSize = 500,
  chunkOverlap = 50
): Promise<ChunkWithContext[]> {
  // First chunk gets full context, subsequent chunks get doc-level context only
  const headerBase = generateContextHeader({
    title: context.title,
    sourcePath: context.sourcePath,
  });

  // Use fixed profile for backward compatibility
  const chunks = await chunkTextWithProfile(text, {
    profile: 'fixed',
    chunkSize,
    chunkOverlap,
  });

  // For first chunk, include section; for others, just doc-level context
  const fullHeader = generateContextHeader(context);
  const docOnlyHeader = headerBase;

  return chunks.map((chunk, index) => {
    const header = index === 0 ? fullHeader : docOnlyHeader;
    return {
      content: chunk,
      searchableText: `${header} ${chunk}`,
    };
  });
}

/**
 * Split text into chunks with CCH and profile support.
 *
 * Combines the power of chunking profiles with Contextual Chunk Headers.
 *
 * @param text - The input text to chunk
 * @param context - Document context for CCH
 * @param options - Chunking options (profile, docType, chunkSize, chunkOverlap)
 * @returns Promise resolving to chunks with content and searchableText
 *
 * @example
 * const chunks = await chunkTextWithContextProfile(
 *   codeContent,
 *   { title: 'API Reference', sourcePath: 'src/api.ts' },
 *   { docType: 'project' }
 * );
 */
export async function chunkTextWithContextProfile(
  text: string,
  context: DocumentContext,
  options: ChunkOptions = {}
): Promise<ChunkWithContext[]> {
  // Get chunks using profile system
  const chunks = await chunkTextWithProfile(text, options);

  // Generate headers
  const headerBase = generateContextHeader({
    title: context.title,
    sourcePath: context.sourcePath,
  });
  const fullHeader = generateContextHeader(context);
  const docOnlyHeader = headerBase;

  let searchFrom = 0;
  return chunks.map((chunk, index) => {
    const header = index === 0 ? fullHeader : docOnlyHeader;
    const range = lineRangeForChunkContent(text, chunk, searchFrom);
    searchFrom = range.nextSearchFrom;
    return {
      content: chunk,
      searchableText: `${header} ${chunk}`,
      startLine: range.startLine,
      endLine: range.endLine,
    };
  });
}

/**
 * Split text into chunks using a ChunkingConfig.
 *
 * This is the main entry point for chunking with profile support.
 * Returns chunks with both content and searchableText (for CCH).
 *
 * @param text - The input text to chunk
 * @param config - Chunking configuration (profile, optional chunkSize, optional overlap)
 *
 * @returns Array of chunks with content and searchableText
 *
 * @example
 * // Using fixed profile with default settings
 * const chunks = chunkText(largeText, { profile: 'fixed' });
 *
 * @example
 * // Using structure profile with custom size
 * const chunks = chunkText(codeContent, { profile: 'structure', chunkSize: 800 });
 *
 * @example
 * // Using semantic profile with custom overlap
 * const chunks = chunkText(docsContent, { profile: 'semantic', overlap: 100 });
 */

// Re-export config for external access
export {
  detectProfile,
  getChunkingProfile,
  getProfileConfig,
  INGEST_CONFIG,
} from './config.js';

// ═══════════════════════════════════════════════════════════════
// AST CHUNKING INTEGRATION (T-08)
// ═══════════════════════════════════════════════════════════════

/**
 * Metadata for an AST-extracted chunk.
 * Contains symbol information for knowledge graph linking.
 */
export interface ASTChunkMetadata {
  /** Symbol name (function name, class name, etc.) */
  symbolName: string;
  /** Symbol kind: 'function', 'class', 'interface', 'type', 'enum', 'method' */
  symbolKind: string;
  /** Optional signature for functions/methods */
  signature?: string;
  /** Starting line number in the source file */
  startLine: number;
  /** Ending line number in the source file */
  endLine: number;
}

/**
 * AST chunk data structure from preprocessing.
 * Matches the output format of the AST preprocessor (T-07).
 */
export interface ASTChunk {
  /** Chunk content (the actual code) */
  content: string;
  /** Index of the chunk in the document */
  index: number;
  /** AST-specific metadata */
  metadata: ASTChunkMetadata;
}

/**
 * Result from chunkFromAST: chunks with symbol metadata preserved.
 */
export interface ChunkFromASTResult {
  content: string;
  searchableText: string;
  symbolName?: string;
  symbolKind?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
}

/**
 * Generate contextual chunk header for AST chunks.
 *
 * @param context - Document context (title, sourcePath, section/symbol)
 * @returns Formatted header like "[API Reference] > [src/utils.ts] > [calculateSum]"
 */
export function generateASTContextHeader(context: DocumentContext, symbolName?: string): string {
  const parts: string[] = [];

  if (context.title) {
    parts.push(`[${context.title}]`);
  }
  if (context.sourcePath) {
    parts.push(`[${context.sourcePath}]`);
  }
  if (symbolName) {
    parts.push(`[${symbolName}]`);
  } else if (context.section) {
    parts.push(`[${context.section}]`);
  }

  return parts.join(' > ');
}

/**
 * Create chunks from preprocessed AST chunks.
 *
 * This function transforms AST-extracted chunks into the format needed
 * for ingestion, preserving symbol metadata for knowledge graph linking.
 *
 * **Features:**
 * - Preserves symbol metadata (name, kind, line numbers)
 * - Adds Contextual Chunk Headers (CCH) for improved retrieval
 * - Generates searchable text with symbol context
 *
 * @param astChunks - Array of chunks from AST preprocessing
 * @param context - Document context for CCH generation
 * @returns Array of chunks ready for embedding and storage
 *
 * @example
 * const astChunks = [
 *   {
 *     content: 'function sum(a: number, b: number) { return a + b; }',
 *     index: 0,
 *     metadata: {
 *       symbolName: 'sum',
 *       symbolKind: 'function',
 *       signature: 'function sum(a: number, b: number)',
 *       startLine: 10,
 *       endLine: 12
 *     }
 *   }
 * ];
 *
 * const chunks = chunkFromAST(astChunks, {
 *   title: 'Utils',
 *   sourcePath: 'src/utils.ts'
 * });
 * // Returns: [{
 * //   content: 'function sum(a: number, b: number) { return a + b; }',
 * //   searchableText: '[Utils] > [src/utils.ts] > [sum] function sum(a: number, b: number)...',
 * //   symbolName: 'sum',
 * //   symbolKind: 'function',
 * //   startLine: 10,
 * //   endLine: 12,
 * //   signature: 'function sum(a: number, b: number)'
 * // }]
 */
export function chunkFromAST(
  astChunks: ASTChunk[],
  context: DocumentContext
): ChunkFromASTResult[] {
  if (!astChunks || astChunks.length === 0) {
    return [];
  }

  return astChunks.map((chunk) => {
    const { metadata, content } = chunk;

    // Generate contextual header with symbol name
    const header = generateASTContextHeader(context, metadata.symbolName);

    // Build searchable text with context
    let searchableText = `${header} ${content}`;

    // Add signature to searchable text if available (helps with function searches)
    if (metadata.signature && metadata.signature !== content) {
      searchableText = `${header} ${metadata.signature}\n${content}`;
    }

    return {
      content,
      searchableText,
      symbolName: metadata.symbolName,
      symbolKind: metadata.symbolKind,
      startLine: metadata.startLine,
      endLine: metadata.endLine,
      signature: metadata.signature,
    };
  });
}

/**
 * Determine if a file is eligible for AST chunking.
 *
 * @param sourcePath - Path to the file
 * @returns true if the file extension is supported for AST parsing
 */
export function isASTSupportedFile(sourcePath: string): boolean {
  if (!sourcePath) return false;

  const astExtensions = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.java',
    '.go',
    '.rs',
  ];

  const ext = sourcePath.toLowerCase().match(/\.[^./\\]+$/)?.[0];
  return ext ? astExtensions.includes(ext) : false;
}
