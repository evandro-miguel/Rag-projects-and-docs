/**
 * Tests for lib/logger.ts
 *
 * Covers:
 * - logger.debug(context, message) outputs with DEBUG level
 * - logger.info(context, message) outputs with INFO level
 * - logger.warn(context, message) outputs with WARN level
 * - logger.error(context, message, error?) outputs with ERROR level
 * - Output format includes timestamp, level, operation, correlationId
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LogContext, logger, type Operation } from '../logger.js';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const baseContext: LogContext = {
    operation: 'test' as Operation,
    correlationId: 'test-123',
  };

  describe('logger.debug()', () => {
    it('outputs message with DEBUG level', () => {
      logger.debug(baseContext, 'Debug message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[DEBUG]');
      expect(output).toContain('[test]');
      expect(output).toContain('Debug message');
    });

    it('includes timestamp in output', () => {
      logger.debug(baseContext, 'Timestamped message');

      const output = String(stderrSpy.mock.calls[0][0]);
      // ISO timestamp format: YYYY-MM-DDTHH:mm:ss.sssZ
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?\]/);
    });

    it('includes correlationId when provided', () => {
      logger.debug(baseContext, 'With correlation ID');

      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[test-123]');
    });

    it('excludes correlationId when not provided', () => {
      const contextWithoutId: LogContext = { operation: 'test' as Operation };
      logger.debug(contextWithoutId, 'Without correlation ID');

      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).not.toContain('undefined');
      expect(output).toContain('[test]');
    });

    it('includes additional context properties', () => {
      const context: LogContext = {
        ...baseContext,
        userId: 'user-456',
        requestId: 'req-789',
      };
      logger.debug(context, 'With extra context');

      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('userId');
      expect(output).toContain('user-456');
      expect(output).toContain('requestId');
      expect(output).toContain('req-789');
    });
  });

  describe('logger.info()', () => {
    it('outputs message with INFO level', () => {
      logger.info(baseContext, 'Info message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[INFO]');
      expect(output).toContain('[test]');
      expect(output).toContain('Info message');
    });

    it('writes info logs to stderr', () => {
      logger.info(baseContext, 'stderr info test');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('logger.warn()', () => {
    it('outputs message with WARN level', () => {
      logger.warn(baseContext, 'Warning message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[WARN]');
      expect(output).toContain('[test]');
      expect(output).toContain('Warning message');
    });

    it('writes warn logs to stderr', () => {
      logger.warn(baseContext, 'stderr warn test');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('logger.error()', () => {
    it('outputs message with ERROR level', () => {
      logger.error(baseContext, 'Error message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[ERROR]');
      expect(output).toContain('[test]');
      expect(output).toContain('Error message');
    });

    it('includes error message when Error is provided', () => {
      const testError = new Error('Test error details');
      logger.error(baseContext, 'Operation failed', testError);

      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('Test error details');
    });

    it('includes error stack trace when Error is provided', () => {
      const testError = new Error('Stack trace test');
      logger.error(baseContext, 'With stack', testError);

      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('stack');
    });

    it('writes error logs to stderr', () => {
      logger.error(baseContext, 'stderr error test');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it('works without Error parameter', () => {
      logger.error(baseContext, 'Simple error message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = String(stderrSpy.mock.calls[0][0]);
      expect(output).toContain('[ERROR]');
      expect(output).toContain('Simple error message');
    });
  });

  describe('Output format', () => {
    it('formats log with all expected components', () => {
      const context: LogContext = {
        operation: 'ingest' as Operation,
        correlationId: 'abc-123-xyz',
        documentId: 'doc-456',
        source: 'test-source',
      };

      logger.info(context, 'Document processed');

      const output = String(stderrSpy.mock.calls[0][0]);

      // Check format: [timestamp] [LEVEL] [operation] [correlationId] message {context}
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // timestamp
      expect(output).toContain('[INFO]'); // level
      expect(output).toContain('[ingest]'); // operation
      expect(output).toContain('[abc-123-xyz]'); // correlationId
      expect(output).toContain('Document processed'); // message
      expect(output).toContain('documentId'); // additional context
      expect(output).toContain('doc-456');
      expect(output).toContain('source');
      expect(output).toContain('test-source');
    });

    it('maintains consistent format across all log levels', () => {
      const message = 'Consistent format test';

      logger.debug(baseContext, message);
      logger.info(baseContext, message);
      logger.warn(baseContext, message);
      logger.error(baseContext, message);

      const debugOutput = String(stderrSpy.mock.calls[0][0]);
      const infoOutput = String(stderrSpy.mock.calls[1][0]);
      const warnOutput = String(stderrSpy.mock.calls[2][0]);
      const errorOutput = String(stderrSpy.mock.calls[3][0]);

      // All should contain timestamp, operation, correlationId, and message
      const outputs = [debugOutput, infoOutput, warnOutput, errorOutput];
      for (const output of outputs) {
        expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(output).toContain('[test]');
        expect(output).toContain('[test-123]');
        expect(output).toContain(message);
      }

      // Each should have their respective level
      expect(debugOutput).toContain('[DEBUG]');
      expect(infoOutput).toContain('[INFO]');
      expect(warnOutput).toContain('[WARN]');
      expect(errorOutput).toContain('[ERROR]');
    });

    it('formats context as JSON object', () => {
      const context: LogContext = {
        operation: 'search' as Operation,
        query: 'test query',
        limit: 10,
      };

      logger.info(context, 'Search executed');

      const output = String(stderrSpy.mock.calls[0][0]);
      // Context should be JSON stringified at the end
      expect(output).toContain('{"query":"test query","limit":10}');
    });
  });

  describe('Different operations', () => {
    it('handles all valid operation types', () => {
      const operations: Operation[] = ['ingest', 'search', 'sync', 'mcp', 'http'];

      for (const op of operations) {
        const context: LogContext = { operation: op };
        logger.info(context, `Operation: ${op}`);
      }

      expect(stderrSpy).toHaveBeenCalledTimes(5);

      // Verify each operation is logged correctly
      const calls = stderrSpy.mock.calls.map((call: [unknown, ...unknown[]]) => String(call[0]));

      expect(calls[0]).toContain('[ingest]');
      expect(calls[1]).toContain('[search]');
      expect(calls[2]).toContain('[sync]');
      expect(calls[3]).toContain('[mcp]');
      expect(calls[4]).toContain('[http]');
    });
  });
});
