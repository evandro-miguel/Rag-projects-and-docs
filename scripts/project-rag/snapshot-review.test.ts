import { describe, expect, it } from 'vitest';
import {
  createSnapshotReviewToken,
  QUALIFIED_REVIEWER_CAPABILITY,
  type SnapshotReviewTokenPayload,
  verifySnapshotReviewToken,
} from './snapshot-review.js';

const SIGNING_KEY = 'snapshot-review-test-key-with-at-least-32-bytes';
const SNAPSHOT_UUID = 'e4353cc3-d12d-4a57-af28-75ec3392fd92';

function payload(overrides: Partial<SnapshotReviewTokenPayload> = {}): SnapshotReviewTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    snapshotUuid: SNAPSHOT_UUID,
    projectId: 2329,
    commandScope: 'full',
    reviewerId: 'qualified-reviewer-fixture',
    capability: QUALIFIED_REVIEWER_CAPABILITY,
    evidenceId: 'E-review-fixture-01',
    reason: 'Reviewed the exact current inventory and approved the bounded reconciliation.',
    issuedAt: now - 1,
    expiresAt: now + 300,
    ...overrides,
  };
}

describe('snapshot review token policy', () => {
  it('round-trips a signed high-trust token', () => {
    const token = createSnapshotReviewToken(payload(), SIGNING_KEY);
    expect(verifySnapshotReviewToken(token, SIGNING_KEY)).toMatchObject(payload());
  });

  it('rejects a token signed with a different key', () => {
    const token = createSnapshotReviewToken(payload(), SIGNING_KEY);
    expect(() => verifySnapshotReviewToken(token, 'different-key-with-at-least-32-bytes')).toThrow(
      'signature is invalid'
    );
  });

  it('rejects tampering and expired tokens', () => {
    const token = createSnapshotReviewToken(payload(), SIGNING_KEY);
    const [version, _encodedPayload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify(payload({ reason: 'tampered' })),
      'utf8'
    ).toString('base64url');
    expect(() =>
      verifySnapshotReviewToken(`${version}.${tamperedPayload}.${signature}`, SIGNING_KEY)
    ).toThrow('signature is invalid');

    const expired = createSnapshotReviewToken(
      payload({ issuedAt: 100, expiresAt: 200 }),
      SIGNING_KEY
    );
    expect(() => verifySnapshotReviewToken(expired, SIGNING_KEY, 201)).toThrow('has expired');
  });

  it('rejects weaker reviewer capability and oversized TTL', () => {
    expect(() =>
      createSnapshotReviewToken(
        payload({ capability: 'read' as SnapshotReviewTokenPayload['capability'] }),
        SIGNING_KEY
      )
    ).toThrow('qualified reviewer capability');

    expect(() =>
      createSnapshotReviewToken(payload({ expiresAt: payload().issuedAt + 86_401 }), SIGNING_KEY)
    ).toThrow('TTL exceeds');
  });

  it('requires a sufficiently strong signing key without revealing it', () => {
    expect(() => createSnapshotReviewToken(payload(), 'short')).toThrow(
      'must be configured with at least 32 bytes'
    );
    const encodedEmptyPayload = Buffer.from('{}', 'utf8').toString('base64url');
    const encodedSignature = Buffer.from('signature', 'utf8').toString('base64url');
    expect(() =>
      verifySnapshotReviewToken(`v1.${encodedEmptyPayload}.${encodedSignature}`, undefined)
    ).toThrow('must be configured with at least 32 bytes');
  });
});
