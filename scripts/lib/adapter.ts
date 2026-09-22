/**
 * @module adapter
 * @description Deprecated — local-only document summarization for context-specific presentation.
 *
 * **DEPRECATED** — Gemini-powered adaptation is retired. Use subagents for
 * intelligent file processing. This module now performs deterministic local
 * extraction only (heading/bullet/sentence → structured notes).
 *
 * **Migration:** Replace MCP tools `adapt_docs` and `search_and_adapt` with
 * subagent-based file processing. These tools remain registered as deprecated
 * stubs returning local content with `deprecated: true` metadata.
 *
 * @example
 * // Adapt a document locally (deterministic only)
 * import { adaptDocument, validateOutput } from './lib/adapter.js';
 *
 * const rawContent = "## API Usage\n\n```ts\nconst client = createClient();\n```";
 * const adapted = await adaptDocument(rawContent, 'beginner', { maxLength: 1500 });
 *
 * // Validate the adaptation
 * const validation = validateOutput(rawContent, adapted);
 * if (!validation.valid) {
 *   console.warn('Adaptation issues:', validation.issues);
 * }
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveRepoPath } from './runtime-env.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Available adaptation contexts for documentation transformation.
 *
 * Each context optimizes the output for a specific use case:
 * - `code-focused`: Prioritizes working code examples, minimizes prose
 * - `architecture`: Highlights system design, data flow, and component relationships
 * - `beginner`: Adds explanations, examples, and learning-oriented context
 * - `senior`: Concise, assumes expertise, focuses on specifics
 * - `quick-ref`: Structured for rapid scanning (tables, bullets, checklists)
 */
export type AdaptationContext =
  | 'code-focused'
  | 'architecture'
  | 'beginner'
  | 'senior'
  | 'quick-ref';

/**
 * Options for document adaptation.
 */
export interface AdaptOptions {
  /** Maximum output length in characters (default: 2000) */
  maxLength?: number;
  /** Whether to preserve code blocks unchanged (default: true) */
  preserveCode?: boolean;
}

/**
 * Result of output validation.
 */
export interface ValidationResult {
  /** Whether the adapted output meets quality standards */
  valid: boolean;
  /** List of issues found (empty if valid) */
  issues: string[];
}

// ============================================================================
// Configuration
// ============================================================================
// Gemini-powered adaptation is deprecated.  All adaptation is now local-only.

/**
 * Default prompts for each adaptation context.
 * Used when external prompt files are not available.
 */
const DEFAULT_PROMPTS: Record<AdaptationContext, string> = {
  'code-focused': `You are a technical documentation adapter for a RAG system.
Your task is to transform documentation to be code-focused.
RULES:
- Prioritize working code examples over explanations
- Keep code blocks complete and runnable when possible
- Minimize prose, focus on essential comments
- Preserve API signatures and type definitions
- Remove marketing and filler content
Output only the adapted Markdown, no meta-commentary.`,

  architecture: `You are a technical documentation adapter for a RAG system.
Your task is to transform documentation to focus on architecture.
RULES:
- Highlight system design and component relationships
- Emphasize data flow and integration patterns
- Include architecture diagrams as Mermaid when helpful
- Summarize implementation details, focus on design decisions
- Preserve interface definitions and type contracts
Output only the adapted Markdown, no meta-commentary.`,

  beginner: `You are a technical documentation adapter for a RAG system.
Your task is to make documentation beginner-friendly.
RULES:
- Add context and explanations for common concepts
- Include step-by-step examples when helpful
- Define jargon and technical terms inline
- Use simple language and avoid assumptions
- Provide "why" explanations, not just "how"
Output only the adapted Markdown, no meta-commentary.`,

  senior: `You are a technical documentation adapter for a RAG system.
Your task is to adapt documentation for senior developers.
RULES:
- Be concise, assume familiarity with common patterns
- Focus on specifics and edge cases
- Skip basics, highlight what's unique or important
- Use precise technical terminology
- Reference related patterns by name without explanation
Output only the adapted Markdown, no meta-commentary.`,

  'quick-ref': `You are a technical documentation adapter for a RAG system.
Your task is to create a quick reference format.
RULES:
- Use bullet points and tables for rapid scanning
- Create summary tables for options/parameters
- Use checklists for procedures
- Highlight key facts and gotchas
- Minimize prose, maximize scannability
Output only the adapted Markdown, no meta-commentary.`,
};

/**
 * Prompt cache to avoid repeated file reads.
 */
const promptCache: Map<AdaptationContext, string> = new Map();

/**
 * Reset the prompt cache (useful for testing)
 */
export function resetPromptCache(): void {
  promptCache.clear();
}

// ============================================================================
// Prompt Loading
// ============================================================================

/**
 * Load the adaptation prompt for a specific context.
 *
 * Attempts to load from external file first (ingest/prompts/adapt-{context}.md),
 * falls back to embedded default prompt if file not found.
 *
 * @param context - The adaptation context
 * @returns The prompt text for this context
 */
export function loadAdaptationPrompt(context: AdaptationContext): string {
  // Check cache first
  const cachedPrompt = promptCache.get(context);
  if (cachedPrompt) {
    return cachedPrompt;
  }

  const promptPath = resolveRepoPath('ingest', 'prompts', `adapt-${context}.md`);

  if (existsSync(promptPath)) {
    const fileContent = readFileSync(promptPath, 'utf-8');

    // Extract content after the first heading
    const lines = fileContent.split('\n');
    let promptStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('# ')) {
        promptStartIndex = i + 1;
        break;
      }
    }

    const promptContent = lines.slice(promptStartIndex).join('\n').trim();
    if (promptContent) {
      promptCache.set(context, promptContent);
      return promptContent;
    }
  }

  // Fall back to default prompt
  promptCache.set(context, DEFAULT_PROMPTS[context]);
  return DEFAULT_PROMPTS[context];
}

// ============================================================================
// Deprecated — Gemini client removed.  Local-only adaptation below.
// ============================================================================

// ============================================================================
// Main API
// ============================================================================

const MAX_FALLBACK_ITEMS = 8;

function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '').trim();
}

function extractCodeBlocks(content: string): string[] {
  return content.match(/```[\s\S]*?```/g) ?? [];
}

function truncateMarkdown(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  const truncated = content.slice(0, Math.max(0, maxLength - 3));
  const boundary = Math.max(
    truncated.lastIndexOf('\n'),
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('; ')
  );
  return `${truncated.slice(0, boundary > 80 ? boundary : truncated.length).trimEnd()}...`;
}

function extractKeyLines(content: string): string[] {
  const prose = stripCodeBlocks(content);
  const lines = prose
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[-=*`#\s]+$/.test(line));

  const headings = lines.filter((line) => /^#{1,4}\s+/.test(line));
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line));
  const sentences = prose
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return [...headings, ...bullets, ...sentences]
    .map((line) => line.replace(/^#{1,4}\s+/, '').replace(/^[-*]\s+/, ''))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, MAX_FALLBACK_ITEMS);
}

function adaptDocumentLocally(
  content: string,
  context: AdaptationContext,
  options: Required<AdaptOptions>
): string {
  const keyLines = extractKeyLines(content);
  const codeBlocks = options.preserveCode ? extractCodeBlocks(content).slice(0, 3) : [];
  const bullets = keyLines.map((line) => `- ${line}`);
  const codeSection = codeBlocks.length > 0 ? ['', '## Code', ...codeBlocks] : [];

  const sections: Record<AdaptationContext, string[]> = {
    'quick-ref': ['## Quick Reference', ...bullets, ...codeSection],
    senior: ['## Senior Summary', ...bullets.slice(0, 6), ...codeSection],
    beginner: [
      '## Overview',
      ...keyLines.slice(0, 6).map((line) => `- ${line}`),
      '',
      '## What To Notice',
      '- Focus on the named APIs, constraints, and examples from the source material.',
      ...codeSection,
    ],
    architecture: [
      '## Architecture Notes',
      ...bullets.slice(0, 6),
      '',
      '## Relationships',
      '- Preserve the source terminology when mapping components, data flow, or boundaries.',
      ...codeSection,
    ],
    'code-focused': ['## Code-Focused Notes', ...bullets.slice(0, 5), ...codeSection],
  };

  const fallback = sections[context].join('\n').trim();
  return truncateMarkdown(
    fallback.length > 0 ? fallback : truncateMarkdown(content, options.maxLength),
    options.maxLength
  );
}

/**
 * Adapt a document for a specific context using local-only deterministic extraction.
 *
 * **DEPRECATED** — Gemini-powered adaptation is retired. This function now
 * performs deterministic local extraction only (heading/bullet/sentence →
 * structured notes). Use subagents for intelligent file processing.
 *
 * @param content - Raw document content to adapt
 * @param context - Target adaptation context
 * @param options - Adaptation options (maxLength, preserveCode)
 *
 * @returns Adapted document content as Markdown string
 *
 * @example
 * const adapted = await adaptDocument(rawContent, 'beginner', { maxLength: 1500 });
 */
export async function adaptDocument(
  content: string,
  context: AdaptationContext,
  options?: AdaptOptions
): Promise<string> {
  const maxLength = options?.maxLength ?? 2000;
  const preserveCode = options?.preserveCode ?? true;
  return adaptDocumentLocally(content, context, { maxLength, preserveCode });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate adapted output against quality criteria.
 *
 * Checks:
 * - Length: Output should not be excessively long
 * - Code preservation: Code blocks should be preserved when requested
 * - Faithfulness: Output should contain key terms from original
 *
 * @param original - Original document content
 * @param adapted - Adapted document content
 *
 * @returns Validation result with issues list
 *
 * @example
 * const validation = validateOutput(original, adapted);
 * if (!validation.valid) {
 *   console.warn('Issues:', validation.issues);
 * }
 */
export function validateOutput(original: string, adapted: string): ValidationResult {
  const issues: string[] = [];

  // Check minimum length (adapted should have substance)
  if (adapted.trim().length < 50) {
    issues.push('Adapted content is too short (< 50 characters)');
  }

  // Check for excessive length ratio (shouldn't be much longer than original)
  const lengthRatio = adapted.length / original.length;
  if (lengthRatio > 2.0) {
    issues.push(`Adapted content is ${lengthRatio.toFixed(1)}x longer than original`);
  }

  // Check code block preservation
  const originalCodeBlocks = original.match(/```[\s\S]*?```/g) || [];
  const adaptedCodeBlocks = adapted.match(/```[\s\S]*?```/g) || [];

  if (originalCodeBlocks.length > 0 && adaptedCodeBlocks.length === 0) {
    issues.push('Original had code blocks but adapted has none');
  }

  // Check for key term preservation (basic faithfulness check)
  // Extract significant words (4+ chars, not common words)
  const significantWords = (original.match(/\b[a-zA-Z]{4,}\b/g) || [])
    .filter(
      (word) =>
        ![
          'that',
          'this',
          'with',
          'from',
          'have',
          'will',
          'your',
          'which',
          'their',
          'there',
          'would',
          'could',
          'should',
        ].includes(word.toLowerCase())
    )
    .map((w) => w.toLowerCase());

  const uniqueWords = [...new Set(significantWords)];
  const adaptedLower = adapted.toLowerCase();

  // At least 50% of unique significant words should appear
  const preservedCount = uniqueWords.filter((word) => adaptedLower.includes(word)).length;
  const preservationRate = uniqueWords.length > 0 ? preservedCount / uniqueWords.length : 1;

  if (preservationRate < 0.5 && uniqueWords.length > 5) {
    issues.push(
      `Low key term preservation: ${(preservationRate * 100).toFixed(0)}% (${preservedCount}/${uniqueWords.length})`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
