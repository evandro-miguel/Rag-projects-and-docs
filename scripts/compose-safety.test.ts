import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const localCompose = readFileSync(`${repoRoot}infra/docker/compose.local.yml`, 'utf8');
const docsCompose = readFileSync(`${repoRoot}infra/docs-rag/compose.yml`, 'utf8');
const gitignore = readFileSync(`${repoRoot}.gitignore`, 'utf8');
const ragOps = readFileSync(`${repoRoot}scripts/rag-ops.sh`, 'utf8');
const packageJson = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8')) as {
  scripts: Record<string, string>;
};

function publishedPortMappings(source: string): string[] {
  const mappings: string[] = [];
  let portsIndent: number | undefined;

  for (const line of source.split('\n')) {
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (/^\s*ports:\s*$/u.test(line)) {
      portsIndent = indent;
      continue;
    }
    if (portsIndent !== undefined && line.trim() !== '' && indent <= portsIndent) {
      portsIndent = undefined;
    }
    if (portsIndent === undefined) continue;

    const match = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/u);
    const mapping = match?.[1] ?? match?.[2] ?? match?.[3];
    if (mapping) mappings.push(mapping);
  }

  return mappings;
}

describe('release safety boundaries', () => {
  it('fails closed for the Docs RAG Postgres password and stays loopback-only', () => {
    expect(docsCompose).toContain(
      `POSTGRES_PASSWORD: \${DOCS_RAG_POSTGRES_PASSWORD:?DOCS_RAG_POSTGRES_PASSWORD is required}`
    );
    expect(docsCompose).not.toContain('DOCS_RAG_POSTGRES_PASSWORD:-postgres');
    expect(docsCompose).toContain(`127.0.0.1:\${DOCS_RAG_POSTGRES_PORT:-5542}:5432`);
  });

  it('requires explicit database credentials in every Compose lane', () => {
    for (const source of [localCompose, docsCompose]) {
      expect(source).toMatch(/POSTGRES_PASSWORD:\s+\$\{[^}]+:\?/u);
      expect(source).not.toMatch(/POSTGRES_PASSWORD:\s+\$\{[^}]+:-/u);
    }
  });

  it('keeps local published ports loopback-only', () => {
    const mappings = publishedPortMappings(localCompose);

    expect(publishedPortMappings(localCompose)).toEqual([
      `127.0.0.1:\${RAG_LOCAL_POSTGRES_PORT:-5560}:5432`,
      `127.0.0.1:\${RAG_LOCAL_RERANKER_PORT:-3560}:3456`,
    ]);
    expect(mappings.every((mapping) => mapping.startsWith('127.0.0.1:'))).toBe(true);
  });

  it('isolates the local Compose project identity', () => {
    expect(localCompose).toContain(`name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}`);
    expect(localCompose).toContain(
      `container_name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}-postgres`
    );
    expect(localCompose).toContain(
      `container_name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}-reranker`
    );
    expect(localCompose).not.toMatch(/^\s*container_name:\s*rag-v2(?:\s|$)/mu);
  });

  it('keeps worker and reranker behind explicit local profiles', () => {
    const postgresSection = localCompose.slice(
      localCompose.indexOf('  postgres:'),
      localCompose.indexOf('  worker:')
    );
    const workerSection = localCompose.slice(
      localCompose.indexOf('  worker:'),
      localCompose.indexOf('  reranker:')
    );
    const rerankerSection = localCompose.slice(localCompose.indexOf('  reranker:'));

    expect(postgresSection).not.toContain('profiles:');
    expect(workerSection).toContain('profiles: [worker]');
    expect(rerankerSection).toContain('profiles: [reranker]');
  });

  it('covers the generated local environment file with an ignore rule', () => {
    expect(gitignore).toMatch(/(^|\n)\.env\.\*(?:\n|$)/u);
    expect(gitignore).not.toMatch(/^\s*!.*\.env\.local\s*$/mu);
  });

  it('uses one public lifecycle and shares its configuration with CLI and MCP', () => {
    expect(packageJson.scripts['rag:init']).toBe('bash scripts/rag-ops.sh init');
    expect(packageJson.scripts['rag:start']).toBe('bash scripts/rag-ops.sh up');
    expect(packageJson.scripts['rag:stop']).toBe('bash scripts/rag-ops.sh down');
    expect(packageJson.scripts['rag:status']).toBe('bash scripts/rag-ops.sh status');
    expect(packageJson.scripts['rag:doctor']).toBe('bash scripts/rag-ops.sh doctor');
    expect(ragOps).toContain(
      ['ENV_FILE="', '$', '{RAG_LOCAL_ENV_FILE:-$PROJECT_ROOT/.env.local}"'].join('')
    );
    expect(ragOps).toContain("printf 'PROJECT_RAG_PREPARE_RUNTIME=isolated_dev\\n'");
    expect(ragOps).toContain(
      "printf 'PROJECT_RAG_DATABASE_START_COMMAND=bash scripts/rag-ops.sh up\\n'"
    );
    expect(ragOps).toContain("embedding_start_command='bun run embeddings:gpu:1024'");
    expect(ragOps).toContain("embedding_start_command='bun run embeddings:gpu'");
  });

  it('keeps generated runtime state operator-local', () => {
    expect(gitignore).toContain('.data/');
  });
});
