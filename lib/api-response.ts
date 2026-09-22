/**
 * Standardized API Response Utilities
 *
 * Provides consistent response formats across HTTP and MCP endpoints.
 * All responses follow a unified structure with success/error states.
 *
 * @module lib/api-response
 */

import type { RAGError } from './errors.js';

/**
 * Standard API response shape for all endpoints.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Error codes with their corresponding HTTP status codes.
 */
export const ERROR_STATUS_MAP: Record<string, number> = {
  // Client errors
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INVALID_API_KEY: 401,

  // Server errors
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * Create a successful API response.
 *
 * @param data - The response data
 * @returns Standardized success response
 */
export function success<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/**
 * Create an error API response.
 *
 * @param code - Error code (e.g., 'VALIDATION_ERROR', 'NOT_FOUND')
 * @param message - Human-readable error message
 * @param details - Optional additional error details
 * @returns Standardized error response
 */
export function error(code: string, message: string, details?: unknown): ApiResponse<never> {
  return { success: false, error: { code, message, details } };
}

/**
 * Convert a RAGError to a standardized API response.
 *
 * @param err - The RAGError instance
 * @returns Standardized error response
 */
export function fromRAGError(err: RAGError): ApiResponse<never> {
  return error(err.code, err.message, err.context);
}

/**
 * Get the HTTP status code for an error code.
 *
 * @param errorCode - The error code to look up
 * @returns HTTP status code (defaults to 500 for unknown codes)
 */
export function toHttpStatus(errorCode: string): number {
  return ERROR_STATUS_MAP[errorCode] ?? 500;
}

/**
 * Create a JSON Response with standard headers.
 *
 * @param body - Response body (will be JSON stringified)
 * @param status - HTTP status code
 * @param request - Optional request for CORS headers
 * @returns Response object with JSON content type
 */
export function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders,
  };

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

/**
 * Create a rate limit exceeded response with Retry-After header.
 *
 * @param retryAfter - Seconds until rate limit resets
 * @param corsHeaders - Optional CORS headers
 * @returns 429 Response with Retry-After header
 */
export function rateLimitResponse(
  retryAfter: number,
  corsHeaders?: Record<string, string>
): Response {
  const body = error('RATE_LIMITED', `Rate limit exceeded. Try again in ${retryAfter} seconds.`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
    ...corsHeaders,
  };

  return new Response(JSON.stringify(body), {
    status: 429,
    headers,
  });
}
