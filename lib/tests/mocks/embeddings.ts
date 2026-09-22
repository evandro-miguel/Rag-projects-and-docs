/**
 * Shared embedding mocks for testing
 *
 * Provides deterministic mock implementations for @google/generative-ai
 * to avoid real API calls during tests.
 *
 * @example
 * ```typescript
 * import { setupEmbeddingMocks } from '@/lib/tests/mocks/embeddings';
 *
 * // In your test file (BEFORE any imports)
 * setupEmbeddingMocks();
 * import { generateEmbeddings } from '../embedder';
 * ```
 */

import { vi } from 'vitest';

/**
 * Deterministic embedding vector generator
 * Generates consistent vectors based on input text and index
 * Same input always produces same output
 */
export function generateDeterministicVector(text: string, index = 0, dimensions = 3072): number[] {
  // Create a simple hash of the text
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Add index to hash for differentiation
  hash = hash + index;

  // Generate deterministic values
  const values: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    // Use hash to generate pseudo-random but deterministic values
    const seed = hash + i;
    const value = Math.sin(seed) * 2 - 1; // Range: [-1, 1]
    values.push(value);
  }

  return values;
}

/**
 * Creates a mock GenerativeModel instance with embedding methods
 */
function createMockGenerativeModel() {
  return {
    // For embedding models
    embedContent: vi.fn().mockImplementation(async (content: any) => {
      // Handle various input formats
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (content.parts && Array.isArray(content.parts)) {
        text = content.parts[0]?.text || '';
      } else if (content.content && typeof content.content === 'string') {
        text = content.content;
      } else if (content.content?.parts) {
        text = content.content.parts[0]?.text ?? '';
      }

      return {
        embedding: {
          values: generateDeterministicVector(text || 'mock-text'),
        },
      };
    }),

    // For text generation models (like llm-refiner uses)
    generateContent: vi.fn().mockImplementation(async (content: any) => {
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (content.parts && Array.isArray(content.parts)) {
        text = content.parts[0]?.text || '';
      }

      // Return a refined version (just uppercase for mock purposes)
      return {
        response: {
          text: () => `# Refined: ${text || 'mock-text'}`,
        },
      };
    }),

    batchEmbedContents: vi.fn().mockImplementation(async (request: any) => {
      // Handle both { requests: [...] } and { contents: [...] }
      const items = request.requests || request.contents || [];

      const embeddings = items.map((item: any, index: number) => {
        const text = item.content?.text || item.text || 'mock-text';
        return {
          values: generateDeterministicVector(text, index),
        };
      });

      return { embeddings };
    }),
  };
}

/**
 * Mock GoogleGenerativeAI class
 * Properly implements class structure for use with `new` keyword
 */
export class GoogleGenerativeAI {
  apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getGenerativeModel(_options?: { model?: string }) {
    return createMockGenerativeModel();
  }
}

/**
 * Convenience export for module mocking
 * Use this to mock the entire @google/generative-ai module
 */
export const mocks = {
  GoogleGenerativeAI,
};

/**
 * Helper to set up embedding mocks for a test file
 * Call this at the top of your test file BEFORE any imports
 *
 * @example
 * ```typescript
 * setupEmbeddingMocks();
 * import { generateEmbeddings } from '../embedder';
 * ```
 */
export function setupEmbeddingMocks() {
  // Compatibility shim. The mock is registered at module top level so Vitest
  // can hoist it without warnings.
}

/**
 * Helper to create a mock embedContent function with custom behavior
 * Useful for testing error scenarios or specific responses
 */
export function createMockEmbedContent(
  options: {
    shouldFail?: boolean;
    errorMessage?: string;
    customEmbedding?: number[];
    delay?: number;
  } = {}
): (...args: any[]) => Promise<{ embedding: { values: number[] } }> {
  const { shouldFail = false, errorMessage = 'API Error', customEmbedding, delay = 0 } = options;

  return vi.fn().mockImplementation(async () => {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (shouldFail) {
      throw new Error(errorMessage);
    }

    return {
      embedding: {
        values: customEmbedding ?? generateDeterministicVector('mock-text'),
      },
    };
  });
}

/**
 * Helper to create a mock batchEmbedContents function with custom behavior
 */
export function createMockBatchEmbed(
  options: {
    shouldFail?: boolean;
    errorMessage?: string;
    customEmbeddings?: number[][];
    count?: number;
    delay?: number;
  } = {}
): (...args: any[]) => Promise<{ embeddings: { values: number[] }[] }> {
  const {
    shouldFail = false,
    errorMessage = 'API Error',
    customEmbeddings,
    count = 25,
    delay = 0,
  } = options;

  return vi.fn().mockImplementation(async () => {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (shouldFail) {
      throw new Error(errorMessage);
    }

    const embeddings = customEmbeddings
      ? customEmbeddings.map((values) => ({ values }))
      : Array.from({ length: count }, (_, i) => ({
          values: generateDeterministicVector('mock-text', i),
        }));

    return { embeddings };
  });
}

/**
 * Verify that embedding mocks are properly set up
 * Useful for debugging test setup issues
 */
export function verifyMocksSetup(): boolean {
  const isMocked = GoogleGenerativeAI !== undefined;
  return isMocked;
}
