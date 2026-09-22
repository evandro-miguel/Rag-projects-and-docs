/**
 * Tests for lib/api-response.ts
 *
 * Covers:
 * - success<T>(data) returns { success: true, data }
 * - error(code, message, details?) returns { success: false, error: { code, message, details } }
 * - fromRAGError(err) converts RAGError to ApiResponse
 * - toHttpStatus(errorCode) maps codes to HTTP status
 * - jsonResponse() creates Response with JSON content
 * - rateLimitResponse() creates 429 Response with Retry-After
 */

import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS_MAP,
  error,
  fromRAGError,
  jsonResponse,
  rateLimitResponse,
  success,
  toHttpStatus,
} from '../api-response.js';
import { NotFoundError, RAGError, ValidationError } from '../errors.js';

describe('api-response', () => {
  describe('success()', () => {
    it('returns success response with string data', () => {
      const result = success('hello');
      expect(result).toEqual({
        success: true,
        data: 'hello',
      });
    });

    it('returns success response with number data', () => {
      const result = success(42);
      expect(result).toEqual({
        success: true,
        data: 42,
      });
    });

    it('returns success response with object data', () => {
      const data = { id: 1, name: 'test' };
      const result = success(data);
      expect(result).toEqual({
        success: true,
        data,
      });
    });

    it('returns success response with array data', () => {
      const data = [1, 2, 3];
      const result = success(data);
      expect(result).toEqual({
        success: true,
        data,
      });
    });

    it('returns success response with undefined data', () => {
      const result = success(undefined);
      expect(result).toEqual({
        success: true,
        data: undefined,
      });
    });
  });

  describe('error()', () => {
    it('returns error response without details', () => {
      const result = error('NOT_FOUND', 'Resource not found');
      expect(result).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
      });
    });

    it('returns error response with details', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const result = error('VALIDATION_ERROR', 'Invalid email', details);
      expect(result).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid email',
          details,
        },
      });
    });

    it('returns error response with complex details', () => {
      const details = {
        errors: [
          { path: 'name', message: 'Required' },
          { path: 'email', message: 'Invalid' },
        ],
      };
      const result = error('VALIDATION_ERROR', 'Validation failed', details);
      expect(result.error?.details).toEqual(details);
    });
  });

  describe('fromRAGError()', () => {
    it('converts RAGError to ApiResponse', () => {
      const ragError = new RAGError('INTERNAL_ERROR', 'Something went wrong', {
        operation: 'test',
        correlationId: 'abc-123',
      });
      const result = fromRAGError(ragError);
      expect(result).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          details: { operation: 'test', correlationId: 'abc-123' },
        },
      });
    });

    it('converts ValidationError to ApiResponse', () => {
      const validationError = new ValidationError('Invalid input', {
        operation: 'validate',
        field: 'name',
      });
      const result = fromRAGError(validationError);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toBe('Invalid input');
      expect(result.error?.details).toEqual({ operation: 'validate', field: 'name' });
    });

    it('converts NotFoundError to ApiResponse', () => {
      const notFoundError = new NotFoundError('User not found', {
        operation: 'getUser',
        userId: 123,
      });
      const result = fromRAGError(notFoundError);
      expect(result.error?.code).toBe('NOT_FOUND');
      expect(result.error?.message).toBe('User not found');
    });
  });

  describe('toHttpStatus()', () => {
    it('maps VALIDATION_ERROR to 400', () => {
      expect(toHttpStatus('VALIDATION_ERROR')).toBe(400);
    });

    it('maps UNAUTHORIZED to 401', () => {
      expect(toHttpStatus('UNAUTHORIZED')).toBe(401);
    });

    it('maps FORBIDDEN to 403', () => {
      expect(toHttpStatus('FORBIDDEN')).toBe(403);
    });

    it('maps NOT_FOUND to 404', () => {
      expect(toHttpStatus('NOT_FOUND')).toBe(404);
    });

    it('maps RATE_LIMITED to 429', () => {
      expect(toHttpStatus('RATE_LIMITED')).toBe(429);
    });

    it('maps INVALID_API_KEY to 401', () => {
      expect(toHttpStatus('INVALID_API_KEY')).toBe(401);
    });

    it('maps INTERNAL_ERROR to 500', () => {
      expect(toHttpStatus('INTERNAL_ERROR')).toBe(500);
    });

    it('maps SERVICE_UNAVAILABLE to 503', () => {
      expect(toHttpStatus('SERVICE_UNAVAILABLE')).toBe(503);
    });

    it('returns 500 for unknown error codes', () => {
      expect(toHttpStatus('UNKNOWN_ERROR')).toBe(500);
      expect(toHttpStatus('')).toBe(500);
    });
  });

  describe('ERROR_STATUS_MAP', () => {
    it('contains all expected error codes', () => {
      expect(ERROR_STATUS_MAP.VALIDATION_ERROR).toBe(400);
      expect(ERROR_STATUS_MAP.UNAUTHORIZED).toBe(401);
      expect(ERROR_STATUS_MAP.FORBIDDEN).toBe(403);
      expect(ERROR_STATUS_MAP.NOT_FOUND).toBe(404);
      expect(ERROR_STATUS_MAP.RATE_LIMITED).toBe(429);
      expect(ERROR_STATUS_MAP.INVALID_API_KEY).toBe(401);
      expect(ERROR_STATUS_MAP.INTERNAL_ERROR).toBe(500);
      expect(ERROR_STATUS_MAP.SERVICE_UNAVAILABLE).toBe(503);
    });
  });

  describe('jsonResponse()', () => {
    it('creates Response with JSON body and correct content type', async () => {
      const body = { success: true, data: 'test' };
      const response = jsonResponse(body, 200);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(await response.json()).toEqual(body);
    });

    it('creates Response with custom status code', async () => {
      const body = { error: 'Not found' };
      const response = jsonResponse(body, 404);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(body);
    });

    it('includes CORS headers when provided', async () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
      };
      const response = jsonResponse({ data: 'test' }, 200, corsHeaders);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('stringifies complex objects correctly', async () => {
      const body = { nested: { array: [1, 2, 3], value: null } };
      const response = jsonResponse(body, 200);
      expect(await response.json()).toEqual(body);
    });
  });

  describe('rateLimitResponse()', () => {
    it('creates 429 Response with Retry-After header', async () => {
      const response = rateLimitResponse(60);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('RATE_LIMITED');
      expect(body.error?.message).toContain('Try again in 60 seconds');
    });

    it('includes CORS headers when provided', () => {
      const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
      const response = rateLimitResponse(120, corsHeaders);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Retry-After')).toBe('120');
    });

    it('includes correct retry time in message', async () => {
      const response = rateLimitResponse(300);
      const body = await response.json();
      expect(body.error?.message).toContain('Try again in 300 seconds');
    });
  });
});
