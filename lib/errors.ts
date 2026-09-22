/**
 * RAG Error Type Hierarchy
 *
 * Provides structured error handling across MCP, HTTP, and script layers.
 * Each error includes a code, context, and optional cause for debugging.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_API_KEY'
  | 'SERVICE_UNAVAILABLE';

export interface RAGErrorContext {
  operation: string;
  correlationId?: string;
  [key: string]: unknown;
}

/**
 * Base error class for all RAG-related errors.
 * Provides structured error information with codes, context, and cause chaining.
 */
export class RAGError extends Error {
  readonly code: ErrorCode;
  readonly context: RAGErrorContext;
  readonly cause?: Error;

  constructor(code: ErrorCode, message: string, context: RAGErrorContext, cause?: Error) {
    super(message);
    this.name = 'RAGError';
    this.code = code;
    this.context = context;
    this.cause = cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): { code: string; message: string; context: RAGErrorContext } {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Error for input validation failures.
 * Use when request data fails validation rules.
 */
export class ValidationError extends RAGError {
  constructor(message: string, context: RAGErrorContext, cause?: Error) {
    super('VALIDATION_ERROR', message, context, cause);
    this.name = 'ValidationError';
  }
}

/**
 * Error for resource not found scenarios.
 * Use when a requested resource does not exist.
 */
export class NotFoundError extends RAGError {
  constructor(message: string, context: RAGErrorContext, cause?: Error) {
    super('NOT_FOUND', message, context, cause);
    this.name = 'NotFoundError';
  }
}

/**
 * Error for rate limiting scenarios.
 * Includes optional retryAfter in context for client guidance.
 */
export class RateLimitError extends RAGError {
  constructor(message: string, context: RAGErrorContext & { retryAfter?: number }, cause?: Error) {
    super('RATE_LIMITED', message, context, cause);
    this.name = 'RateLimitError';
  }
}

/**
 * Error for internal server errors.
 * Use for unexpected errors that don't fit other categories.
 */
export class InternalError extends RAGError {
  constructor(message: string, context: RAGErrorContext, cause?: Error) {
    super('INTERNAL_ERROR', message, context, cause);
    this.name = 'InternalError';
  }
}
