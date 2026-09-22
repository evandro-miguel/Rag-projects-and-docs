import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// p-retry is still used by the llamacpp provider path
vi.mock('p-retry', () => ({
  default: vi.fn((fn) => fn()),
}));

describe('llm-refiner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.LLM_REFINER_MAX_EXPANSION_RATIO = '10';
    process.env.LLM_REFINER_MIN_FRONTMATTER_CHARS = '999999';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // Gemini client tests removed — Gemini is fully retired.
  // All refinement now defaults to deterministic post-processing.

  it('should return deterministic post-processed content by default (no LLM)', async () => {
    const { refineDocument } = await import('../llm-refiner.js');

    const rawContent = '# Test\n\nimport { Noise } from "x";\n\nReal content here.';
    const result = await refineDocument(rawContent);

    // Must strip the import line but keep the rest
    expect(result).toContain('Real content here.');
    expect(result).not.toContain('import { Noise }');
  });

  it('should return deterministic post-processed content when provider is unset', async () => {
    delete process.env.LLM_REFINER_PROVIDER;
    delete process.env.GOOGLE_GEMINI_API_KEY;

    const { refineDocument } = await import('../llm-refiner.js');

    const result = await refineDocument('Some clean content.');
    expect(result).toContain('Some clean content.');
  });

  it('preserves RST imports during deterministic refinement', async () => {
    const { refineDocument } = await import('../llm-refiner.js');

    const result = await refineDocument(
      ['RST example', '==========', '', '.. code-block:: python', '   import requests'].join('\n'),
      { sourcePath: 'python-docs/guide.rst' }
    );

    expect(result).toContain('   import requests');
  });

  it('bypasses llamacpp for RST sources', async () => {
    process.env.LLM_REFINER_PROVIDER = 'llamacpp';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { refineDocument } = await import('../llm-refiner.js');
    const result = await refineDocument(
      ['RST example', '==========', '', '.. code-block:: python', '   import requests'].join('\n'),
      { sourcePath: 'python-docs/guide.rst' }
    );

    expect(result).toContain('   import requests');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should throw when llamacpp fetch fails and provider is explicitly llamacpp', async () => {
    process.env.LLM_REFINER_PROVIDER = 'llamacpp';
    process.env.LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';
    process.env.LLAMA_CPP_CHAT_PATH = '/v1/chat/completions';

    // Simulate fetch failure (llama.cpp not running)
    const fetchMock = vi.fn().mockRejectedValue(new Error('Connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    const { refineDocument } = await import('../llm-refiner.js');

    const rawContent = '# Test\n\nimport { Noise } from "x";\n\nReal content.';

    // Must propagate error — no silent fallback
    await expect(refineDocument(rawContent)).rejects.toThrow('Connection refused');
  });

  describe('llamacpp provider', () => {
    it('uses llama.cpp chat completions when provider is llamacpp', async () => {
      process.env.LLM_REFINER_PROVIDER = 'llamacpp';
      process.env.LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';
      process.env.LLAMA_CPP_CHAT_PATH = '/v1/chat/completions';
      process.env.LLAMA_CPP_REFINER_MODEL = 'gemma';
      delete process.env.GOOGLE_GEMINI_API_KEY;

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '# Clean content' } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { refineDocument } = await import('../llm-refiner.js');
      const result = await refineDocument('Raw document');

      expect(result).toBe('# Clean content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    });

    it('should throw when llama.cpp returns empty completion', async () => {
      process.env.LLM_REFINER_PROVIDER = 'llamacpp';
      process.env.LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';
      process.env.LLAMA_CPP_CHAT_PATH = '/v1/chat/completions';
      process.env.LLAMA_CPP_REFINER_MODEL = 'gemma';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { refineDocument } = await import('../llm-refiner.js');

      // Must propagate error — no silent fallback
      await expect(refineDocument('Raw document')).rejects.toThrow(
        'llama.cpp returned empty completion'
      );
    });

    it('falls back to deterministic cleanup when output expansion exceeds configured ratio', async () => {
      process.env.LLM_REFINER_PROVIDER = 'llamacpp';
      process.env.LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';
      process.env.LLAMA_CPP_CHAT_PATH = '/v1/chat/completions';
      process.env.LLAMA_CPP_REFINER_MODEL = 'gemma';
      process.env.LLM_REFINER_MAX_EXPANSION_RATIO = '1.01';
      process.env.LLM_REFINER_MIN_FRONTMATTER_CHARS = '999999';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `# Verbose\n\n${'Expanded text.\n'.repeat(2000)}` } }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const rawContent = `import { Noise } from "@/ui";\n${'Useful content.\n'.repeat(300)}`;
      const { refineDocument } = await import('../llm-refiner.js');
      const result = await refineDocument(rawContent, { sourcePath: 'bun-docs/example.mdx' });

      expect(result).toContain('Useful content.');
      expect(result).not.toContain('import { Noise }');
      expect(result.length).toBeLessThanOrEqual(Math.ceil(rawContent.length * 1.01));
    });
  });

  describe('postProcessRefinedContent', () => {
    it('removes mdx noise outside code fences', async () => {
      const { postProcessRefinedContent } = await import('../llm-refiner.js');

      const input = [
        'import { Figure } from "@/components/figure";',
        'export const title = "Demo";',
        '<Figure>',
        'Real technical text',
        '</Figure>',
        '```tsx',
        'import { keepMe } from "./inside-code";',
        '```',
      ].join('\n');

      const output = postProcessRefinedContent(input);
      expect(output).toContain('Real technical text');
      expect(output).toContain('import { keepMe } from "./inside-code";');
      expect(output).not.toContain('import { Figure }');
      expect(output).not.toContain('export const title');
      expect(output).not.toContain('<Figure>');
    });

    it('normalizes fenced yaml frontmatter and injects deterministic source path', async () => {
      process.env.LLM_REFINER_MIN_FRONTMATTER_CHARS = '0';
      process.env.LLM_REFINER_INCLUDE_FRONTMATTER = 'true';
      const { postProcessRefinedContent } = await import('../llm-refiner.js');

      const input = [
        '```yaml',
        '---',
        'title: "AI Agents"',
        'description: "Original description"',
        'source: "unknown"',
        'topics: [bun, agents, rsa]',
        'complexity: "intermediate"',
        '---',
        '',
        '## Agents',
        'Bun documentation covers runtime behavior.',
      ].join('\n');

      const output = postProcessRefinedContent(input, {
        sourcePath: 'bun-docs/runtime/http/server.mdx',
      });
      expect(output.startsWith('---\n')).toBe(true);
      expect(output).not.toContain('```yaml');
      expect(output).toContain('source: "bun-docs/runtime/http/server.mdx"');
      expect(output).not.toContain('source: "unknown"');
      expect(output).toContain('## Agents');
    });

    it('omits frontmatter by default for lean context', async () => {
      process.env.LLM_REFINER_MIN_FRONTMATTER_CHARS = '0';
      delete process.env.LLM_REFINER_INCLUDE_FRONTMATTER;
      const { postProcessRefinedContent } = await import('../llm-refiner.js');

      const input = [
        '---',
        'title: "AI Agents"',
        'description: "Original description"',
        'source: "unknown"',
        'topics: [bun, agents]',
        'complexity: "intermediate"',
        '---',
        '',
        '## Agents',
        'Bun documentation covers runtime behavior.',
      ].join('\n');

      const output = postProcessRefinedContent(input, {
        sourcePath: 'bun-docs/runtime/http/server.mdx',
      });
      expect(output.startsWith('---\n')).toBe(false);
      expect(output).toContain('## Agents');
    });
  });
});
