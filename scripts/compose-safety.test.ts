import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const compose = readFileSync(`${repoRoot}infra/docker/compose.yml`, 'utf8');
const devCompose = readFileSync(`${repoRoot}infra/docker/compose.dev.yml`, 'utf8');
const localCompose = readFileSync(`${repoRoot}infra/docker/compose.local.yml`, 'utf8');
const docsCompose = readFileSync(`${repoRoot}infra/docs-rag/compose.yml`, 'utf8');
const gitignore = readFileSync(`${repoRoot}.gitignore`, 'utf8');

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
  it('requires an explicit stable Postgres password', () => {
    expect(compose).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?');
    expect(compose).not.toContain('POSTGRES_PASSWORD:-postgres');
  });

  it('fails closed for the Docs RAG Postgres password and stays loopback-only', () => {
    expect(docsCompose).toContain(
      `POSTGRES_PASSWORD: \${DOCS_RAG_POSTGRES_PASSWORD:?DOCS_RAG_POSTGRES_PASSWORD is required}`
    );
    expect(docsCompose).not.toContain('DOCS_RAG_POSTGRES_PASSWORD:-postgres');
    expect(docsCompose).toContain(`127.0.0.1:\${DOCS_RAG_POSTGRES_PORT:-5542}:5432`);
  });

  it('requires explicit database credentials in every Compose lane', () => {
    for (const source of [compose, devCompose, localCompose, docsCompose]) {
      expect(source).toMatch(/POSTGRES_PASSWORD:\s+\$\{[^}]+:\?/u);
      expect(source).not.toMatch(/POSTGRES_PASSWORD:\s+\$\{[^}]+:-/u);
    }
  });

  it('keeps development and local published ports loopback-only', () => {
    const mappings = [...publishedPortMappings(devCompose), ...publishedPortMappings(localCompose)];

    expect(publishedPortMappings(devCompose)).toEqual([
      `127.0.0.1:\${RAG_DEV_POSTGRES_PORT:-5441}:5432`,
    ]);
    expect(publishedPortMappings(localCompose)).toEqual([
      `127.0.0.1:\${RAG_LOCAL_POSTGRES_PORT:-5560}:5432`,
      `127.0.0.1:\${RAG_LOCAL_RERANKER_PORT:-3560}:3456`,
    ]);
    expect(mappings.every((mapping) => mapping.startsWith('127.0.0.1:'))).toBe(true);
  });

  it('isolates development and local Compose project identities', () => {
    expect(devCompose).toContain(`name: \${COMPOSE_PROJECT_NAME:-rag-v2-dev}`);
    expect(devCompose).toContain(
      `container_name: \${COMPOSE_PROJECT_NAME:-rag-v2-dev}-postgres-dev`
    );
    expect(localCompose).toContain(`name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}`);
    expect(localCompose).toContain(
      `container_name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}-postgres`
    );
    expect(localCompose).toContain(
      `container_name: \${RAG_LOCAL_COMPOSE_PROJECT:-rag-v2-local}-reranker`
    );
    expect(devCompose).not.toContain('name: rag-v2');
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
    expect('.env.rag.local').toMatch(/^\.env\..+\.local$/u);
    expect(gitignore).toMatch(/(^|\n)\/\.env\.\*\.local(?:\n|$)/u);
    expect(gitignore).not.toMatch(/^\s*!.*\.env\.rag\.local\s*$/mu);
  });

  it('keeps generated runtime state operator-local', () => {
    expect(gitignore).toContain('.data/');
  });
});
