/**
 * Shared Logger Utility for RAG-v1
 *
 * Structured logging with operation context and correlation IDs.
 * No external dependencies - uses native console underneath.
 */

export type Operation = 'ingest' | 'search' | 'sync' | 'mcp' | 'http' | 'ensure_reranker';

export interface LogContext {
  operation: Operation;
  correlationId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string, error?: Error): void;
}

function writeToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Format a log entry with structured output
 * Format: [LEVEL] [operation] [correlationId?] message {additionalContext}
 */
function formatLogEntry(
  level: string,
  context: LogContext,
  message: string,
  error?: Error
): string {
  const timestamp = new Date().toISOString();
  const { operation, correlationId, ...additionalContext } = context;

  const parts = [`[${timestamp}]`, `[${level.toUpperCase()}]`, `[${operation}]`];

  if (correlationId) {
    parts.push(`[${correlationId}]`);
  }

  parts.push(message);

  const hasAdditionalContext = Object.keys(additionalContext).length > 0;
  const hasError = error !== undefined;

  if (hasAdditionalContext || hasError) {
    const contextObj: Record<string, unknown> = { ...additionalContext };
    if (error) {
      contextObj.error = error.message;
      contextObj.stack = error.stack;
    }
    parts.push(JSON.stringify(contextObj));
  }

  return parts.join(' ');
}

class LoggerImpl implements Logger {
  debug(context: LogContext, message: string): void {
    writeToStderr(formatLogEntry('debug', context, message));
  }

  info(context: LogContext, message: string): void {
    writeToStderr(formatLogEntry('info', context, message));
  }

  warn(context: LogContext, message: string): void {
    writeToStderr(formatLogEntry('warn', context, message));
  }

  error(context: LogContext, message: string, error?: Error): void {
    writeToStderr(formatLogEntry('error', context, message, error));
  }
}

/**
 * Singleton logger instance for use across the codebase
 */
export const logger: Logger = new LoggerImpl();
