import { describe, expect, it } from 'vitest';
import {
  getSnapshotReviewUsage,
  parseSnapshotReviewArgs,
  runSnapshotReviewCli,
} from './review-snapshot.js';

const SNAPSHOT_UUID = 'e4353cc3-d12d-4a57-af28-75ec3392fd92';

describe('snapshot review CLI boundary', () => {
  it('parses inspect and approval as explicit actions', () => {
    expect(parseSnapshotReviewArgs(['--snapshot', SNAPSHOT_UUID, '--inspect'])).toMatchObject({
      help: false,
      inspect: true,
      approve: false,
      snapshotUuid: SNAPSHOT_UUID,
    });
    expect(parseSnapshotReviewArgs(['--snapshot', SNAPSHOT_UUID, '--approve'])).toMatchObject({
      help: false,
      inspect: false,
      approve: true,
      snapshotUuid: SNAPSHOT_UUID,
    });
  });

  it('refuses implicit approval and conflicting actions', async () => {
    await expect(runSnapshotReviewCli(['--snapshot', SNAPSHOT_UUID])).rejects.toThrow(
      'Choose an explicit action'
    );
    await expect(
      runSnapshotReviewCli(['--snapshot', SNAPSHOT_UUID, '--inspect', '--approve'])
    ).rejects.toThrow('Choose exactly one action');
  });

  it('rejects caller-controlled runtime environment overrides', async () => {
    await expect(
      runSnapshotReviewCli(['--snapshot', SNAPSHOT_UUID, '--approve', '--token', 'signed-token'], {
        PROJECT_RAG_SNAPSHOT_OPERATOR_RUNTIME_SOCKET: '/tmp/attacker.sock',
      })
    ).rejects.toThrow('environment overrides are forbidden');
  });

  it('documents the explicit action and authenticated runtime boundary', () => {
    expect(getSnapshotReviewUsage()).toContain(
      '--inspect | --audit | --resume | --approve --token <signed-token>'
    );
    expect(getSnapshotReviewUsage()).toContain('configured Unix-socket operator runtime');
  });
});
