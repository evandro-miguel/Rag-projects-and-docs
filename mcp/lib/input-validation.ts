/**
 * @module mcp/lib/input-validation
 * @description Input validation utilities for MCP tool handlers.
 *
 * Provides security validation for user-provided inputs to prevent:
 * - Injection attacks
 * - Buffer overflow via oversized inputs
 * - Invalid data types
 * - Malformed IDs and identifiers
 *
 * @example
 * import { validateString, validateId, validateEnum, validateNumber } from './lib/input-validation.js';
 *
 * // Validate a search query
 * const queryResult = validateString(args.query, 'query', { maxLength: 1000 });
 * if (!queryResult.valid) {
 *   return { content: [{ type: 'text', text: queryResult.error }], isError: true };
 * }
 */

/**
 * Result of input validation for string values.
 */
export type StringValidationResult =
  | { valid: true; value: string }
  | { valid: false; error: string };

/**
 * Result of input validation for number values.
 */
export type NumberValidationResult =
  | { valid: true; value: number }
  | { valid: false; error: string };

/**
 * Result of input validation for boolean values.
 */
export type BooleanValidationResult =
  | { valid: true; value: boolean }
  | { valid: false; error: string };

/**
 * Options for string validation.
 */
export interface StringValidationOptions {
  /** Maximum allowed length (default: 10000) */
  maxLength?: number;
  /** Minimum required length (default: 1) */
  minLength?: number;
  /** Whether to trim whitespace (default: true) */
  trim?: boolean;
  /** Whether to allow empty strings after trimming (default: false) */
  allowEmpty?: boolean;
  /** Custom pattern to match */
  pattern?: RegExp;
  /** Pattern description for error messages */
  patternDescription?: string;
}

/**
 * Options for number validation.
 */
export interface NumberValidationOptions {
  /** Minimum allowed value */
  min?: number;
  /** Maximum allowed value */
  max?: number;
  /** Whether to allow integers only */
  integerOnly?: boolean;
  /** Default value if undefined */
  defaultValue?: number;
}

/**
 * Validate a string input for security and correctness.
 *
 * Performs the following checks:
 * 1. Type check (must be string)
 * 2. Null byte injection check
 * 3. Length constraints
 * 4. Optional pattern matching
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @param options - Validation options
 * @returns StringValidationResult with validated string or error
 *
 * @example
 * const result = validateString(args.query, 'query', { maxLength: 1000 });
 * if (result.valid) {
 *   // Use result.value safely
 * }
 */
export function validateString(
  value: unknown,
  fieldName: string,
  options: StringValidationOptions = {}
): StringValidationResult {
  const {
    maxLength = 10000,
    minLength = 1,
    trim = true,
    allowEmpty = false,
    pattern,
    patternDescription,
  } = options;

  // Type check
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Invalid ${fieldName}: expected string, got ${typeof value}`,
    };
  }

  let processedValue = value;

  // Trim whitespace if enabled
  if (trim) {
    processedValue = processedValue.trim();
  }

  // Null byte injection check
  if (processedValue.includes('\0')) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: contains null bytes`,
    };
  }

  // Check for empty string
  if (!allowEmpty && processedValue.length === 0) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: cannot be empty`,
    };
  }

  // Length validation
  if (processedValue.length < minLength) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: minimum length is ${minLength} characters`,
    };
  }

  if (processedValue.length > maxLength) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: maximum length is ${maxLength} characters (got ${processedValue.length})`,
    };
  }

  // Pattern validation
  if (pattern && !pattern.test(processedValue)) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: ${patternDescription ?? 'does not match required format'}`,
    };
  }

  return { valid: true, value: processedValue };
}

/**
 * Validate a simple opaque document ID.
 *
 * Opaque IDs are strings that typically follow the pattern:
 * - Start with a letter or underscore
 * - Contain only alphanumeric characters, underscores, or hyphens
 * - Have a specific length based on the ID type
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @returns StringValidationResult with validated ID or error
 *
 * @example
 * const result = validateId(args.documentId, 'documentId');
 * if (result.valid) {
 *   // Use result.value as a valid opaque ID
 * }
 */
export function validateId(value: unknown, fieldName: string): StringValidationResult {
  // Type check
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Invalid ${fieldName}: expected string, got ${typeof value}`,
    };
  }

  const trimmedValue = value.trim();

  // Check for empty
  if (trimmedValue.length === 0) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: cannot be empty`,
    };
  }

  // Null byte check
  if (trimmedValue.includes('\0')) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: contains null bytes`,
    };
  }

  // Opaque ID format: alphanumeric with a small punctuation set.
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(trimmedValue)) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: must contain only alphanumeric characters, underscores, and hyphens`,
    };
  }

  // Reasonable length constraints
  if (trimmedValue.length > 128) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: ID too long (max 128 characters)`,
    };
  }

  return { valid: true, value: trimmedValue };
}

/**
 * Validate a tag slug.
 *
 * Tag slugs follow the format: "namespace:value" or just "value"
 * Example: "lang:typescript", "status:active", "react"
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @returns StringValidationResult with validated slug or error
 */
export function validateTagSlug(value: unknown, fieldName: string): StringValidationResult {
  // Type check
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Invalid ${fieldName}: expected string, got ${typeof value}`,
    };
  }

  const trimmedValue = value.trim();

  // Check for empty
  if (trimmedValue.length === 0) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: cannot be empty`,
    };
  }

  // Null byte check
  if (trimmedValue.includes('\0')) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: contains null bytes`,
    };
  }

  // Tag slug format: namespace:value or value
  // Allow letters, numbers, colons, hyphens, underscores
  const validSlugPattern = /^[a-zA-Z0-9:_-]+$/;
  if (!validSlugPattern.test(trimmedValue)) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: must contain only alphanumeric characters, colons, underscores, and hyphens`,
    };
  }

  // Length constraint
  if (trimmedValue.length > 128) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: slug too long (max 128 characters)`,
    };
  }

  return { valid: true, value: trimmedValue };
}

/**
 * Validate an enum value.
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @param allowedValues - Array of allowed values
 * @returns StringValidationResult with validated value or error
 *
 * @example
 * const result = validateEnum(args.rating, 'rating', ['positive', 'negative']);
 * if (result.valid) {
 *   // result.value is 'positive' or 'negative'
 * }
 */
export function validateEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[]
): StringValidationResult {
  // Type check
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Invalid ${fieldName}: expected string, got ${typeof value}`,
    };
  }

  const trimmedValue = value.trim();

  if (!allowedValues.includes(trimmedValue as T)) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: must be one of [${allowedValues.join(', ')}], got "${trimmedValue}"`,
    };
  }

  return { valid: true, value: trimmedValue };
}

/**
 * Validate a number input.
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @param options - Validation options
 * @returns NumberValidationResult with validated number or error
 *
 * @example
 * const result = validateNumber(args.limit, 'limit', { min: 1, max: 50, defaultValue: 10 });
 * if (result.valid) {
 *   // Use result.value
 * }
 */
export function validateNumber(
  value: unknown,
  fieldName: string,
  options: NumberValidationOptions = {}
): NumberValidationResult {
  const { min, max, integerOnly = false, defaultValue } = options;

  // Handle undefined/null with default
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) {
      return { valid: true, value: defaultValue };
    }
    return {
      valid: false,
      error: `Invalid ${fieldName}: value is required`,
    };
  }

  let numValue: number;

  // Type check
  if (typeof value === 'number') {
    numValue = value;
  } else if (typeof value === 'string') {
    // Try to parse string as number
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) {
      return {
        valid: false,
        error: `Invalid ${fieldName}: expected number, got "${value}"`,
      };
    }
    numValue = parsed;
  } else {
    return {
      valid: false,
      error: `Invalid ${fieldName}: expected number, got ${typeof value}`,
    };
  }

  // Integer check
  if (integerOnly && !Number.isInteger(numValue)) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: must be an integer`,
    };
  }

  // Range checks
  if (min !== undefined && numValue < min) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: minimum value is ${min}`,
    };
  }

  if (max !== undefined && numValue > max) {
    return {
      valid: false,
      error: `Invalid ${fieldName}: maximum value is ${max}`,
    };
  }

  return { valid: true, value: numValue };
}

/**
 * Validate a boolean input.
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field for error messages
 * @param defaultValue - Default value if undefined
 * @returns BooleanValidationResult with validated boolean or error
 */
export function validateBoolean(
  value: unknown,
  fieldName: string,
  defaultValue?: boolean
): BooleanValidationResult {
  // Handle undefined/null with default
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) {
      return { valid: true, value: defaultValue };
    }
    return {
      valid: false,
      error: `Invalid ${fieldName}: value is required`,
    };
  }

  // Type check
  if (typeof value === 'boolean') {
    return { valid: true, value };
  }

  // Accept string representations
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1') {
      return { valid: true, value: true };
    }
    if (lower === 'false' || lower === '0') {
      return { valid: true, value: false };
    }
  }

  return {
    valid: false,
    error: `Invalid ${fieldName}: expected boolean, got ${typeof value}`,
  };
}

/**
 * Create a security error response for MCP handlers.
 *
 * @param message - Error message
 * @returns MCP-formatted error response
 */
export function createSecurityErrorResponse(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: {
    success: false;
    error: { code: string; message: string; timestamp: string };
  };
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: `🚫 Security Error: ${message}`,
      },
    ],
    structuredContent: {
      success: false,
      error: {
        code: 'SECURITY_ERROR',
        message: `🚫 Security Error: ${message}`,
        timestamp: new Date().toISOString(),
      },
    },
    isError: true,
  };
}

/**
 * Valid entity types for tag operations.
 */
export const VALID_ENTITY_TYPES = ['document', 'chunk', 'symbol'] as const;

/**
 * Valid rating values.
 */
export const VALID_RATINGS = ['positive', 'negative'] as const;

/**
 * Valid adaptation contexts.
 */
export const VALID_CONTEXTS = [
  'code-focused',
  'architecture',
  'beginner',
  'senior',
  'quick-ref',
] as const;
