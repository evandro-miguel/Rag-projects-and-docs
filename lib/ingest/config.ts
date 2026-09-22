/**
 * @module config/ingest
 * @description Ingestion configuration including chunking profiles.
 *
 * This module defines multiple chunking strategies optimized for different
 * document types:
 *
 * **Profiles:**
 * - `fixed`: Fixed-size chunks with configurable overlap (simple, fast)
 * - `structure`: Code-aware splitting preserving classes, functions, headers
 * - `semantic`: Split by semantic boundaries (paragraphs, sections)
 *
 * **Auto-selection:**
 * - `project` docs → `structure` profile (code-aware)
 * - `external` docs → `semantic` profile (documentation-aware)
 * - Unknown type → `fixed` profile (safe default)
 *
 * @example
 * // Get profile for a document type
 * import { getChunkingProfile, INGEST_CONFIG } from './config.js';
 *
 * const profile = getChunkingProfile('project'); // Returns 'structure'
 * const settings = INGEST_CONFIG.profiles.structure;
 */

/**
 * Chunking profile names.
 */
export type ChunkingProfile = 'fixed' | 'structure' | 'semantic' | 'symbols';

/**
 * Document type from schema.
 */
export type DocType = 'external' | 'project';

/**
 * Configuration for a single chunking profile.
 */
export interface ChunkingProfileConfig {
  /** Profile name for logging/debugging */
  name: ChunkingProfile;
  /** Target chunk size in characters */
  chunkSize: number;
  /** Overlap between consecutive chunks */
  chunkOverlap: number;
  /** Separator hierarchy for splitting (in priority order) */
  separators: string[];
  /** Keep separator at split points */
  keepSeparator: boolean;
  /** Whether to preserve code blocks as atomic units */
  preserveCodeBlocks: boolean;
  /** Whether to split on heading boundaries */
  splitOnHeadings: boolean;
  /** Maximum heading level to split on (1-6) */
  maxHeadingLevel: number;
  /** Description of the profile */
  description: string;
}

/**
 * Ingestion configuration with multiple chunking profiles.
 */
export const INGEST_CONFIG = {
  /**
   * Default profile to use when docType is unknown or not specified.
   */
  defaultProfile: 'fixed' as ChunkingProfile,

  /**
   * Profile mapping by document type.
   * Determines which profile is auto-selected for each docType.
   */
  profileByDocType: {
    project: 'structure' as ChunkingProfile,
    external: 'semantic' as ChunkingProfile,
  },

  /**
   * Chunking profiles with their specific configurations.
   */
  profiles: {
    /**
     * Fixed-size chunking profile.
     * Simple, fast, and predictable. Good for general text.
     * Uses RecursiveCharacterTextSplitter with standard separators.
     */
    fixed: {
      name: 'fixed',
      chunkSize: 1000,
      chunkOverlap: 100,
      separators: ['\n\n', '\n', ' ', ''],
      keepSeparator: true,
      preserveCodeBlocks: false,
      splitOnHeadings: false,
      maxHeadingLevel: 0,
      description: 'Fixed-size chunks with overlap, simple and predictable',
    } satisfies ChunkingProfileConfig,

    /**
     * Structure-aware chunking profile.
     * Preserves code structures (classes, functions, code blocks)
     * Best for project code and technical documentation.
     */
    structure: {
      name: 'structure',
      chunkSize: 1200,
      chunkOverlap: 150,
      separators: [
        // Code structure boundaries (highest priority)
        '\n\nclass ',
        '\nclass ',
        '\n\nfunction ',
        '\nfunction ',
        '\n\nexport ',
        '\nexport ',
        '\n\nconst ',
        '\nconst ',
        '\n\nasync ',
        '\nasync ',
        // Markdown structure
        '\n## ',
        '\n### ',
        '\n#### ',
        // Standard text boundaries
        '\n\n',
        '\n',
        ' ',
        '',
      ],
      keepSeparator: true,
      preserveCodeBlocks: true,
      splitOnHeadings: true,
      maxHeadingLevel: 3,
      description: 'Code-aware chunks preserving classes, functions, and headings',
    } satisfies ChunkingProfileConfig,

    /**
     * Semantic chunking profile.
     * Splits on semantic boundaries (paragraphs, sections, topics).
     * Best for external documentation and prose content.
     */
    semantic: {
      name: 'semantic',
      chunkSize: 800,
      chunkOverlap: 80,
      separators: [
        // Major section breaks
        '\n---\n',
        '\n***\n',
        '\n___\n',
        // Heading boundaries
        '\n# ',
        '\n## ',
        '\n### ',
        // Paragraph breaks
        '\n\n\n',
        '\n\n',
        '\n',
        ' ',
        '',
      ],
      keepSeparator: true,
      preserveCodeBlocks: true,
      splitOnHeadings: true,
      maxHeadingLevel: 2,
      description: 'Semantic chunks split by paragraphs, sections, and topics',
    } satisfies ChunkingProfileConfig,

    /**
     * Symbol-aware chunking profile.
     * Uses tree-sitter to split code at symbol boundaries (functions, classes).
     * Best for code files where preserving complete symbols is critical.
     * Falls back to 'structure' profile for unsupported languages.
     */
    symbols: {
      name: 'symbols',
      chunkSize: 1500,
      chunkOverlap: 100,
      separators: [
        // These are fallback separators when tree-sitter fails
        '\n\nclass ',
        '\nclass ',
        '\n\nfunction ',
        '\nfunction ',
        '\n\nexport ',
        '\nexport ',
        '\n\nconst ',
        '\nconst ',
        '\n\nasync ',
        '\nasync ',
        '\n\n',
        '\n',
        ' ',
        '',
      ],
      keepSeparator: true,
      preserveCodeBlocks: true,
      splitOnHeadings: false,
      maxHeadingLevel: 0,
      description: 'Symbol-aware chunks using tree-sitter AST for function/class boundaries',
    } satisfies ChunkingProfileConfig,
  },

  /**
   * Code block markers for preservation logic.
   */
  codeBlockMarkers: {
    start: ['```', '~~~', '    '],
    end: ['```', '~~~'],
  },

  /**
   * Heading patterns for structure detection.
   */
  headingPattern: /^(#{1,6})\s+(.+)$/gm,
} as const;

/**
 * Get the chunking profile for a document type.
 *
 * @param docType - Document type ('project' or 'external')
 * @returns The appropriate chunking profile name
 *
 * @example
 * getChunkingProfile('project'); // Returns 'structure'
 * getChunkingProfile('external'); // Returns 'semantic'
 * getChunkingProfile(undefined); // Returns 'fixed' (default)
 */
export function getChunkingProfile(docType?: DocType): ChunkingProfile {
  if (!docType) {
    return INGEST_CONFIG.defaultProfile;
  }
  return INGEST_CONFIG.profileByDocType[docType] ?? INGEST_CONFIG.defaultProfile;
}

/**
 * Get the full configuration for a chunking profile.
 *
 * @param profile - Profile name ('fixed', 'structure', or 'semantic')
 * @returns The profile configuration
 *
 * @example
 * const config = getProfileConfig('structure');
 * console.log(config.chunkSize); // 1200
 */
export function getProfileConfig(profile: ChunkingProfile): ChunkingProfileConfig {
  return INGEST_CONFIG.profiles[profile];
}

/**
 * Detect the best chunking profile based on content characteristics.
 *
 * Analyzes content to determine the most appropriate profile:
 * - Code-like content (no markdown, programming syntax) → 'structure'
 * - Prose with headings and code blocks → 'semantic'
 * - Mixed or unknown → 'fixed'
 *
 * @param content - Document content to analyze
 * @param docType - Optional document type hint
 * @returns The recommended chunking profile
 *
 * @example
 * const codeContent = 'const x = 1;\nfunction foo() {}';
 * detectProfile(codeContent); // Returns 'structure'
 */
export function detectProfile(content: string, docType?: DocType): ChunkingProfile {
  // If docType is provided, use it for auto-selection
  if (docType) {
    return getChunkingProfile(docType);
  }

  // Analyze content to detect best profile
  const fencedCodeBlockCount = (content.match(/```\w*\n/g) || []).length;
  const headingCount = (content.match(/^#{1,6}\s/gm) || []).length;
  const _linesCount = content.split('\n').length;

  // Check for code-like patterns (without markdown)
  const codePatterns = [
    /\bclass\s+\w+/, // class Foo
    /\bfunction\s+\w+/, // function foo
    /\bconst\s+\w+\s*=/, // const x =
    /\blet\s+\w+\s*=/, // let x =
    /\basync\s+function/, // async function
    /\bexport\s+(default\s+)?/, // export / export default
    /\bimport\s+.*from/, // import ... from
    /\binterface\s+\w+/, // interface Foo
    /\btype\s+\w+\s*=/, // type Foo =
    /=>\s*{/, // arrow functions
    /\bprivate\s+\w+/, // private field
    /\bpublic\s+\w+/, // public field
  ];

  const codePatternMatches = codePatterns.reduce((count, pattern) => {
    return count + (content.match(pattern) || []).length;
  }, 0);

  // Heuristics for profile selection
  const hasFencedCodeBlocks = fencedCodeBlockCount > 2;
  const hasHeadings = headingCount >= 2;
  const isCodeLike = codePatternMatches >= 3;

  // If content looks like raw code (no markdown, but has code patterns)
  if (isCodeLike && !hasHeadings) {
    return 'structure';
  }

  // If content has fenced code blocks and headings, it's mixed documentation
  if (hasFencedCodeBlocks && hasHeadings) {
    return 'structure';
  }

  // If good heading structure with prose, use semantic
  if (hasHeadings && !isCodeLike) {
    return 'semantic';
  }

  // Default to fixed profile
  return 'fixed';
}

/**
 * Type for the full ingest configuration.
 */
export type IngestConfig = typeof INGEST_CONFIG;
