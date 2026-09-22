/**
 * @module lib/errors.test
 * @description Tests for RAG error type hierarchy.
 *
 * Tests error classes, codes, context, and serialization.
 */

import { describe, expect, it } from 'vitest';
import {
  InternalError,
  NotFoundError,
  RAGError,
  type RAGErrorContext,
  RateLimitError,
  ValidationError,
} from './errors';

describe('RAGError (base class)', () => {
  it('should create an error with code, message, and context', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Something went wrong', { operation: 'test' });

    expect(error.name).toBe('RAGError');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Something went wrong');
    expect(error.context).toEqual({ operation: 'test' });
  });

  it('should include optional cause', () => {
    const cause = new Error('Original error');
    const error = new RAGError('INTERNAL_ERROR', 'Wrapped error', { operation: 'test' }, cause);

    expect(error.cause).toBe(cause);
  });

  it('should have proper error stack', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test error', { operation: 'test' });

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('RAGError');
  });

  it('should serialize to JSON with code, message, and context', () => {
    const error = new RAGError('VALIDATION_ERROR', 'Invalid input', {
      operation: 'validate',
      field: 'email',
    });

    const json = error.toJSON();

    expect(json).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      context: { operation: 'validate', field: 'email' },
    });
  });

  it('should be an instance of Error', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test', { operation: 'test' });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RAGError);
  });

  it('should preserve error name in stack traces', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test error', { operation: 'test' });

    expect(error.name).toBe('RAGError');
  });
});

describe('ValidationError', () => {
  it('should create a validation error with proper code', () => {
    const error = new ValidationError('Invalid email format', {
      operation: 'validateUser',
      field: 'email',
    });

    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Invalid email format');
    expect(error.context).toEqual({
      operation: 'validateUser',
      field: 'email',
    });
  });

  it('should include optional cause', () => {
    const cause = new Error('Regex failed');
    const error = new ValidationError('Invalid format', { operation: 'validate' }, cause);

    expect(error.cause).toBe(cause);
  });

  it('should be an instance of RAGError', () => {
    const error = new ValidationError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('should serialize with correct code', () => {
    const error = new ValidationError('Required field missing', {
      operation: 'createUser',
      field: 'username',
    });

    expect(error.toJSON().code).toBe('VALIDATION_ERROR');
  });
});

describe('NotFoundError', () => {
  it('should create a not found error with proper code', () => {
    const error = new NotFoundError('User not found', {
      operation: 'getUserById',
      userId: '123',
    });

    expect(error.name).toBe('NotFoundError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('User not found');
    expect(error.context).toEqual({
      operation: 'getUserById',
      userId: '123',
    });
  });

  it('should include optional cause', () => {
    const cause = new Error('Database query failed');
    const error = new NotFoundError('Resource not found', { operation: 'find' }, cause);

    expect(error.cause).toBe(cause);
  });

  it('should be an instance of RAGError', () => {
    const error = new NotFoundError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('should serialize with correct code', () => {
    const error = new NotFoundError('Document not found', {
      operation: 'getDocument',
      docId: 'abc',
    });

    expect(error.toJSON().code).toBe('NOT_FOUND');
  });
});

describe('RateLimitError', () => {
  it('should create a rate limit error with proper code', () => {
    const error = new RateLimitError('Rate limit exceeded', {
      operation: 'apiCall',
      retryAfter: 60,
    });

    expect(error.name).toBe('RateLimitError');
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('Rate limit exceeded');
    expect(error.context).toEqual({
      operation: 'apiCall',
      retryAfter: 60,
    });
  });

  it('should include retryAfter in context', () => {
    const error = new RateLimitError('Too many requests', {
      operation: 'search',
      retryAfter: 30,
    });

    expect(error.context.retryAfter).toBe(30);
  });

  it('should work without retryAfter', () => {
    const error = new RateLimitError('Rate limited', {
      operation: 'apiCall',
    });

    expect(error.context.retryAfter).toBeUndefined();
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('should include optional cause', () => {
    const cause = new Error('Rate limiter triggered');
    const error = new RateLimitError('Limit exceeded', { operation: 'bulk' }, cause);

    expect(error.cause).toBe(cause);
  });

  it('should be an instance of RAGError', () => {
    const error = new RateLimitError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(RateLimitError);
  });

  it('should serialize with correct code', () => {
    const error = new RateLimitError('API rate limit', {
      operation: 'fetchData',
      retryAfter: 120,
    });

    expect(error.toJSON().code).toBe('RATE_LIMITED');
  });
});

describe('InternalError', () => {
  it('should create an internal error with proper code', () => {
    const error = new InternalError('Unexpected error occurred', {
      operation: 'processData',
      step: 'validation',
    });

    expect(error.name).toBe('InternalError');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Unexpected error occurred');
    expect(error.context).toEqual({
      operation: 'processData',
      step: 'validation',
    });
  });

  it('should include optional cause', () => {
    const cause = new Error('Null pointer exception');
    const error = new InternalError('Internal failure', { operation: 'test' }, cause);

    expect(error.cause).toBe(cause);
  });

  it('should be an instance of RAGError', () => {
    const error = new InternalError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(InternalError);
  });

  it('should serialize with correct code', () => {
    const error = new InternalError('Server error', {
      operation: 'handleRequest',
    });

    expect(error.toJSON().code).toBe('INTERNAL_ERROR');
  });
});

describe('Error context', () => {
  it('should support custom context properties', () => {
    const context: RAGErrorContext & { customField: string } = {
      operation: 'test',
      customField: 'custom value',
      correlationId: 'abc-123',
    };

    const error = new RAGError('INTERNAL_ERROR', 'Test', context);

    expect(error.context.customField).toBe('custom value');
    expect(error.context.correlationId).toBe('abc-123');
  });

  it('should include correlationId when provided', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test error', {
      operation: 'test',
      correlationId: 'xyz-789',
    });

    expect(error.context.correlationId).toBe('xyz-789');
  });

  it('should work with minimal context', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test', { operation: 'minimal' });

    expect(error.context.operation).toBe('minimal');
    expect(Object.keys(error.context).length).toBe(1);
  });

  it('should support nested context objects', () => {
    const error = new RAGError('VALIDATION_ERROR', 'Invalid', {
      operation: 'validate',
      details: { field: 'email', reason: 'invalid format' },
      metadata: { timestamp: '2024-01-01' },
    });

    expect(error.context.details).toEqual({
      field: 'email',
      reason: 'invalid format',
    });
  });
});

describe('Error inheritance chain', () => {
  it('should have correct prototype chain for ValidationError', () => {
    const error = new ValidationError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct prototype chain for NotFoundError', () => {
    const error = new NotFoundError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct prototype chain for RateLimitError', () => {
    const error = new RateLimitError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct prototype chain for InternalError', () => {
    const error = new InternalError('Test', { operation: 'test' });

    expect(error).toBeInstanceOf(InternalError);
    expect(error).toBeInstanceOf(RAGError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('Error codes', () => {
  it('should use correct code for ValidationError', () => {
    const error = new ValidationError('Test', { operation: 'test' });
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('should use correct code for NotFoundError', () => {
    const error = new NotFoundError('Test', { operation: 'test' });
    expect(error.code).toBe('NOT_FOUND');
  });

  it('should use correct code for RateLimitError', () => {
    const error = new RateLimitError('Test', { operation: 'test' });
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('should use correct code for InternalError', () => {
    const error = new InternalError('Test', { operation: 'test' });
    expect(error.code).toBe('INTERNAL_ERROR');
  });
});

describe('Error message formatting', () => {
  it('should preserve message exactly as provided', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Exact message', { operation: 'test' });
    expect(error.message).toBe('Exact message');
  });

  it('should support multiline messages', () => {
    const error = new InternalError('Line 1\nLine 2\nLine 3', { operation: 'test' });
    expect(error.message).toContain('\n');
  });

  it('should support empty messages', () => {
    const error = new RAGError('INTERNAL_ERROR', '', { operation: 'test' });
    expect(error.message).toBe('');
  });

  it('should support long messages', () => {
    const longMessage = 'a'.repeat(1000);
    const error = new InternalError(longMessage, { operation: 'test' });
    expect(error.message).toHaveLength(1000);
  });
});

describe('Error usage patterns', () => {
  it('should be throwable and catchable', () => {
    const throwError = () => {
      throw new ValidationError('Cannot throw', { operation: 'test' });
    };

    expect(throwError).toThrow(ValidationError);
    expect(throwError).toThrow('Cannot throw');
  });

  it('should work with try-catch blocks', () => {
    try {
      throw new NotFoundError('Resource missing', { operation: 'find' });
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe('NOT_FOUND');
    }
  });

  it('should be usable in Promise rejections', async () => {
    const promise = Promise.reject(new InternalError('Async failure', { operation: 'async' }));

    await expect(promise).rejects.toBeInstanceOf(InternalError);
    await expect(promise).rejects.toHaveProperty('code', 'INTERNAL_ERROR');
  });

  it('should work with async/await error handling', async () => {
    const asyncFunction = async () => {
      throw new RateLimitError('Rate limited', { operation: 'api', retryAfter: 5 });
    };

    await expect(asyncFunction()).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('JSON serialization', () => {
  it('should serialize all error types correctly', () => {
    const errors = [
      new ValidationError('Invalid', { operation: 'validate' }),
      new NotFoundError('Missing', { operation: 'find' }),
      new RateLimitError('Limited', { operation: 'api', retryAfter: 10 }),
      new InternalError('Error', { operation: 'process' }),
    ];

    errors.forEach((error) => {
      const json = error.toJSON();
      expect(json).toHaveProperty('code');
      expect(json).toHaveProperty('message');
      expect(json).toHaveProperty('context');
    });
  });

  it('should not include cause in JSON', () => {
    const cause = new Error('Cause');
    const error = new InternalError('Test', { operation: 'test' }, cause);
    const json = error.toJSON();

    expect(json).not.toHaveProperty('cause');
  });

  it('should preserve all context properties in JSON', () => {
    const error = new RAGError('INTERNAL_ERROR', 'Test', {
      operation: 'complex',
      field1: 'value1',
      field2: 123,
      field3: { nested: true },
    });

    const json = error.toJSON();

    expect(json.context.field1).toBe('value1');
    expect(json.context.field2).toBe(123);
    expect(json.context.field3).toEqual({ nested: true });
  });
});
