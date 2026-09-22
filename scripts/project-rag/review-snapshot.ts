import {
  resolveProjectRagPostgresConfigWithLocalDefault,
  resolveProjectRagPostgresWriteConfig,
} from './config.js';
import {
  approveProjectRagIngestSnapshotFromOperatorRuntime,
  auditProjectRagIngestSnapshot,
  deferProjectRagIngestSnapshotReviewFromOperatorRuntime,
  inspectProjectRagIngestSnapshot,
  rejectProjectRagIngestSnapshotReviewFromOperatorRuntime,
  resumeProjectRagIngestSnapshot,
} from './snapshot-review-service.js';
import { closeProjectRagPostgresSql, createProjectRagPostgresSql } from './store.js';

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1];
  }
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export interface SnapshotReviewCliArgs {
  readonly help: boolean;
  readonly approve: boolean;
  readonly inspect: boolean;
  readonly reject: boolean;
  readonly defer: boolean;
  readonly audit: boolean;
  readonly resume: boolean;
  readonly snapshotUuid?: string;
  readonly token?: string;
  readonly reason?: string;
}

export function parseSnapshotReviewArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): SnapshotReviewCliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      help: true,
      approve: false,
      inspect: false,
      reject: false,
      defer: false,
      audit: false,
      resume: false,
    };
  }
  return {
    help: false,
    approve: argv.includes('--approve'),
    inspect: argv.includes('--inspect'),
    reject: argv.includes('--reject'),
    defer: argv.includes('--defer'),
    audit: argv.includes('--audit'),
    resume: argv.includes('--resume'),
    snapshotUuid: optionValue(argv, '--snapshot') ?? env.PROJECT_RAG_SNAPSHOT_REVIEW_UUID,
    token: optionValue(argv, '--token') ?? env.PROJECT_RAG_SNAPSHOT_REVIEW_TOKEN,
    reason: optionValue(argv, '--reason'),
  };
}

export function getSnapshotReviewUsage(): string {
  return `Usage: bun run review-project-rag-snapshot --snapshot <uuid> (--inspect | --audit | --resume | --approve --token <signed-token> | --reject --reason <text> | --defer --reason <text>)

Options:
  --snapshot <uuid>       REVIEW_REQUIRED snapshot UUID
  --inspect               Read the exact snapshot without mutation
  --audit                 Read immutable review and decision history
  --resume                Validate approved continuation readiness (fresh preflight required)
  --approve               Request approval through an authenticated runtime
  --reject                Terminally reject through an authenticated runtime
  --defer                 Defer through an authenticated runtime (fresh snapshot required)
  --reason <text>         Bounded operator reason for --reject/--defer
  --token <token>         Signed authority token (or PROJECT_RAG_SNAPSHOT_REVIEW_TOKEN)
  --help, -h              Show this help

The token must be issued by the configured qualified reviewer authority. --approve
uses the configured Unix-socket operator runtime and its public verification key;
it fails closed when either is absent, unavailable, invalid, expired, unbound, or
self-approved. This command never self-issues, weakens, or bypasses review.
`;
}

export async function runSnapshotReviewCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const args = parseSnapshotReviewArgs(argv, env);
  if (args.help) {
    console.log(getSnapshotReviewUsage());
    return;
  }
  if (!args.snapshotUuid) {
    throw new Error('Missing snapshot UUID. Pass --snapshot <uuid>.');
  }
  const actions = [
    args.inspect,
    args.audit,
    args.resume,
    args.approve,
    args.reject,
    args.defer,
  ].filter(Boolean).length;
  if (actions > 1) {
    throw new Error(
      'Choose exactly one action: --inspect, --audit, --resume, --approve, --reject, or --defer.'
    );
  }
  if (actions === 0) {
    throw new Error(
      'Choose an explicit action: --inspect, --audit, --resume, --approve, --reject, or --defer.'
    );
  }
  const token = args.token;
  if (args.approve && !token) {
    throw new Error(
      'Missing signed review token. Pass --token or set PROJECT_RAG_SNAPSHOT_REVIEW_TOKEN.'
    );
  }
  if ((args.reject || args.defer) && !args.reason) {
    throw new Error('Missing operator reason. Pass --reason <text>.');
  }
  if (
    (args.approve || args.reject || args.defer) &&
    (env.PROJECT_RAG_SNAPSHOT_OPERATOR_RUNTIME_SOCKET ||
      env.PROJECT_RAG_SNAPSHOT_OPERATOR_RUNTIME_PUBLIC_KEY)
  ) {
    throw new Error(
      'Operator runtime environment overrides are forbidden. Use the protected server-owned runtime configuration.'
    );
  }
  const sql = createProjectRagPostgresSql(
    args.inspect || args.audit || args.resume
      ? resolveProjectRagPostgresConfigWithLocalDefault(env)
      : resolveProjectRagPostgresWriteConfig(env)
  );
  try {
    if (args.approve) {
      if (!token) {
        throw new Error(
          'Missing signed review token. Pass --token or set PROJECT_RAG_SNAPSHOT_REVIEW_TOKEN.'
        );
      }
      const review = await approveProjectRagIngestSnapshotFromOperatorRuntime(
        sql,
        args.snapshotUuid,
        token,
        {}
      );
      console.log(
        JSON.stringify({ status: 'approved', snapshotUuid: review.snapshotUuid }, null, 2)
      );
      return;
    }
    if (args.reject || args.defer) {
      if (!args.reason) {
        throw new Error('Missing operator reason. Pass --reason <text>.');
      }
      const result = args.reject
        ? await rejectProjectRagIngestSnapshotReviewFromOperatorRuntime(
            sql,
            args.snapshotUuid,
            args.reason,
            {}
          )
        : await deferProjectRagIngestSnapshotReviewFromOperatorRuntime(
            sql,
            args.snapshotUuid,
            args.reason,
            {}
          );
      console.log(
        JSON.stringify(
          {
            status: args.reject ? 'rejected' : 'deferred',
            snapshotUuid: args.snapshotUuid,
            snapshotStatus: 'status' in result ? result.status : undefined,
          },
          null,
          2
        )
      );
      return;
    }
    if (args.audit) {
      const audit = await auditProjectRagIngestSnapshot(sql, args.snapshotUuid);
      console.log(JSON.stringify({ status: audit ? 'audited' : 'not_found', audit }, null, 2));
      return;
    }
    if (args.resume) {
      const resume = await resumeProjectRagIngestSnapshot(sql, args.snapshotUuid);
      console.log(
        JSON.stringify(
          {
            status: resume ? 'resume_requires_fresh_preflight' : 'not_found',
            snapshotUuid: args.snapshotUuid,
            projectId: resume?.snapshot.projectId,
            requiresFreshPreflight: resume?.requiresFreshPreflight,
          },
          null,
          2
        )
      );
      return;
    }
    const snapshot = await inspectProjectRagIngestSnapshot(sql, args.snapshotUuid);
    console.log(
      JSON.stringify(
        {
          status: snapshot ? 'inspected' : 'not_found',
          snapshot,
        },
        null,
        2
      )
    );
  } finally {
    await closeProjectRagPostgresSql();
  }
}

if (import.meta.main) {
  runSnapshotReviewCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
