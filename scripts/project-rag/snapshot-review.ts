import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const TOKEN_PARTS = 3;
const MAX_REVIEWER_ID_LENGTH = 128;
const MAX_EVIDENCE_ID_LENGTH = 128;
const MAX_COMMAND_SCOPE_LENGTH = 128;
const MAX_REASON_LENGTH = 1024;
const MAX_REVIEW_TTL_SECONDS = 86_400;
const REVIEWER_CAPABILITY = 'high-trust-write';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
);

export interface SnapshotReviewTokenPayload {
  readonly snapshotUuid: string;
  readonly projectId: number;
  readonly commandScope: string;
  readonly reviewerId: string;
  readonly capability: typeof REVIEWER_CAPABILITY;
  readonly evidenceId: string;
  readonly reason: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const QUALIFIED_REVIEWER_CAPABILITY = REVIEWER_CAPABILITY;

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function assertBoundedId(name: string, value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Snapshot review token has invalid ${name}`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Snapshot review token has invalid ${name}`);
  }
}

function assertBoundedText(
  name: string,
  value: unknown,
  maxLength: number
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Snapshot review token has invalid ${name}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw new Error(`Snapshot review token has invalid ${name}`);
  }
}

function validatePayload(
  payload: unknown,
  nowSeconds: number,
  requireLive: boolean
): SnapshotReviewTokenPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Snapshot review token payload is not an object');
  }

  const candidate = payload as Record<string, unknown>;
  const expectedKeys = [
    'snapshotUuid',
    'projectId',
    'commandScope',
    'reviewerId',
    'capability',
    'evidenceId',
    'reason',
    'issuedAt',
    'expiresAt',
  ];
  const actualKeys = Object.keys(candidate).sort();
  const sortedExpectedKeys = expectedKeys.sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error('Snapshot review token payload has unexpected fields');
  }

  if (typeof candidate.snapshotUuid !== 'string' || !UUID_PATTERN.test(candidate.snapshotUuid)) {
    throw new Error('Snapshot review token has invalid snapshotUuid');
  }
  if (!Number.isSafeInteger(candidate.projectId) || (candidate.projectId as number) <= 0) {
    throw new Error('Snapshot review token has invalid projectId');
  }
  assertBoundedText('commandScope', candidate.commandScope, MAX_COMMAND_SCOPE_LENGTH);
  assertBoundedId('reviewerId', candidate.reviewerId, MAX_REVIEWER_ID_LENGTH);
  assertBoundedId('evidenceId', candidate.evidenceId, MAX_EVIDENCE_ID_LENGTH);
  assertBoundedText('reason', candidate.reason, MAX_REASON_LENGTH);
  if (candidate.capability !== REVIEWER_CAPABILITY) {
    throw new Error('Snapshot review token does not carry the qualified reviewer capability');
  }
  if (!Number.isSafeInteger(candidate.issuedAt) || !Number.isSafeInteger(candidate.expiresAt)) {
    throw new Error('Snapshot review token has invalid timestamps');
  }
  if (
    (candidate as { expiresAt: number }).expiresAt <= (candidate as { issuedAt: number }).issuedAt
  ) {
    throw new Error('Snapshot review token expires before it is issued');
  }
  if (
    (candidate as { expiresAt: number }).expiresAt - (candidate as { issuedAt: number }).issuedAt >
    MAX_REVIEW_TTL_SECONDS
  ) {
    throw new Error('Snapshot review token TTL exceeds the allowed maximum');
  }
  if (requireLive && (candidate as { expiresAt: number }).expiresAt <= nowSeconds) {
    throw new Error('Snapshot review token has expired');
  }
  if ((candidate as { issuedAt: number }).issuedAt > nowSeconds + 60) {
    throw new Error('Snapshot review token is issued in the future');
  }

  return {
    snapshotUuid: candidate.snapshotUuid,
    projectId: candidate.projectId as number,
    commandScope: candidate.commandScope as string,
    reviewerId: candidate.reviewerId as string,
    capability: REVIEWER_CAPABILITY,
    evidenceId: candidate.evidenceId as string,
    reason: candidate.reason as string,
    issuedAt: candidate.issuedAt as number,
    expiresAt: candidate.expiresAt as number,
  };
}

function resolveSigningKey(signingKey: string | undefined): Buffer {
  const normalized = signingKey?.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') < 32) {
    throw new Error(
      'PROJECT_RAG_SNAPSHOT_REVIEW_SIGNING_KEY must be configured with at least 32 bytes'
    );
  }
  return Buffer.from(normalized, 'utf8');
}

function signatureFor(unsignedToken: string, signingKey: Buffer): Buffer {
  return createHmac('sha256', signingKey).update(unsignedToken, 'utf8').digest();
}

/**
 * Create a signed review token for a trusted authority or test fixture.
 * Production approval callers should receive this token from that authority;
 * the ingest CLI only verifies it and never self-issues one.
 */
export function createSnapshotReviewToken(
  payload: SnapshotReviewTokenPayload,
  signingKey: string
): string {
  const validated = validatePayload(payload, Math.floor(Date.now() / 1000), false);
  const payloadPart = encodeBase64Url(JSON.stringify(validated));
  const unsignedToken = `${TOKEN_VERSION}.${payloadPart}`;
  const signaturePart = encodeBase64Url(signatureFor(unsignedToken, resolveSigningKey(signingKey)));
  return `${unsignedToken}.${signaturePart}`;
}

/** Verify a signed, live, high-trust snapshot review token. */
export function verifySnapshotReviewToken(
  token: string,
  signingKey: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): SnapshotReviewTokenPayload {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Snapshot review token is required');
  }
  const parts = token.split('.');
  if (parts.length !== TOKEN_PARTS || parts[0] !== TOKEN_VERSION) {
    throw new Error('Snapshot review token has an invalid format');
  }

  const unsignedToken = `${parts[0]}.${parts[1]}`;
  let providedSignature: Buffer;
  let payload: unknown;
  try {
    providedSignature = Buffer.from(parts[2], 'base64url');
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw new Error('Snapshot review token is malformed');
  }

  const expectedSignature = signatureFor(unsignedToken, resolveSigningKey(signingKey));
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new Error('Snapshot review token signature is invalid');
  }

  return validatePayload(payload, nowSeconds, true);
}

export function snapshotReviewTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
