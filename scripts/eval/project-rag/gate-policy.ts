import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ProjectEvalGateSurface =
  | 'schema'
  | 'scope'
  | 'watcher'
  | 'mcp_schema'
  | 'embedding'
  | 'embedding_profile'
  | 'chunking'
  | 'search'
  | 'ranking';

export interface ProjectEvalSurfacePolicy {
  surface: ProjectEvalGateSurface;
  match: RegExp[];
  requiredGates: string[];
}

export interface ProjectEvalSurfaceHit {
  surface: ProjectEvalGateSurface;
  files: string[];
  requiredGates: string[];
}

export interface ProjectEvalGatePolicy {
  mode: 'changed' | 'conservative';
  reason?: string;
  changedFiles: string[];
  surfaceHits: ProjectEvalSurfaceHit[];
  requiredGates: string[];
}

const PROJECT_GATE_RULES: ProjectEvalSurfacePolicy[] = [
  {
    surface: 'schema',
    match: [
      /^scripts\/project-rag\/store\.ts$/,
      /^scripts\/project-rag\/(ingest-postgres|verify-postgres)\.ts$/,
      /^lib\/shared\/project-(invariants|registry)\.ts$/,
    ],
    requiredGates: ['bun run verify:project', 'bun run eval:project-rag'],
  },
  {
    surface: 'scope',
    match: [
      /^lib\/shared\/project-(include-roots|registry|security)\.ts$/,
      /^scripts\/(register-project|ingest-project-rag)\.ts$/,
      /^scripts\/project-rag\/(ingest-package|ingest-postgres)\.ts$/,
    ],
    requiredGates: ['bun run verify:project', 'bun run eval:project-rag'],
  },
  {
    surface: 'watcher',
    match: [/^scripts\/watch-project\.ts$/, /^mcp\/project-watcher-manager\.ts$/],
    requiredGates: [
      'bun run verify:project',
      'bun run eval:mcp-project-current',
      'bun run eval:project-rag',
    ],
  },
  {
    surface: 'mcp_schema',
    match: [
      /^mcp\/(project-tools|tools|tool-registry)\.ts$/,
      /^mcp\/tests\/contract\/.*\.test\.ts$/,
    ],
    requiredGates: ['bun run eval:codex-mcp'],
  },
  {
    surface: 'embedding',
    match: [
      /^scripts\/project-rag\/(embeddings|embed-postgres)\.ts$/,
      /^scripts\/check-embedding-health\.ts$/,
    ],
    requiredGates: [
      'bun run health:embeddings',
      'bun run verify:project',
      'bun run eval:project-rag',
    ],
  },
  {
    surface: 'embedding_profile',
    match: [
      /^lib\/shared\/project-embedding-profiles\.ts$/,
      /^scripts\/eval\/project-rag\/(embedding-profile-benchmark|real-embedding-profile-benchmark)\.ts$/,
      /^scripts\/benchmarks\/project-rag-(real-)?embedding-profiles\.ts$/,
      /^scripts\/verify-vector-index-dimensions\.ts$/,
      /^scripts\/start-llamacpp-embedding-gpu.*\.sh$/,
    ],
    requiredGates: [
      'bun run bench:project-embedding-profiles -- --json',
      'bun run bench:project-embedding-profiles:real -- --dry-run --json',
      'bun run verify:project',
      'bun run eval:project-rag',
    ],
  },
  {
    surface: 'chunking',
    match: [/^lib\/ingest\/(chunker|symbol_parser)\.ts$/, /^scripts\/ingest\/parse-symbols\.ts$/],
    requiredGates: ['bun run verify:project', 'bun run eval:project-rag'],
  },
  {
    surface: 'search',
    match: [
      /^mcp\/project-handlers\.ts$/,
      /^scripts\/project-rag\/search-postgres\.ts$/,
      /^lib\/shared\/project-search-types\.ts$/,
    ],
    requiredGates: ['bun run verify:project', 'bun run eval:project-rag'],
  },
  {
    surface: 'ranking',
    match: [/^scripts\/project-rag\/search-postgres\.ts$/, /^lib\/search\/scoring\.ts$/],
    requiredGates: ['bun run verify:project', 'bun run eval:project-rag'],
  },
];

const CONSERVATIVE_POLICY_REASON =
  'Trusted base/head range is unavailable; using the full conservative gate set.';

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectAllRequiredGates(): string[] {
  const requiredGateSet = new Set<string>();
  for (const rule of PROJECT_GATE_RULES) {
    for (const gate of rule.requiredGates) {
      requiredGateSet.add(gate);
    }
  }
  return Array.from(requiredGateSet);
}

export function buildProjectEvalGatePolicy(changedFiles: string[]): ProjectEvalGatePolicy {
  const normalizedFiles = changedFiles.map(normalizePath);
  const surfaceHits: ProjectEvalSurfaceHit[] = [];

  for (const rule of PROJECT_GATE_RULES) {
    const matched = normalizedFiles.filter((filePath) =>
      rule.match.some((pattern) => pattern.test(filePath))
    );
    if (matched.length === 0) {
      continue;
    }
    surfaceHits.push({
      surface: rule.surface,
      files: matched,
      requiredGates: rule.requiredGates,
    });
  }

  const requiredGateSet = new Set<string>();
  for (const hit of surfaceHits) {
    for (const gate of hit.requiredGates) {
      requiredGateSet.add(gate);
    }
  }

  return {
    mode: 'changed',
    changedFiles: normalizedFiles,
    surfaceHits,
    requiredGates: Array.from(requiredGateSet),
  };
}

export function buildConservativeProjectEvalGatePolicy(): ProjectEvalGatePolicy {
  return {
    mode: 'conservative',
    reason: CONSERVATIVE_POLICY_REASON,
    changedFiles: [],
    surfaceHits: [],
    requiredGates: collectAllRequiredGates(),
  };
}

export function checkProjectEvalGateCoverage(
  requiredGates: string[],
  executedGates: string[]
): { passed: boolean; missing: string[] } {
  const executed = new Set(executedGates.map((gate) => gate.trim()));
  const missing = requiredGates.filter((gate) => !executed.has(gate.trim()));
  return { passed: missing.length === 0, missing };
}

function parseArgs(args: string[]) {
  const changedFiles: string[] = [];
  const executedGates: string[] = [];
  let writePath: string | undefined;
  let base: string | undefined;
  let head: string | undefined;
  let json = false;
  let enforce = false;
  let conservative = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--changed-file') {
      const value = args[index + 1];
      if (value) {
        changedFiles.push(value);
        index++;
      }
      continue;
    }
    if (arg === '--executed-gate') {
      const value = args[index + 1];
      if (value) {
        executedGates.push(value);
        index++;
      }
      continue;
    }
    if (arg === '--write') {
      const value = args[index + 1];
      if (value) {
        writePath = value;
        index++;
      }
      continue;
    }
    if (arg === '--base') {
      const value = args[index + 1];
      if (value) {
        base = value;
        index++;
      }
      continue;
    }
    if (arg === '--head') {
      const value = args[index + 1];
      if (value) {
        head = value;
        index++;
      }
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--conservative') {
      conservative = true;
      continue;
    }
    if (arg === '--enforce') {
      enforce = true;
    }
  }

  return {
    changedFiles,
    executedGates,
    writePath,
    base,
    head,
    json,
    enforce,
    conservative,
  };
}

function collectChangedFilesFromGit(base: string, head: string): string[] {
  const args = ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${base}...${head}`];
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'unknown git diff failure';
    throw new Error(`Failed to collect changed files from git: ${stderr}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function resolveProjectEvalGatePolicy(parsed: {
  changedFiles: string[];
  base?: string;
  head?: string;
  conservative: boolean;
}): ProjectEvalGatePolicy {
  if (parsed.changedFiles.length > 0) {
    return buildProjectEvalGatePolicy(parsed.changedFiles);
  }

  if (parsed.conservative) {
    return buildConservativeProjectEvalGatePolicy();
  }

  if (!parsed.base || !parsed.head) {
    throw new Error(
      'Missing trusted base/head range. Use --conservative for schedule/workflow_dispatch or provide both --base and --head.'
    );
  }

  const changedFiles = collectChangedFilesFromGit(parsed.base, parsed.head);
  return buildProjectEvalGatePolicy(changedFiles);
}

function printPolicy(policy: ProjectEvalGatePolicy) {
  console.log('Project RAG Gate Policy');
  console.log('=======================');
  if (policy.mode === 'conservative') {
    console.log('Policy mode: conservative');
    console.log(policy.reason ?? CONSERVATIVE_POLICY_REASON);
    console.log('');
  } else if (policy.changedFiles.length === 0) {
    console.log('No changed files detected.');
    return;
  }

  if (policy.mode === 'changed') {
    console.log(`Changed files: ${policy.changedFiles.length}`);
    for (const filePath of policy.changedFiles) {
      console.log(`  - ${filePath}`);
    }
    console.log('');

    if (policy.surfaceHits.length === 0) {
      console.log('No gated surfaces were touched.');
      return;
    }

    console.log('Triggered surfaces:');
    for (const hit of policy.surfaceHits) {
      console.log(`  - ${hit.surface}: ${hit.files.join(', ')}`);
    }
    console.log('');
  }

  console.log('Required gates:');
  for (const gate of policy.requiredGates) {
    console.log(`  - ${gate}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const policy = resolveProjectEvalGatePolicy(parsed);
  const coverage = checkProjectEvalGateCoverage(policy.requiredGates, parsed.executedGates);

  if (parsed.writePath) {
    const absoluteWritePath = resolve(parsed.writePath);
    mkdirSync(dirname(absoluteWritePath), { recursive: true });
    writeFileSync(
      absoluteWritePath,
      JSON.stringify(
        {
          ...policy,
          coverage,
        },
        null,
        2
      )
    );
  }

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          ...policy,
          coverage,
        },
        null,
        2
      )
    );
  } else {
    printPolicy(policy);
    if (policy.requiredGates.length > 0 && parsed.executedGates.length > 0) {
      console.log('');
      if (coverage.passed) {
        console.log('Gate coverage: ✅ all required gates were provided.');
      } else {
        console.log('Gate coverage: ❌ missing required gates:');
        for (const gate of coverage.missing) {
          console.log(`  - ${gate}`);
        }
      }
    }
  }

  if (parsed.enforce && !coverage.passed) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
