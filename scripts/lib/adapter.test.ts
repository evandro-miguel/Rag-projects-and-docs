/**
 * @module adapter.test
 * @description Unit tests for the document adapter module (local-only, Gemini retired).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs for prompt file loading tests
vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => path === process.env.RAG_REPO_ROOT),
  readFileSync: vi.fn(() => ''),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

// Import mocks for use in tests
const { existsSync, readFileSync } = await import('node:fs');

type ExistsPath = Parameters<typeof existsSync>[0];
type ExistsSyncMock = typeof existsSync & {
  mockImplementation: (implementation: (path: ExistsPath) => boolean) => unknown;
};
type ReadFileSyncMock = typeof readFileSync & {
  mockReturnValue: (value: string) => unknown;
};

const mockedExistsSync = existsSync as ExistsSyncMock;
const mockedReadFileSync = readFileSync as ReadFileSyncMock;

function mockPromptExists(exists: boolean): void {
  mockedExistsSync.mockImplementation((path) => path === process.env.RAG_REPO_ROOT || exists);
}

// Import the module under test
const { loadAdaptationPrompt, resetPromptCache, validateOutput } = await import('./adapter.js');

describe('adapter validateOutput', () => {
  it('returns valid for good adaptation', () => {
    const original = '# API\n\nThis is a test document with code.\n\n```ts\nconst x = 1;\n```';
    const adapted =
      '# API for Beginners\n\nThis is a test document explaining the API.\n\n```ts\nconst x = 1;\n```';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('reports issue for too short output', () => {
    const original = '# API\n\nSome content here with meaningful information.';
    const adapted = 'Short';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Adapted content is too short (< 50 characters)');
  });

  it('reports issue for excessive length ratio', () => {
    const original = '# API';
    const adapted = `# Extended API Documentation\n\n${'x'.repeat(500)}`;

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
    expect(result.issues.some((i: string) => i.includes('longer than original'))).toBe(true);
  });

  it('reports issue when code blocks are lost', () => {
    const original = '# API\n\n```ts\nconst x = 1;\n```';
    const adapted = '# API\n\nNo code here.';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Original had code blocks but adapted has none');
  });

  it('reports issue for low key term preservation', () => {
    const original =
      'React useState hook manages component state with setter function and initial value';
    const adapted = 'Something completely different';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
    expect(result.issues.some((i: string) => i.includes('preservation'))).toBe(true);
  });

  it('passes validation when enough terms are preserved', () => {
    const original = 'The function creates a new client instance with configuration options';
    const adapted =
      'The function creates a new client instance with specific configuration options';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(true);
  });

  it('handles empty adapted content', () => {
    const original = '# API\n\nSome content';
    const adapted = '';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
  });

  it('handles whitespace-only adapted content', () => {
    const original = '# API\n\nSome content';
    const adapted = '   \n\t   ';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
  });

  it('returns issues when applicable', () => {
    const original = '# API\n\nSome content here with words';
    const adapted = 'A';

    const result = validateOutput(original, adapted);

    expect(result.valid).toBe(false);
  });
});

// Gemini client tests (getGenAI, generateWithRetry) removed. Gemini is fully retired.
// All adaptation tests below verify local-only behavior.

describe('adapter loadAdaptationPrompt', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPromptCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('should load prompt from cache on second call', async () => {
    // First call should cache - it uses the default prompt
    const prompt1 = loadAdaptationPrompt('beginner');
    expect(prompt1).toBeDefined();

    // Second call should use cache (not call existsSync again)
    const prompt2 = loadAdaptationPrompt('beginner');

    expect(prompt1).toBe(prompt2);
  });

  it('should load prompt from file when available', async () => {
    mockPromptExists(true);
    mockedReadFileSync.mockReturnValue(
      `# Custom Prompt

This is a custom prompt from file.
Follow these rules:
- Be specific
- Be concise`
    );

    const prompt = loadAdaptationPrompt('beginner');

    expect(prompt).toContain('This is a custom prompt from file');
    expect(prompt).toContain('Be specific');
  });

  it('should extract content after header', async () => {
    mockPromptExists(true);
    mockedReadFileSync.mockReturnValue(
      `# Adaptation Prompt

Actual prompt content starts here.
This should be extracted.`
    );

    const prompt = loadAdaptationPrompt('code-focused');

    expect(prompt).not.toContain('# Adaptation Prompt');
    expect(prompt).toContain('Actual prompt content starts here');
  });

  it('should fall back to default prompt when file not found', async () => {
    mockPromptExists(false);
    const prompt = loadAdaptationPrompt('senior');

    expect(prompt).toContain('You are a technical documentation adapter');
    expect(prompt).toContain('Be concise');
  });

  it('should fall back to default for all contexts', async () => {
    mockPromptExists(false);

    const contexts = ['beginner', 'senior', 'code-focused', 'architecture', 'quick-ref'] as const;

    for (const context of contexts) {
      const prompt = loadAdaptationPrompt(context);
      expect(prompt).toBeDefined();
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it('should handle empty file content gracefully', async () => {
    mockPromptExists(true);
    mockedReadFileSync.mockReturnValue('');

    const prompt = loadAdaptationPrompt('beginner');

    // Should fall back to default when file content is empty
    expect(prompt).toContain('You are a technical documentation adapter');
  });
});

describe('adapter adaptDocument (local-only)', () => {
  it('should produce structured output for beginner context', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument(
      'Docs RAG searches external docs. Project RAG searches repository code.',
      'beginner'
    );

    expect(result).toContain('## Overview');
    expect(result).toContain('Docs RAG searches external docs');
    expect(result).toContain('Project RAG searches repository code');
  });

  it('should produce structured output for code-focused context', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument(
      'Use vector search for semantic retrieval.\n\n```ts\nconst result = await search();\n```',
      'code-focused'
    );

    expect(result).toContain('## Code-Focused Notes');
    expect(result).toContain('```ts\nconst result = await search();\n```');
  });

  it('should produce structured output for senior context', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument('Some content here about advanced patterns.', 'senior');

    expect(result).toContain('## Senior Summary');
  });

  it('should produce structured output for architecture context', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument('System design content.', 'architecture');

    expect(result).toContain('## Architecture Notes');
  });

  it('should produce structured output for quick-ref context', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument('Reference content here.', 'quick-ref');

    expect(result).toContain('## Quick Reference');
  });

  it('should truncate output to maxLength', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument('Long content here. '.repeat(500), 'beginner', {
      maxLength: 200,
    });

    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('should preserve code blocks when preserveCode is true', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument(
      '# API\n\n```ts\nconst x = 1;\n```\nSome text',
      'code-focused',
      { preserveCode: true }
    );

    expect(result).toContain('```ts');
    expect(result).toContain('const x = 1;');
  });

  it('should preserve code blocks in quick references when requested', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const result = await adaptDocument(
      '# API\n\n```ts\nconst route = Bun.serve({});\n```\nUse the route API.',
      'quick-ref',
      { preserveCode: true }
    );

    expect(result).toContain('```ts');
    expect(result).toContain('const route = Bun.serve({});');
  });

  it('should handle very large content without error', async () => {
    const { adaptDocument, resetPromptCache: resetCache } = await import('./adapter.js');
    resetCache();

    const largeContent = `# Big Doc\n\n${'word '.repeat(10_000)}`;
    const result = await adaptDocument(largeContent, 'quick-ref', { maxLength: 2000 });

    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toBeTruthy();
  });
});
