/**
 * @module store-row-utils
 * @description Coercion helpers and row mappers shared by store.ts and store-read-models.ts.
 *
 * These utilities parse raw database rows into domain-safe values.
 * Moving them here avoids runtime circularity between store.ts and
 * store-read-models.ts after the read-model function extraction.
 */

import type {
  ProjectRagPostgresChunk,
  ProjectRagPostgresFile,
  ProjectRagPostgresReference,
  ProjectRagPostgresSymbol,
} from './store.js';

/**
 * Parse an unknown database field into a number, defaulting to 0.
 * Handles string digits and NaN gracefully.
 */
export function numberField(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Parse an unknown database field into a number | undefined.
 * Returns undefined only when the value is truly nullish; 0 parses as 0.
 */
export function optionalNumberField(value: unknown): number | undefined {
  const parsed = numberField(value);
  return parsed === 0 && value == null ? undefined : parsed;
}

/**
 * Parse an unknown database field into a string, defaulting to ''.
 */
export function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Map a raw database row into a ProjectRagPostgresFile record.
 */
export function fileFromRow(row: Record<string, unknown>): ProjectRagPostgresFile {
  return {
    id: numberField(row.id),
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
    lang: typeof row.lang === 'string' ? row.lang : undefined,
    status: typeof row.status === 'string' ? row.status : 'unknown',
    lineCount: optionalNumberField(row.lineCount),
    sizeBytes: numberField(row.sizeBytes),
    metadataQuality: typeof row.metadataQuality === 'string' ? row.metadataQuality : 'minimal',
    skeletonText: typeof row.skeletonText === 'string' ? row.skeletonText : undefined,
    outlineVersion: typeof row.outlineVersion === 'string' ? row.outlineVersion : undefined,
    updatedAt: optionalNumberField(row.updatedAt),
  };
}

/**
 * Map a raw database row into a ProjectRagPostgresChunk record.
 */
export function chunkFromRow(row: Record<string, unknown>): ProjectRagPostgresChunk {
  return {
    id: numberField(row.id),
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : undefined,
    chunkIndex: numberField(row.chunkIndex),
    startLine: optionalNumberField(row.startLine),
    endLine: optionalNumberField(row.endLine),
    symbolName: typeof row.symbolName === 'string' ? row.symbolName : undefined,
    symbolKind: typeof row.symbolKind === 'string' ? row.symbolKind : undefined,
    content: typeof row.content === 'string' ? row.content : '',
  };
}

/**
 * Map a raw database row into a ProjectRagPostgresSymbol record.
 */
export function symbolFromRow(row: Record<string, unknown>): ProjectRagPostgresSymbol {
  return {
    id: numberField(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    symbolType: typeof row.symbolType === 'string' ? row.symbolType : '',
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : '',
    fileId: numberField(row.fileId),
    startLine: optionalNumberField(row.startLine),
    endLine: optionalNumberField(row.endLine),
    signature: typeof row.signature === 'string' ? row.signature : undefined,
    exportType: typeof row.exportType === 'string' ? row.exportType : undefined,
    confidence: optionalNumberField(row.confidence),
  };
}

/**
 * Map a raw database row into a ProjectRagPostgresReference record.
 */
export function referenceFromRow(row: Record<string, unknown>): ProjectRagPostgresReference {
  return {
    id: numberField(row.id),
    relationType: typeof row.relationType === 'string' ? row.relationType : '',
    sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : undefined,
    targetPath: typeof row.targetPath === 'string' ? row.targetPath : undefined,
    startLine: optionalNumberField(row.startLine),
    endLine: optionalNumberField(row.endLine),
    sourceFileId: optionalNumberField(row.sourceFileId),
    sourceRef: typeof row.sourceRef === 'string' ? row.sourceRef : undefined,
    targetFileId: optionalNumberField(row.targetFileId),
    targetRef: typeof row.targetRef === 'string' ? row.targetRef : undefined,
    confidence: optionalNumberField(row.confidence),
  };
}
