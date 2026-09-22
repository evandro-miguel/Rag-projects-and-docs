/**
 * @module llm-refiner
 * @description Document refinement for external documentation (Gemini path retired).
 *
 * **DEPRECATED** — Gemini-powered refinement is retired. This module now
 * performs deterministic post-processing only (noise stripping, frontmatter
 * normalization). For external docs cleanup, use `--skip-llm` or no LLM
 * provider to get deterministic results.
 *
 * The `llamacpp` provider remains available if explicitly configured.
 *
 * **Environment Variables:**
 * - `LLM_REFINER_PROVIDER` - Provider: `llamacpp` (deterministic by default)
 *
 * @see sync-external-docs.ts - Script that uses this module for external docs
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import pRetry from 'p-retry';

// Gemini retired — kept as a placeholder for config shape; runtime never uses Gemini.
const DEFAULT_REFINER_MODEL = 'gemma';
const DEFAULT_LLAMA_CPP_MODEL = 'gemma';
const DEFAULT_LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_LLAMA_CPP_CHAT_PATH = '/v1/chat/completions';
const DEFAULT_MAX_EXPANSION_RATIO = 1.15;
const DEFAULT_MIN_FRONTMATTER_CHARS = 1200;
const DEFAULT_INCLUDE_FRONTMATTER = false;
const IMPORT_NOISE_LINE_REGEX = /^\s*import\s+.*$/u;
const EXPORT_META_NOISE_LINE_REGEX = /^\s*export const (title|description|metadata)\s*=.*$/u;
const SITE_COMPONENT_PATH_NOISE_LINE_REGEX = /@site\/src\/components/u;
const MDX_COMPONENT_TAG_LINE_REGEX = /^\s*<\/?[A-Z][A-Za-z0-9]*(\s+[^>]*)?\/?>\s*$/u;
const MARKDOWN_HEADING_LINE_REGEX = /^#{1,3}\s+(.+)$/u;
const OPEN_CODE_FENCE_LINE_REGEX = /^```/u;
const CLOSE_CODE_FENCE_LINE_REGEX = /^```\s*$/u;
const TOP_YAML_FENCE_LINE_REGEX = /^```yaml\s*$/iu;
const MARKDOWN_FRONTMATTER_DELIMITER_REGEX = /^---\s*$/u;
const VALID_COMPLEXITY_VALUES = new Set(['beginner', 'intermediate', 'advanced']);
const TOPIC_STOP_WORDS = new Set([
  'advanced',
  'a',
  'an',
  'and',
  'api',
  'building',
  'core',
  'component',
  'components',
  'concept',
  'concepts',
  'doc',
  'docs',
  'documentation',
  'for',
  'from',
  'getting',
  'guide',
  'index',
  'in',
  'intermediate',
  'is',
  'md',
  'mdx',
  'of',
  'on',
  'or',
  'page',
  'readme',
  'section',
  'started',
  'the',
  'to',
  'unknown',
  'usage',
  'using',
  'with',
]);
const MAX_TOPICS = 8;
const MAX_DESCRIPTION_LENGTH = 200;
const GENERIC_NARRATION_LINE_REGEXES = [
  /^This (section|document|page|guide)\s+(explains|describes|details|covers|focuses on|provides|outlines)\b/iu,
  /^This (section|document|page|guide)\s+is about\b/iu,
];

// 'gemini' was removed from this union — Gemini is fully retired.
export type LlmRefinerProvider = 'none' | 'llamacpp';

export interface RefinerRuntimeConfig {
  provider: LlmRefinerProvider;
  model: string;
  endpoint?: string;
}

export interface RefineDocumentOptions {
  sourcePath?: string;
}

interface PostProcessOptions extends RefineDocumentOptions {
  originalContent?: string;
}

interface ParsedFrontmatter {
  title?: string;
  description?: string;
  source?: string;
  topics?: string[];
  complexity?: string;
  body: string;
}

// ============================================================================
// PROMPT CONFIGURATION
// ============================================================================

/**
 * Path to the refinement prompt file.
 * Can be customized via REFINEMENT_PROMPT_PATH environment variable.
 * Default: ./ingest/prompts/refinement-prompt.md
 */
const DEFAULT_PROMPT_PATH = join(process.cwd(), 'ingest', 'prompts', 'refinement-prompt.md');

/**
 * Load refinement prompt from external markdown file.
 *
 * If the file doesn't exist, falls back to the default embedded prompt.
 * The prompt content is extracted from the markdown file - everything after
 * the first heading is treated as the prompt text.
 *
 * @returns The prompt text to use for document refinement
 */
function loadRefinementPrompt(): string {
  const promptPath = process.env.REFINEMENT_PROMPT_PATH || DEFAULT_PROMPT_PATH;

  if (existsSync(promptPath)) {
    console.log(`📄 Loading refinement prompt from: ${promptPath}`);
    const fileContent = readFileSync(promptPath, 'utf-8');

    // Extract content after the first heading (skip the # Title line)
    const lines = fileContent.split('\n');
    let promptStartIndex = 0;

    // Skip the title line (# ...) and any empty lines after it
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('# ')) {
        promptStartIndex = i + 1;
        break;
      }
    }

    // Find the next heading to know where to stop (if there are multiple prompts in one file)
    for (let i = promptStartIndex; i < lines.length; i++) {
      if (lines[i].trim().startsWith('# ') && i > promptStartIndex) {
        const promptContent = lines.slice(promptStartIndex, i).join('\n').trim();
        if (promptContent) {
          return promptContent;
        }
      }
    }

    // If only one prompt in the file, return everything after the title
    const promptContent = lines.slice(promptStartIndex).join('\n').trim();
    if (promptContent) {
      return promptContent;
    }
  }

  // Fallback to embedded default prompt
  console.warn(`⚠️ Prompt file not found at ${promptPath}, using embedded default`);
  return EMBEDDED_DEFAULT_PROMPT;
}

/**
 * The embedded default prompt (fallback if external file is not available).
 * This is the original prompt kept for backward compatibility.
 */
const EMBEDDED_DEFAULT_PROMPT = `You are an expert technical documentation summarizer and cleaner for a RAG (Retrieval-Augmented Generation) system.
Your goal is to extract the core technical knowledge, APIs, code examples, and architectural concepts from the provided documentation file.
You MUST remove UI/UX boilerplate, navigation menus, long licenses, redundant marketing text, and filler words.
Rewrite the content into a high-density, concise Markdown format.
Keep all code blocks intact.
Do NOT output anything other than the processed Markdown content. Do not include introductory or concluding conversational text.`;

/**
 * Get the current system prompt (lazy loaded).
 * Cached after first load to avoid reading file on every call.
 */
let cachedPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = loadRefinementPrompt();
  }
  return cachedPrompt;
}

// ============================================================================
// PROVIDER RESOLUTION
// ============================================================================
// Gemini is retired.  Default is deterministic post-processing only.
// llamacpp remains available when explicitly configured via LLM_REFINER_PROVIDER=llamacpp.

function resolveRefinerProvider(env: NodeJS.ProcessEnv = process.env): LlmRefinerProvider {
  const rawValue = env.LLM_REFINER_PROVIDER?.trim().toLowerCase();
  if (rawValue === 'llamacpp') {
    return 'llamacpp';
  }
  // Default or anything else → deterministic only
  return 'none';
}

function getLlamaCppModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLAMA_CPP_REFINER_MODEL?.trim() || DEFAULT_LLAMA_CPP_MODEL;
}

function getLlamaCppEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = env.LLAMA_CPP_BASE_URL?.trim() || DEFAULT_LLAMA_CPP_BASE_URL;
  const chatPath = env.LLAMA_CPP_CHAT_PATH?.trim() || DEFAULT_LLAMA_CPP_CHAT_PATH;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
  const normalizedPath = chatPath.replace(/^\/+/u, '');
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

export function getRefinerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RefinerRuntimeConfig {
  const provider = resolveRefinerProvider(env);
  if (provider === 'llamacpp') {
    return {
      provider,
      model: getLlamaCppModel(env),
      endpoint: getLlamaCppEndpoint(env),
    };
  }
  // Gemini retired — default is deterministic (provider='none')
  return {
    provider,
    model: env.LLM_REFINER_MODEL?.trim() || DEFAULT_REFINER_MODEL,
  };
}

function parsePositiveFloatOrDefault(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBooleanOrDefault(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveIntOrDefault(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function getMaxExpansionRatio(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveFloatOrDefault(
    env.LLM_REFINER_MAX_EXPANSION_RATIO,
    DEFAULT_MAX_EXPANSION_RATIO
  );
}

function getMinFrontmatterChars(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntOrDefault(
    env.LLM_REFINER_MIN_FRONTMATTER_CHARS,
    DEFAULT_MIN_FRONTMATTER_CHARS
  );
}

function shouldIncludeFrontmatter(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanOrDefault(env.LLM_REFINER_INCLUDE_FRONTMATTER, DEFAULT_INCLUDE_FRONTMATTER);
}

function stripTopYamlFence(content: string): string {
  const lines = content.split('\n');
  if (lines.length === 0 || !TOP_YAML_FENCE_LINE_REGEX.test(lines[0].trim())) {
    return content;
  }

  lines.shift();

  if (lines[0]?.trim() === '---') {
    let frontmatterEnd = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (MARKDOWN_FRONTMATTER_DELIMITER_REGEX.test(lines[i].trim())) {
        frontmatterEnd = i;
        break;
      }
    }
    if (frontmatterEnd !== -1) {
      let nextIndex = frontmatterEnd + 1;
      while (nextIndex < lines.length && lines[nextIndex].trim() === '') {
        nextIndex += 1;
      }
      if (nextIndex < lines.length && CLOSE_CODE_FENCE_LINE_REGEX.test(lines[nextIndex].trim())) {
        lines.splice(nextIndex, 1);
      }
    }
  }

  return lines.join('\n');
}

function splitFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.trim();
  const lines = normalized.split('\n');
  if (lines.length < 3 || lines[0].trim() !== '---') {
    return { body: normalized };
  }

  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (MARKDOWN_FRONTMATTER_DELIMITER_REGEX.test(lines[i].trim())) {
      frontmatterEnd = i;
      break;
    }
  }

  if (frontmatterEnd === -1) {
    return { body: normalized };
  }

  const rawFrontmatterLines = lines.slice(1, frontmatterEnd);
  const body = lines
    .slice(frontmatterEnd + 1)
    .join('\n')
    .trim();
  const parsed: ParsedFrontmatter = { body };

  for (const line of rawFrontmatterLines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    if (key === 'topics') {
      const topicsMatch = value.match(/^\[(.*)\]$/u);
      if (!topicsMatch) {
        continue;
      }
      const topics = topicsMatch[1]
        .split(',')
        .map((topic) => topic.trim().replace(/^["']|["']$/gu, ''))
        .filter(Boolean);
      parsed.topics = topics;
      continue;
    }

    const unquotedValue = value.replace(/^["']|["']$/gu, '').trim();
    if (!unquotedValue) {
      continue;
    }

    if (key === 'title') parsed.title = unquotedValue;
    if (key === 'description') parsed.description = unquotedValue;
    if (key === 'source') parsed.source = unquotedValue;
    if (key === 'complexity') parsed.complexity = unquotedValue.toLowerCase();
  }

  return parsed;
}

function splitIdentifier(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function toKebabCase(input: string): string {
  return splitIdentifier(input)
    .map((token) => token.toLowerCase())
    .filter(Boolean)
    .join('-');
}

function normalizeTopic(topic: string): string | null {
  const kebab = toKebabCase(topic);
  if (!kebab || kebab.length < 2 || TOPIC_STOP_WORDS.has(kebab)) {
    return null;
  }
  return kebab;
}

function canonicalTopic(topic: string): string {
  if (topic.endsWith('ies') && topic.length > 4) {
    return `${topic.slice(0, -3)}y`;
  }
  if (topic.endsWith('s') && topic.length > 3 && !topic.endsWith('ss')) {
    return topic.slice(0, -1);
  }
  return topic;
}

function extractHeadingTokens(content: string): string[] {
  const tokens: string[] = [];
  for (const line of content.split('\n')) {
    const headingMatch = line.match(MARKDOWN_HEADING_LINE_REGEX);
    if (!headingMatch) {
      continue;
    }
    tokens.push(...splitIdentifier(headingMatch[1]));
  }
  return tokens;
}

function deriveTopics(parsed: ParsedFrontmatter, sourcePath: string | undefined): string[] {
  const candidates: string[] = [];

  if (sourcePath) {
    const fileWithoutExt = sourcePath.replace(/\.[^/.]+$/u, '');
    for (const segment of fileWithoutExt.split('/')) {
      candidates.push(...splitIdentifier(segment));
    }
  }

  candidates.push(...extractHeadingTokens(parsed.body));

  const normalizedExistingTopics = (parsed.topics ?? [])
    .map((topic) => normalizeTopic(topic))
    .filter((topic): topic is string => topic !== null);

  candidates.push(...normalizedExistingTopics);

  const seen = new Set<string>();
  const finalTopics: string[] = [];
  for (const candidate of candidates) {
    const topic = normalizeTopic(candidate);
    if (!topic) {
      continue;
    }
    const canonical = canonicalTopic(topic);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    finalTopics.push(canonical);
    if (finalTopics.length >= MAX_TOPICS) {
      break;
    }
  }

  if (finalTopics.length > 0) {
    return finalTopics;
  }

  return ['documentation'];
}

function prettifySourceTitle(sourcePath: string): string {
  const fileName = basename(sourcePath).replace(/\.[^/.]+$/u, '');
  const words = splitIdentifier(fileName).map((token) => token.toLowerCase());
  if (words.length === 0) {
    return 'Documentation';
  }
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function deriveTitle(parsed: ParsedFrontmatter, sourcePath: string | undefined): string {
  if (parsed.title && parsed.title.toLowerCase() !== 'unknown') {
    return parsed.title;
  }

  for (const line of parsed.body.split('\n')) {
    const match = line.match(/^#{1,3}\s+(.+)$/u);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  if (sourcePath) {
    return prettifySourceTitle(sourcePath);
  }

  return 'Documentation';
}

function deriveDescription(parsed: ParsedFrontmatter, fallbackTitle: string): string {
  if (parsed.description && parsed.description.toLowerCase() !== 'unknown') {
    return parsed.description.slice(0, MAX_DESCRIPTION_LENGTH).trim();
  }

  for (const line of parsed.body.split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('- ') ||
      trimmed.startsWith('* ') ||
      /^\d+\.\s+/u.test(trimmed)
    ) {
      continue;
    }
    const sentence = trimmed.replace(/\s+/gu, ' ').slice(0, MAX_DESCRIPTION_LENGTH).trim();
    if (sentence) {
      return sentence;
    }
  }

  return `${fallbackTitle} reference and implementation details.`;
}

function deriveComplexity(parsed: ParsedFrontmatter): string {
  if (parsed.complexity && VALID_COMPLEXITY_VALUES.has(parsed.complexity)) {
    return parsed.complexity;
  }

  const content = parsed.body.toLowerCase();
  const codeFenceCount = (parsed.body.match(/```/gu) ?? []).length;
  const advancedSignals = [
    'concurrency',
    'vector',
    'embedding',
    'distributed',
    'consistency',
    'transaction',
    'benchmark',
    'optimization',
  ];

  if (advancedSignals.some((signal) => content.includes(signal)) || codeFenceCount >= 6) {
    return 'advanced';
  }
  if (codeFenceCount >= 2 || parsed.body.length >= 2500) {
    return 'intermediate';
  }
  return 'beginner';
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function normalizeFrontmatter(
  parsed: ParsedFrontmatter,
  options: PostProcessOptions
): { body: string; frontmatter: string | null } {
  const normalizedBody = parsed.body.trim();
  if (!shouldIncludeFrontmatter()) {
    return { body: normalizedBody, frontmatter: null };
  }
  const includeBySize = normalizedBody.length >= getMinFrontmatterChars();

  if (!includeBySize) {
    return { body: normalizedBody, frontmatter: null };
  }

  const normalizedSource = options.sourcePath || parsed.source;
  const title = deriveTitle(parsed, options.sourcePath);
  const description = deriveDescription(parsed, title);
  const complexity = deriveComplexity(parsed);
  const topics = deriveTopics(parsed, options.sourcePath);

  const frontmatterLines = [
    '---',
    `title: "${escapeYamlString(title)}"`,
    `description: "${escapeYamlString(description)}"`,
  ];

  if (normalizedSource && normalizedSource.toLowerCase() !== 'unknown') {
    frontmatterLines.push(`source: "${escapeYamlString(normalizedSource)}"`);
  }
  frontmatterLines.push(`topics: [${topics.join(', ')}]`);
  frontmatterLines.push(`complexity: "${complexity}"`);
  frontmatterLines.push('---');

  return {
    body: normalizedBody,
    frontmatter: frontmatterLines.join('\n'),
  };
}

function collapseMarkdownWhitespace(content: string): string {
  return content.replace(/\n{3,}/gu, '\n\n').trim();
}

function isRstSourcePath(sourcePath: string | undefined): boolean {
  return sourcePath !== undefined && extname(sourcePath).toLowerCase() === '.rst';
}

function stripGenericNarration(content: string): string {
  const lines = content.split('\n');
  const cleaned: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCodeFence && OPEN_CODE_FENCE_LINE_REGEX.test(trimmed)) {
      inCodeFence = true;
      cleaned.push(line);
      continue;
    }
    if (inCodeFence && CLOSE_CODE_FENCE_LINE_REGEX.test(trimmed)) {
      inCodeFence = false;
      cleaned.push(line);
      continue;
    }

    if (
      !inCodeFence &&
      trimmed &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('- ') &&
      !trimmed.startsWith('* ') &&
      !/^\d+\.\s+/u.test(trimmed) &&
      GENERIC_NARRATION_LINE_REGEXES.some((pattern) => pattern.test(trimmed))
    ) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n');
}

function stripNoiseLinesOutsideCodeFences(content: string): string {
  const lines = content.split('\n');
  const cleanedLines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCodeFence && OPEN_CODE_FENCE_LINE_REGEX.test(trimmed)) {
      inCodeFence = true;
      cleanedLines.push(line);
      continue;
    }
    if (inCodeFence && CLOSE_CODE_FENCE_LINE_REGEX.test(trimmed)) {
      inCodeFence = false;
      cleanedLines.push(line);
      continue;
    }

    if (!inCodeFence) {
      if (IMPORT_NOISE_LINE_REGEX.test(line)) continue;
      if (EXPORT_META_NOISE_LINE_REGEX.test(line)) continue;
      if (SITE_COMPONENT_PATH_NOISE_LINE_REGEX.test(line)) continue;
      if (MDX_COMPONENT_TAG_LINE_REGEX.test(line)) continue;
    }

    cleanedLines.push(line);
  }

  return cleanedLines.join('\n');
}

export function postProcessRefinedContent(
  content: string,
  options: PostProcessOptions = {}
): string {
  const normalized = content.replace(/\r\n/gu, '\n');
  if (isRstSourcePath(options.sourcePath)) {
    return collapseMarkdownWhitespace(normalized);
  }

  const withoutYamlFence = stripTopYamlFence(normalized);
  const withoutNoise = stripNoiseLinesOutsideCodeFences(withoutYamlFence);
  const withoutGenericNarration = stripGenericNarration(withoutNoise);
  const parsed = splitFrontmatter(withoutGenericNarration);
  const { frontmatter, body } = normalizeFrontmatter(parsed, options);

  if (frontmatter) {
    return collapseMarkdownWhitespace(`${frontmatter}\n\n${body}`);
  }

  return collapseMarkdownWhitespace(body);
}

function enforceRefinementSizeGuard(
  rawContent: string,
  refinedContent: string,
  options: RefineDocumentOptions
): string {
  if (!rawContent) {
    return refinedContent;
  }

  const expansionRatio = refinedContent.length / Math.max(rawContent.length, 1);
  const maxRatio = getMaxExpansionRatio();
  if (expansionRatio <= maxRatio) {
    return refinedContent;
  }

  console.warn(
    `⚠️ Refined output exceeded max ratio (${expansionRatio.toFixed(2)} > ${maxRatio.toFixed(2)}). Falling back to deterministic cleanup.`
  );
  return postProcessRefinedContent(rawContent, {
    sourcePath: options.sourcePath,
    originalContent: rawContent,
  });
}

// _SYSTEM_PROMPT_DEPRECATED removed.

// generateWithRetry removed (Gemini retired).

type LlamaCppChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

// refineDocumentWithGemini removed (Gemini retired).

async function refineDocumentWithLlamaCpp(
  content: string,
  options: RefineDocumentOptions
): Promise<string> {
  const endpoint = getLlamaCppEndpoint();
  const model = getLlamaCppModel();
  const apiKey = process.env.LLAMA_CPP_API_KEY?.trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content },
    ],
  };

  const response = await pRetry(
    async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`llama.cpp API error ${res.status}`);
      }
      return res;
    },
    {
      retries: 3,
      minTimeout: 1000,
      maxTimeout: 10000,
      factor: 2,
    }
  );

  const data = (await response.json()) as LlamaCppChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const errorMessage = data.error?.message || 'llama.cpp returned empty completion';
    throw new Error(errorMessage);
  }
  const refined = postProcessRefinedContent(text, {
    sourcePath: options.sourcePath,
    originalContent: content,
  });
  return enforceRefinementSizeGuard(content, refined, options);
}

/**
 * Refine a document — Gemini path is retired.
 *
 * Default behavior: deterministic post-processing only (no LLM call).
 * If `LLM_REFINER_PROVIDER=llamacpp` is set and llama.cpp is reachable,
 * it will also be used for LLM-based cleanup.
 *
 * @param content - Raw document content to refine
 * @returns Refined document content as Markdown string
 */
export async function refineDocument(
  content: string,
  options: RefineDocumentOptions = {}
): Promise<string> {
  if (isRstSourcePath(options.sourcePath)) {
    return postProcessRefinedContent(content, {
      sourcePath: options.sourcePath,
      originalContent: content,
    });
  }

  const provider = resolveRefinerProvider();
  if (provider === 'llamacpp') {
    // When llamacpp is explicitly configured, errors propagate —
    // no silent fallback to deterministic post-processing.
    return await refineDocumentWithLlamaCpp(content, options);
  }
  return postProcessRefinedContent(content, {
    sourcePath: options.sourcePath,
    originalContent: content,
  });
}
