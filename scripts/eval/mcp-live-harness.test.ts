import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatErrorForOutput } from '../../lib/shared/credential-redact.js';
import { resolveMcpCallerSurface } from './mcp-expected-surface.js';
import {
  buildProjectSearchArguments,
  buildProjectSearchQueries,
  extractDocsSearchResults,
  extractIngestProjectFileStats,
  PROJECT_SEARCH_MODE,
  parseArgs,
  pickSearchProbe,
  validateProjectJourneySurface,
} from './mcp-live-harness.js';

describe('parseArgs', () => {
  it('uses a live Docs RAG query by default', () => {
    const args = parseArgs(['--docs-only', '--include-roots', 'src'], '/workspace/rag-v1');

    expect(args.docsQuery).toContain('React components');
    expect(args.docsQuery).toContain('import and export');
  });

  it('separates the MCP server cwd from the target project root', () => {
    const args = parseArgs(
      [
        '--cwd',
        '/workspace/rag-v1',
        '--project-root',
        '/workspace/external-project',
        '--project-name',
        'invest-center',
        '--project-slug',
        'invest-center-main',
        '--include-roots',
        'src,packages/app',
        '--ingest-project',
        '--force-ingest',
      ],
      '/workspace/default'
    );

    expect(args.cwd).toBe('/workspace/rag-v1');
    expect(args.projectRoot).toBe('/workspace/external-project');
    expect(args.projectName).toBe('external-project');
    expect(args.projectSlug).toBe('external-project');
    expect(args.includeRoots).toEqual(['src', 'packages/app']);
    expect(args.ingestProject).toBe(true);
    expect(args.forceIngest).toBe(true);
    expect(args.verifyFreshness).toBe(true);
  });

  it('preserves explicit project identity for non-ingesting probes', () => {
    const args = parseArgs(
      [
        '--project-root',
        '/workspace/external-project',
        '--project-name',
        'invest-center',
        '--project-slug',
        'invest-center-main',
        '--include-roots',
        'src',
      ],
      '/workspace/rag-v1'
    );

    expect(args.projectName).toBe('invest-center');
    expect(args.projectSlug).toBe('invest-center-main');
    expect(args.ingestProject).toBe(false);
  });

  it('uses the supported hybrid Project search mode', () => {
    expect(PROJECT_SEARCH_MODE).toBe('hybrid');
    expect(buildProjectSearchArguments('project-1', 'find symbol')).toEqual({
      projectId: 'project-1',
      query: 'find symbol',
      limit: 10,
      mode: 'hybrid',
    });
  });

  it('defaults the target project to the resolved cwd and allows skipping freshness', () => {
    const args = parseArgs(['--skip-freshness', '--include-roots', 'src,lib'], '/workspace/rag-v1');

    expect(args.cwd).toBe('/workspace/rag-v1');
    expect(args.projectRoot).toBe('/workspace/rag-v1');
    expect(args.projectName).toBe('rag-v1');
    expect(args.projectSlug).toBe('rag-v1');
    expect(args.includeRoots).toEqual(['src', 'lib']);
    expect(args.verifyFreshness).toBe(false);
  });

  it('supports docs-only mode without changing project resolution defaults', () => {
    const args = parseArgs(['--docs-only', '--include-roots', 'src'], '/workspace/rag-v1');

    expect(args.docsOnly).toBe(true);
    expect(args.includeRoots).toEqual(['src']);
    expect(args.projectRoot).toBe('/workspace/rag-v1');
    expect(args.projectName).toBe('rag-v1');
    expect(args.projectSlug).toBe('rag-v1');
  });

  it('enables explicit ingest edit session defaults when --edit-session is set', () => {
    const args = parseArgs(
      ['--edit-session', '--include-roots', 'src', '--edit-closeout-max-files', '12'],
      '/workspace/rag-v1'
    );

    expect(args.editSession).toBe(true);
    expect(args.ingestProject).toBe(true);
    expect(args.editCloseoutMaxFiles).toBe(12);
  });

  it('rejects contradictory docs-only and edit-session flags', () => {
    expect(() =>
      parseArgs(['--docs-only', '--edit-session', '--include-roots', 'src'], '/workspace/rag-v1')
    ).toThrow('--docs-only and --edit-session are mutually exclusive');
  });

  it('rejects contradictory docs-only and ingest flags', () => {
    expect(() =>
      parseArgs(['--docs-only', '--ingest-project', '--include-roots', 'src'], '/workspace/rag-v1')
    ).toThrow('--docs-only and --ingest-project are mutually exclusive');
  });
});

describe('caller-visible live harness surface', () => {
  it('does not require write tools for a read-only caller', () => {
    const surface = resolveMcpCallerSurface({
      MCP_PERMISSION_MODE: 'read_only',
      MCP_TOOLSET: 'all',
    });

    expect(surface.toolNames).toHaveLength(18);
    expect(surface.toolNames).not.toContain('register_project');
    expect(surface.toolNames).not.toContain('ingest_project');
    expect(surface.toolNames).not.toContain('ensure_reranker');
    expect(surface.toolNames).not.toContain('get_feature_hubs');
  });

  it('uses caller-selected read-write capability without changing the public read set', () => {
    const surface = resolveMcpCallerSurface({
      MCP_PERMISSION_MODE: 'read_write',
      MCP_TOOLSET: 'projects',
    });

    expect(surface.toolNames).toHaveLength(17);
    expect(surface.toolNames).toContain('register_project');
    expect(surface.toolNames).toContain('ingest_project');
    expect(surface.toolNames).not.toContain('search_docs');
    expect(surface.toolNames).not.toContain('get_feature_hubs');
  });
});

describe('Project journey capability gates', () => {
  const readOnlyTools = resolveMcpCallerSurface({
    MCP_PERMISSION_MODE: 'read_only',
    MCP_TOOLSET: 'all',
  }).toolNames;

  it('requires the full read probe instead of skipping it for a full caller', () => {
    const result = validateProjectJourneySurface(
      { docsOnly: false, ingestProject: false, editSession: false },
      readOnlyTools
    );

    expect(result).toEqual({
      readJourneyRequired: true,
      readJourneyVisible: true,
      writeJourneyRequested: false,
      writeJourneyVisible: false,
    });
    expect(() =>
      validateProjectJourneySurface(
        { docsOnly: false, ingestProject: false, editSession: false },
        readOnlyTools.filter((name) => name !== 'get_project_file')
      )
    ).toThrow('get_project_file');
  });

  it('fails closed when ingest or edit is requested without write tools', () => {
    expect(() =>
      validateProjectJourneySurface(
        { docsOnly: false, ingestProject: true, editSession: false },
        readOnlyTools
      )
    ).toThrow('--ingest-project/--edit-session');
    expect(() =>
      validateProjectJourneySurface(
        { docsOnly: false, ingestProject: true, editSession: false },
        readOnlyTools
      )
    ).toThrow('register_project, ingest_project, ingest_project_file');
    expect(() =>
      validateProjectJourneySurface(
        { docsOnly: false, ingestProject: false, editSession: true },
        readOnlyTools
      )
    ).toThrow('--ingest-project/--edit-session');
  });

  it('keeps docs-only mode independent of Project tool visibility', () => {
    expect(
      validateProjectJourneySurface({ docsOnly: true, ingestProject: false, editSession: false }, [
        'search_docs',
      ])
    ).toEqual({
      readJourneyRequired: false,
      readJourneyVisible: false,
      writeJourneyRequested: false,
      writeJourneyVisible: false,
    });
  });
});

describe('MCP live package lanes', () => {
  it('keeps full read-only coverage separate from write journeys', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> };
    const full = packageJson.scripts['eval:mcp-live:full'];
    const ingest = packageJson.scripts['eval:mcp-live:ingest'];
    const edit = packageJson.scripts['eval:mcp-live:edit-session'];

    expect(full).not.toContain('MCP_PERMISSION_MODE=');
    expect(full).not.toContain('MCP_TOOLSET=');
    expect(full).not.toContain('--ingest-project');
    expect(full).toContain('--project-root "$PWD"');
    expect(ingest).toContain('MCP_PERMISSION_MODE=read_write');
    expect(ingest).not.toContain('MCP_TOOLSET=');
    expect(ingest).toContain('--ingest-project');
    expect(edit).toContain('MCP_PERMISSION_MODE=read_write');
    expect(edit).not.toContain('MCP_TOOLSET=');
    expect(edit).toContain('--edit-session');
    expect(edit).toContain('--project-root "$PWD"');
  });
});

describe('extractDocsSearchResults', () => {
  it('reads MCP structuredContent results directly', () => {
    expect(
      extractDocsSearchResults({
        query: 'bun server',
        results: [{ sourcePath: 'ingest/processed/external/bun-docs/runtime/http/server.mdx' }],
      })
    ).toHaveLength(1);
  });

  it('keeps compatibility with legacy data.results envelopes', () => {
    expect(
      extractDocsSearchResults({
        data: {
          results: [{ sourcePath: 'legacy.md' }],
        },
      })
    ).toHaveLength(1);
  });

  it('returns an empty array when the MCP search has no hits', () => {
    expect(extractDocsSearchResults({ resultCount: 0, results: [] })).toHaveLength(0);
  });
});

describe('pickSearchProbe', () => {
  it('prefers symbol names when the outline exposes one', () => {
    expect(pickSearchProbe('src/app.ts', 'handleRequest')).toBe('handleRequest');
  });

  it('falls back to the file stem for project-agnostic keyword search', () => {
    expect(pickSearchProbe('src/services/order-controller.ts')).toBe('order-controller');
  });
});

describe('buildProjectSearchQueries', () => {
  it('keeps MCP-only probe queries deterministic and deduplicated', () => {
    expect(
      buildProjectSearchQueries({
        projectName: 'fixture-ts-service',
        projectSlug: 'fixture-ts-service',
        includeRoots: ['src', 'src', 'docs'],
      })
    ).toEqual(['fixture-ts-service', 'src', 'export', 'function']);
  });
});

describe('extractIngestProjectFileStats', () => {
  it('reads single-file ingest stats from structured content', () => {
    expect(
      extractIngestProjectFileStats({
        data: {
          stats: {
            filesIndexed: 1,
            filesDeleted: 0,
          },
        },
      })
    ).toEqual({
      filesIndexed: 1,
      filesDeleted: 0,
    });
  });

  it('keeps compatibility with text-only ingest responses', () => {
    expect(
      extractIngestProjectFileStats({
        rawText: 'Indexed: 0\nDeleted: 1',
      })
    ).toEqual({
      filesIndexed: 0,
      filesDeleted: 1,
    });
  });
});

describe('credential redaction in eval output (S1)', () => {
  // formatErrorForOutput is wired into the docsError catch handler
  // and main().catch in mcp-live-harness.  These tests prove the
  // redaction path for synthetic credentials.

  it('redacts user:secret@ in docs search error capture', () => {
    const result = formatErrorForOutput(
      new Error('search_docs failed: https://admin:vo5secreta@internal.corp.com/api down')
    );
    expect(result).toContain('[REDACTED:userinfo]');
    expect(result).toContain('internal.corp.com');
    expect(result).not.toContain('vo5secreta');
  });

  it('redacts Bearer tokens in docsError path', () => {
    const result = formatErrorForOutput(
      new Error('Authorization: Bearer syn-bearer-fake-xyz789 returned 401')
    );
    expect(result).toContain('[REDACTED:bearer-token]');
    expect(result).toContain('Authorization:');
    expect(result).not.toContain('syn-bearer-fake-xyz789');
  });

  it('redacts postgres connection string passwords in main().catch', () => {
    const result = formatErrorForOutput(
      new Error('postgresql://app:syn-db-secret-42@pg.internal/main — connection refused')
    );
    expect(result).toContain('[REDACTED:database-url-password]');
    expect(result).toContain('pg.internal');
    expect(result).toContain('main');
    expect(result).not.toContain('syn-db-secret-42');
  });

  it('preserves non-secret MCP error detail', () => {
    const result = formatErrorForOutput(new Error('verify_project_index returned gate blocked'));
    expect(result).toContain('verify_project_index');
    expect(result).toContain('gate blocked');
  });
});
