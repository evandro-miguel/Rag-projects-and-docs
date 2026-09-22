import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type McpOutputSchema = NonNullable<Tool['outputSchema']>;

export interface McpOutputValidationLimits {
  readonly maxResponseBytes: number;
  readonly maxArrayItems: number;
  readonly maxStringChars: number;
  readonly maxDepth: number;
  readonly maxLine: number;
  readonly maxCursorChars: number;
}

export const DEFAULT_MCP_OUTPUT_LIMITS: McpOutputValidationLimits = {
  maxResponseBytes: 1_048_576,
  maxArrayItems: 100,
  maxStringChars: 200_000,
  maxDepth: 24,
  maxLine: 10_000_000,
  maxCursorChars: 256,
};

export class McpOutputValidationError extends Error {
  readonly code = 'INVALID_OUTPUT';

  constructor(
    readonly toolName: string,
    readonly path: string,
    message: string
  ) {
    super(`INVALID_OUTPUT: ${toolName} ${path} ${message}`);
    this.name = 'McpOutputValidationError';
  }
}

function fail(toolName: string, path: string, message: string): never {
  throw new McpOutputValidationError(toolName, path, message);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Match JSON serialization at the MCP result boundary. Object properties with
 * undefined values are omitted; undefined array entries become null. This
 * keeps runtime schema validation aligned with the payload sent on the wire.
 */
function normalizeUndefinedProperties(
  value: unknown,
  seen = new WeakMap<object, object>()
): unknown {
  if (value === undefined || value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    seen.set(value, normalized);
    for (const entry of value) {
      normalized.push(entry === undefined ? null : normalizeUndefinedProperties(entry, seen));
    }
    return normalized;
  }

  const normalized = Object.create(null) as Record<string, unknown>;
  seen.set(value, normalized);
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      normalized[key] = normalizeUndefinedProperties(entry, seen);
    }
  }
  return normalized;
}

function validateLineRange(
  toolName: string,
  value: Record<string, unknown>,
  path: string,
  limits: McpOutputValidationLimits
): void {
  const lineValues = new Map<string, number>();
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (
      normalized === 'startline' ||
      normalized === 'endline' ||
      normalized === 'linestart' ||
      normalized === 'lineend'
    ) {
      if (
        typeof raw !== 'number' ||
        !Number.isSafeInteger(raw) ||
        raw < 1 ||
        raw > limits.maxLine
      ) {
        fail(toolName, `${path}.${key}`, `must be an integer between 1 and ${limits.maxLine}`);
      }
      lineValues.set(normalized, raw);
    }
  }

  const start = lineValues.get('startline') ?? lineValues.get('linestart');
  const end = lineValues.get('endline') ?? lineValues.get('lineend');
  if (start !== undefined && end !== undefined && end < start) {
    fail(toolName, path, 'line range end must not precede start');
  }
}

function validateBoundedValue(
  toolName: string,
  value: unknown,
  path: string,
  depth: number,
  limits: McpOutputValidationLimits,
  seen: WeakSet<object>
): void {
  if (depth > limits.maxDepth) {
    fail(toolName, path, `exceeds maximum depth ${limits.maxDepth}`);
  }

  if (typeof value === 'string') {
    if (value.length > limits.maxStringChars) {
      fail(toolName, path, `exceeds maximum length ${limits.maxStringChars}`);
    }
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(toolName, path, 'must be finite');
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    fail(toolName, path, 'must not contain circular references');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) {
      fail(toolName, path, `contains more than ${limits.maxArrayItems} items`);
    }
    value.forEach((entry, index) => {
      validateBoundedValue(toolName, entry, `${path}[${index}]`, depth + 1, limits, seen);
    });
  } else {
    const record = value as Record<string, unknown>;
    validateLineRange(toolName, record, path, limits);
    for (const [key, entry] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (lower.includes('cursor') && typeof entry === 'string') {
        if (entry.length > limits.maxCursorChars) {
          fail(toolName, `${path}.${key}`, `exceeds cursor length ${limits.maxCursorChars}`);
        }
      }
      if ((lower === 'page' || lower === 'offset') && entry !== undefined) {
        if (
          typeof entry !== 'number' ||
          !Number.isSafeInteger(entry) ||
          entry < 0 ||
          entry > limits.maxArrayItems * limits.maxArrayItems
        ) {
          fail(toolName, `${path}.${key}`, 'must be a bounded non-negative integer');
        }
      }
      validateBoundedValue(toolName, entry, `${path}.${key}`, depth + 1, limits, seen);
    }
  }

  seen.delete(value);
}

function validateJsonSchema(
  toolName: string,
  value: unknown,
  schema: Record<string, unknown>,
  path: string
): void {
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      try {
        validateJsonSchema(toolName, value, candidate as Record<string, unknown>, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!matches) fail(toolName, path, 'does not match any output variant');
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateJsonSchema(toolName, value, candidate as Record<string, unknown>, path);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length === 0) fail(toolName, path, 'does not match any output variant');
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    fail(toolName, path, 'contains a value outside the declared enum');
  }

  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(toolName, path, 'must be an object');
    }
    const record = value as Record<string, unknown>;
    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!(required in record)) fail(toolName, `${path}.${required}`, 'is required');
    }
    const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) {
        validateJsonSchema(
          toolName,
          record[key],
          childSchema as Record<string, unknown>,
          `${path}.${key}`
        );
      }
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) fail(toolName, path, 'must be an array');
    if (schema.items && Array.isArray(value)) {
      value.forEach((entry, index) => {
        validateJsonSchema(
          toolName,
          entry,
          schema.items as Record<string, unknown>,
          `${path}[${index}]`
        );
      });
    }
    return;
  }

  const valid =
    type === undefined ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'null' && value === null);
  if (!valid) fail(toolName, path, `must have type ${String(type)}`);
}

export function validateStructuredOutput(
  toolName: string,
  structuredContent: unknown,
  outputSchema?: McpOutputSchema,
  limits: McpOutputValidationLimits = DEFAULT_MCP_OUTPUT_LIMITS
): Record<string, unknown> {
  const normalizedStructuredContent = normalizeUndefinedProperties(structuredContent);
  if (
    normalizedStructuredContent === null ||
    typeof normalizedStructuredContent !== 'object' ||
    Array.isArray(normalizedStructuredContent)
  ) {
    fail(toolName, 'structuredContent', 'must be an object');
  }
  const record = normalizedStructuredContent as Record<string, unknown>;
  if ('success' in record && typeof record.success !== 'boolean') {
    fail(toolName, 'structuredContent.success', 'must be a boolean');
  }
  if (
    'error' in record &&
    (record.error === null || typeof record.error !== 'object' || Array.isArray(record.error))
  ) {
    fail(toolName, 'structuredContent.error', 'must be an object');
  }
  validateBoundedValue(toolName, record, 'structuredContent', 0, limits, new WeakSet<object>());
  if (outputSchema) {
    const schema = outputSchema as unknown as Record<string, unknown>;
    validateJsonSchema(toolName, record, schema, 'structuredContent');
  }
  if (byteLength(record) > limits.maxResponseBytes) {
    fail(toolName, 'structuredContent', `exceeds response limit ${limits.maxResponseBytes} bytes`);
  }
  return record;
}

export function validateMcpToolResult(
  toolName: string,
  result: unknown,
  outputSchema?: McpOutputSchema,
  limits: McpOutputValidationLimits = DEFAULT_MCP_OUTPUT_LIMITS
): CallToolResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    fail(toolName, 'result', 'must be an MCP result object');
  }
  const candidate = result as CallToolResult;
  if (!Array.isArray(candidate.content)) {
    fail(toolName, 'result.content', 'must be an array');
  }
  for (const [index, block] of candidate.content.entries()) {
    if (
      block === null ||
      typeof block !== 'object' ||
      typeof (block as { type?: unknown }).type !== 'string'
    ) {
      fail(toolName, `result.content[${index}]`, 'must be a content block with a type');
    }
  }
  if (candidate.isError !== undefined && typeof candidate.isError !== 'boolean') {
    fail(toolName, 'result.isError', 'must be a boolean');
  }
  let normalizedStructuredContent: Record<string, unknown> | undefined;
  if (candidate.structuredContent !== undefined) {
    normalizedStructuredContent = validateStructuredOutput(
      toolName,
      candidate.structuredContent,
      outputSchema,
      limits
    );
  } else if (candidate.isError === true) {
    fail(toolName, 'result.structuredContent', 'is required for error results');
  }
  validateBoundedValue(
    toolName,
    candidate.content,
    'result.content',
    0,
    limits,
    new WeakSet<object>()
  );
  const normalizedCandidate =
    normalizedStructuredContent === undefined
      ? candidate
      : { ...candidate, structuredContent: normalizedStructuredContent };
  if (byteLength(normalizedCandidate) > limits.maxResponseBytes) {
    fail(toolName, 'result', `exceeds response limit ${limits.maxResponseBytes} bytes`);
  }
  return normalizedCandidate;
}
