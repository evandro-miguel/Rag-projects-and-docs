import { describe, expect, it } from 'vitest';
import {
  assertProjectEvalArgs,
  buildExecutionPlan,
  buildProjectEvalReport,
  parseProjectEvalArgs,
} from './run-project-rag-eval.js';
import type { ProjectEvalCapturedRun } from './types.js';

describe('project-rag eval runner', () => {
  it('requires exactly one explicit mode', () => {
    expect(() => assertProjectEvalArgs(parseProjectEvalArgs([]))).toThrow(
      'Pass exactly one of --capture <path> or --plan-only.'
    );
    expect(() => assertProjectEvalArgs(parseProjectEvalArgs(['--plan-only']))).not.toThrow();
    expect(() =>
      assertProjectEvalArgs(parseProjectEvalArgs(['--capture', 'captures.json']))
    ).not.toThrow();
    expect(() =>
      assertProjectEvalArgs(parseProjectEvalArgs(['--capture', 'captures.json', '--plan-only']))
    ).toThrow('Pass exactly one of --capture <path> or --plan-only.');
  });

  it('builds execution plans with db actions and experiments', () => {
    const plan = buildExecutionPlan('fixture-ts-service');
    expect(plan).toHaveLength(1);
    expect(plan[0]?.dbActions.length).toBeGreaterThan(0);
    expect(plan[0]?.experiments.length).toBeGreaterThan(0);
    expect(plan[0]?.sharedBenchmarkSources).toContain('coding-scenarios');
  });

  it('builds machine-readable reports from captured runs', () => {
    const captures: ProjectEvalCapturedRun[] = [
      {
        fixtureId: 'fixture-ts-service',
        variantId: 'legacy-docs-hybrid',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: [
          {
            scenarioId: 'ts-service-session-token',
            latencyMs: 300,
            results: [{ path: 'README.md' }],
          },
          {
            scenarioId: 'ts-service-user-email-repo',
            latencyMs: 320,
            results: [{ path: 'README.md' }],
          },
          {
            scenarioId: 'ts-service-login-controller',
            latencyMs: 310,
            results: [{ path: 'README.md' }],
          },
        ],
      },
      {
        fixtureId: 'fixture-ts-service',
        variantId: 'project-hybrid',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: [
          {
            scenarioId: 'ts-service-session-token',
            latencyMs: 420,
            results: [
              {
                path: 'src/auth/service.ts',
                symbolName: 'issueSessionToken',
                symbolKind: 'function',
                startLine: 12,
                endLine: 15,
              },
            ],
          },
          {
            scenarioId: 'ts-service-user-email-repo',
            latencyMs: 450,
            results: [
              {
                path: 'src/users/repository.ts',
                symbolName: 'getUserByEmail',
                symbolKind: 'function',
                startLine: 7,
                endLine: 9,
              },
            ],
          },
          {
            scenarioId: 'ts-service-login-controller',
            latencyMs: 480,
            results: [
              {
                path: 'src/auth/controller.ts',
                symbolName: 'handleLoginRequest',
                symbolKind: 'function',
                startLine: 3,
                endLine: 9,
              },
            ],
          },
        ],
      },
    ];

    const report = buildProjectEvalReport(captures, 'fixture-ts-service');

    expect(report.fixtures).toHaveLength(1);
    expect(report.variantReports).toHaveLength(2);
    expect(report.goldenGroupReports.length).toBeGreaterThan(0);
    expect(report.experimentReports[0]?.passed).toBe(true);
  });

  it('splits variant metrics into golden query groups', () => {
    const captures: ProjectEvalCapturedRun[] = [
      {
        fixtureId: 'fixture-graph-relations',
        variantId: 'project-hybrid',
        capturedAt: new Date().toISOString(),
        source: 'script',
        responses: [
          {
            scenarioId: 'graph-tax-rate',
            latencyMs: 410,
            results: [
              {
                path: 'src/domain/price-calculator.ts',
                symbolName: 'computeOrderTotal',
                symbolKind: 'function',
              },
            ],
          },
          {
            scenarioId: 'graph-caller-chain',
            latencyMs: 480,
            results: [
              {
                path: 'src/domain/order-service.ts',
                symbolName: 'createOrder',
                symbolKind: 'function',
              },
            ],
          },
        ],
      },
    ];

    const report = buildProjectEvalReport(captures, 'fixture-graph-relations');
    const groupIds = new Set(report.goldenGroupReports.map((group) => group.groupId));

    expect(groupIds.has('project-symbol-graph')).toBe(true);
    expect(groupIds.has('project-caller-reference')).toBe(true);
    expect(report.goldenGroupReports.every((group) => group.scenarioCount >= 1)).toBe(true);
  });
});
