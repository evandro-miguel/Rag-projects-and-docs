/**
 * @module lib/tests/mocks/embeddings.test
 * @description Tests for Google Generative AI mock utilities.
 *
 * Ensures mock behavior is correct and deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockBatchEmbed,
  createMockEmbedContent,
  GoogleGenerativeAI,
  generateDeterministicVector,
  verifyMocksSetup,
} from './embeddings';

describe('GoogleGenerativeAI mock', () => {
  it('should be a proper class (constructable with new)', () => {
    const genAI = new GoogleGenerativeAI('test-key');
    expect(genAI).toBeInstanceOf(GoogleGenerativeAI);
  });

  it('should store API key', () => {
    const genAI = new GoogleGenerativeAI('my-api-key');
    expect(genAI.apiKey).toBe('my-api-key');
  });

  it('should return mock model with embedContent', () => {
    const genAI = new GoogleGenerativeAI('test-key');
    const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    expect(model.embedContent).toBeDefined();
    expect(typeof model.embedContent).toBe('function');
  });

  it('should return mock model with generateContent', () => {
    const genAI = new GoogleGenerativeAI('test-key');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    expect(model.generateContent).toBeDefined();
    expect(typeof model.generateContent).toBe('function');
  });

  it('should create different model instances independently', () => {
    const genAI = new GoogleGenerativeAI('test-key');
    const model1 = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    const model2 = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    expect(model1).not.toBe(model2);
    expect(model1.embedContent).toBeDefined();
    expect(model2.generateContent).toBeDefined();
  });
});

describe('generateDeterministicVector', () => {
  it('should return array of correct dimensions (3072)', () => {
    const vector = generateDeterministicVector('test', 0, 3072);
    expect(vector).toHaveLength(3072);
  });

  it('should be deterministic (same input = same output)', () => {
    const vector1 = generateDeterministicVector('test', 0, 3072);
    const vector2 = generateDeterministicVector('test', 0, 3072);
    expect(vector1).toEqual(vector2);
  });

  it('should differ for different inputs', () => {
    const vector1 = generateDeterministicVector('test1', 0, 3072);
    const vector2 = generateDeterministicVector('test2', 0, 3072);
    expect(vector1).not.toEqual(vector2);
  });

  it('should differ for different indices', () => {
    const vector1 = generateDeterministicVector('test', 0, 3072);
    const vector2 = generateDeterministicVector('test', 1, 3072);
    expect(vector1).not.toEqual(vector2);
  });

  it('should support custom dimensions (768)', () => {
    const vector = generateDeterministicVector('test', 0, 768);
    expect(vector).toHaveLength(768);
  });

  it('should support custom dimensions (1536)', () => {
    const vector = generateDeterministicVector('test', 0, 1536);
    expect(vector).toHaveLength(1536);
  });

  it('should return values in reasonable range (approximately -3 to 3)', () => {
    const vector = generateDeterministicVector('test', 0, 3072);
    vector.forEach((value) => {
      // Math.sin() * 2 - 1 can produce values slightly outside [-1, 1]
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(3);
    });
  });

  it('should not return all zeros', () => {
    const vector = generateDeterministicVector('test', 0, 3072);
    const allZeros = vector.every((v) => v === 0);
    expect(allZeros).toBe(false);
  });
});

describe('createMockEmbedContent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return successful embedding by default', async () => {
    const mockFn = createMockEmbedContent();
    const result = await mockFn({ content: 'test' });
    expect(result.embedding.values).toBeDefined();
    expect(result.embedding.values).toHaveLength(3072);
  });

  it('should fail when shouldFail=true', async () => {
    const mockFn = createMockEmbedContent({ shouldFail: true, errorMessage: 'API Error' });
    await expect(mockFn({ content: 'test' })).rejects.toThrow('API Error');
  });

  it('should use custom embedding when provided', async () => {
    const customVector = Array(3072).fill(0.5);
    const mockFn = createMockEmbedContent({ customEmbedding: customVector });
    const result = await mockFn({ content: 'test' });
    expect(result.embedding.values).toEqual(customVector);
  });

  it('should respect delay option', async () => {
    const mockFn = createMockEmbedContent({ delay: 100 });
    const start = Date.now();

    const promise = mockFn({ content: 'test' });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95); // Allow 5ms tolerance
  });

  it('should handle different content types', async () => {
    const mockFn = createMockEmbedContent();

    // String content
    const result1 = await mockFn({ content: 'text content' });
    expect(result1.embedding.values).toBeDefined();

    // Object content
    const result2 = await mockFn({ content: { text: 'object content' } });
    expect(result2.embedding.values).toBeDefined();
  });
});

describe('createMockBatchEmbed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return multiple embeddings by default', async () => {
    const mockFn = createMockBatchEmbed({ count: 10 });
    const contents = Array(10)
      .fill(null)
      .map((_, i) => ({ content: { text: `test ${i}` } }));

    const result = await mockFn({ contents });
    expect(result.embeddings).toHaveLength(10);
  });

  it('should fail when shouldFail=true', async () => {
    const mockFn = createMockBatchEmbed({ shouldFail: true, errorMessage: 'Batch Error' });
    await expect(mockFn({ contents: [] })).rejects.toThrow('Batch Error');
  });

  it('should use custom embeddings when provided', async () => {
    const customVectors = [Array(3072).fill(0.1), Array(3072).fill(0.2)];
    const mockFn = createMockBatchEmbed({ customEmbeddings: customVectors });
    const contents = [{ content: { text: 'test1' } }, { content: { text: 'test2' } }];

    const result = await mockFn({ contents });
    expect(result.embeddings[0].values).toEqual(customVectors[0]);
    expect(result.embeddings[1].values).toEqual(customVectors[1]);
  });

  it('should handle empty contents gracefully', async () => {
    // Note: createMockBatchEmbed returns a default count of 25 embeddings
    // To test empty results, use count: 0
    const mockFn = createMockBatchEmbed({ count: 0 });
    const result = await mockFn({ contents: [] });
    expect(result.embeddings).toHaveLength(0);
  });

  it('should respect delay option', async () => {
    const mockFn = createMockBatchEmbed({ delay: 50 });
    const contents = [{ content: { text: 'test' } }];

    const start = Date.now();
    const promise = mockFn({ contents });
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow 5ms tolerance
  });
});

describe('verifyMocksSetup', () => {
  it('should return true when mocks are set up', () => {
    expect(verifyMocksSetup()).toBe(true);
  });

  it('should confirm GoogleGenerativeAI is available', () => {
    const isAvailable = verifyMocksSetup();
    expect(isAvailable).toBe(true);

    // Try to instantiate
    const genAI = new GoogleGenerativeAI('test');
    expect(genAI).toBeDefined();
  });
});

describe('Integration: Mock Usage Patterns', () => {
  it('should work in typical embedding scenario', async () => {
    // Simulate typical usage
    const genAI = new GoogleGenerativeAI('test-api-key');
    const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

    const result = await model.embedContent({ content: 'Hello, world!' });

    expect(result.embedding.values).toBeDefined();
    expect(result.embedding.values).toHaveLength(3072);
    expect(result.embedding.values.every((v: number) => typeof v === 'number')).toBe(true);
  });

  it('should work with batch embedding scenario', async () => {
    const genAI = new GoogleGenerativeAI('test-api-key');
    const _model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

    const contents = [
      { content: { text: 'First document' } },
      { content: { text: 'Second document' } },
      { content: { text: 'Third document' } },
    ];

    // Note: In real API, batchEmbedContents is called differently
    // This tests the mock's batch capability
    const mockBatch = createMockBatchEmbed({ count: contents.length });
    const result = await mockBatch({ contents });

    expect(result.embeddings).toHaveLength(3);
    result.embeddings.forEach((embedding) => {
      expect(embedding.values).toHaveLength(3072);
    });
  });

  it('should handle error scenarios gracefully', async () => {
    const genAI = new GoogleGenerativeAI('test-api-key');
    const _model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

    // Create a failing mock
    const failingEmbed = createMockEmbedContent({
      shouldFail: true,
      errorMessage: 'Rate limit exceeded',
    });

    await expect(failingEmbed({ content: 'test' })).rejects.toThrow('Rate limit exceeded');
  });

  it('should produce consistent vectors for same input across calls', async () => {
    const mockEmbed = createMockEmbedContent();

    const result1 = await mockEmbed({ content: 'consistent test' });
    const result2 = await mockEmbed({ content: 'consistent test' });

    // Since we use index-based generation, same content should produce same vector
    expect(result1.embedding.values).toEqual(result2.embedding.values);
  });
});
