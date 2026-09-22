import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getProjectFixture, PROJECT_RAG_FIXTURES } from './fixtures.js';
import { buildGoldenGroupReports } from './golden-groups.js';
import { compareExperiment, evaluateCapturedRun, resolveThresholds } from './metrics.js';
import type {
  ProjectEvalCapturedRun,
  ProjectEvalReport,
  ProjectExecutionPlanItem,
} from './types.js';

interface ProjectEvalCliArgs {
  readonly fixtureId?: string;
  readonly variantIds?: string[];
  readonly capturePath?: string;
  readonly writePath?: string;
  readonly json: boolean;
  readonly planOnly: boolean;
}

export function parseProjectEvalArgs(args: string[]): ProjectEvalCliArgs {
  const hasCapture = args.includes('--capture');
  const planOnly = args.includes('--plan-only');
  return {
    fixtureId: args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : undefined,
    variantIds: args.includes('--variant')
      ? args.slice(args.indexOf('--variant') + 1).filter((arg) => !arg.startsWith('--'))
      : undefined,
    capturePath: hasCapture ? args[args.indexOf('--capture') + 1] : undefined,
    writePath: args.includes('--write') ? args[args.indexOf('--write') + 1] : undefined,
    json: args.includes('--json'),
    planOnly,
  };
}

export function assertProjectEvalArgs(args: ProjectEvalCliArgs): void {
  if (args.planOnly === Boolean(args.capturePath)) {
    throw new Error('Pass exactly one of --capture <path> or --plan-only.');
  }
}

function loadCaptureFile(capturePath: string): ProjectEvalCapturedRun[] {
  const absolutePath = resolve(capturePath);
  const parsed = JSON.parse(readFileSync(absolutePath, 'utf-8'));
  if (Array.isArray(parsed)) {
    return parsed as ProjectEvalCapturedRun[];
  }
  return [parsed as ProjectEvalCapturedRun];
}

export function buildExecutionPlan(fixtureId?: string): ProjectExecutionPlanItem[] {
  const fixtures = fixtureId
    ? PROJECT_RAG_FIXTURES.filter((fixture) => fixture.id === fixtureId)
    : PROJECT_RAG_FIXTURES;

  return fixtures.map((fixture) => ({
    fixtureId: fixture.id,
    title: fixture.title,
    repoRoot: fixture.repoRoot,
    sharedBenchmarkSources: fixture.sharedBenchmarkSources,
    dbActions: fixture.dbActions,
    experiments: fixture.experiments,
    thresholds: resolveThresholds(fixture),
  }));
}

export function buildProjectEvalReport(
  captures: ProjectEvalCapturedRun[],
  fixtureId?: string,
  variantIds?: string[]
): ProjectEvalReport {
  const selectedFixtures = fixtureId
    ? PROJECT_RAG_FIXTURES.filter((fixture) => fixture.id === fixtureId)
    : PROJECT_RAG_FIXTURES;

  // Filter captures by variant if specified
  const filteredCaptures =
    variantIds && variantIds.length > 0
      ? captures.filter((capture) => variantIds.includes(capture.variantId))
      : captures;

  const variantReports = selectedFixtures.flatMap((fixture) =>
    filteredCaptures
      .filter((capture) => capture.fixtureId === fixture.id)
      .map((capture) => evaluateCapturedRun(fixture, capture))
  );

  const experimentReports = selectedFixtures.flatMap((fixture) => {
    const fixtureReports = variantReports.filter((report) => report.fixtureId === fixture.id);
    if (fixtureReports.length === 0) {
      return [];
    }
    return fixture.experiments
      .filter(
        (experiment) =>
          fixtureReports.some((report) => report.variantId === experiment.baselineVariantId) &&
          fixtureReports.some((report) => report.variantId === experiment.candidateVariantId)
      )
      .map((experiment) => compareExperiment(fixture, experiment, fixtureReports));
  });

  const goldenGroupReports = selectedFixtures.flatMap((fixture) => {
    const fixtureVariantReports = variantReports.filter(
      (report) => report.fixtureId === fixture.id
    );
    return fixtureVariantReports.flatMap((variantReport) =>
      buildGoldenGroupReports(fixture, variantReport)
    );
  });

  return {
    generatedAt: new Date().toISOString(),
    fixtures: buildExecutionPlan(fixtureId),
    variantReports,
    goldenGroupReports,
    experimentReports,
  };
}

function formatHumanReport(report: ProjectEvalReport): string {
  const lines: string[] = [];
  lines.push('Project RAG Evaluation');
  lines.push('======================');
  lines.push('');

  for (const fixture of report.fixtures) {
    lines.push(`Fixture: ${fixture.fixtureId}`);
    lines.push(`  Repo: ${fixture.repoRoot}`);
    lines.push(`  Shared benchmarks: ${fixture.sharedBenchmarkSources.join(', ')}`);
    lines.push(`  DB actions: ${fixture.dbActions.length}`);
    lines.push(`  Experiments: ${fixture.experiments.length}`);
    lines.push('');
  }

  if (report.variantReports.length > 0) {
    lines.push('Variant reports');
    lines.push('---------------');
    for (const variantReport of report.variantReports) {
      lines.push(
        `${variantReport.fixtureId}/${variantReport.variantId}: hitRate=${variantReport.metrics.hitRate.toFixed(3)} exactPath=${variantReport.metrics.exactPathRate.toFixed(3)} exactSymbol=${variantReport.metrics.exactSymbolRate.toFixed(3)} contamination=${variantReport.metrics.contaminationRate.toFixed(3)} latencyP95=${variantReport.metrics.latencyP95Ms.toFixed(0)}ms`
      );
      if (variantReport.thresholdFailures.length > 0) {
        lines.push(`  Threshold failures: ${variantReport.thresholdFailures.join('; ')}`);
      }
    }
    lines.push('');
  }

  if (report.goldenGroupReports.length > 0) {
    lines.push('Golden group reports');
    lines.push('--------------------');
    for (const groupReport of report.goldenGroupReports) {
      lines.push(
        `${groupReport.fixtureId}/${groupReport.variantId}/${groupReport.groupId}: scenarios=${groupReport.scenarioCount} hitRate=${groupReport.metrics.hitRate.toFixed(3)} exactPath=${groupReport.metrics.exactPathRate.toFixed(3)} exactSymbol=${groupReport.metrics.exactSymbolRate.toFixed(3)} mrr=${groupReport.metrics.mrr.toFixed(3)} latencyP95=${groupReport.metrics.latencyP95Ms.toFixed(0)}ms`
      );
    }
    lines.push('');
  }

  if (report.experimentReports.length > 0) {
    lines.push('A/B Experiment Reports');
    lines.push('----------------------');
    for (const experimentReport of report.experimentReports) {
      const status = experimentReport.passed ? '✅ PASS' : '❌ FAIL';
      lines.push(`\n${experimentReport.fixtureId}/${experimentReport.experimentId}: ${status}`);
      lines.push(`  Baseline:  ${experimentReport.baselineVariantId}`);
      lines.push(`  Candidate: ${experimentReport.candidateVariantId}`);
      lines.push('');
      lines.push('  Metric Comparison:');
      lines.push(`  ${'-'.repeat(90)}`);
      lines.push(
        `  ${'Metric'.padEnd(18)} ${'Baseline'.padStart(10)} ${'Candidate'.padStart(10)} ${'Abs Δ'.padStart(10)} ${'% Lift'.padStart(10)} ${'Status'.padStart(8)}`
      );
      lines.push(`  ${'-'.repeat(90)}`);

      for (const comp of experimentReport.comparisons) {
        const status = comp.passed ? '✅' : '❌';
        const absLift =
          comp.absoluteLift >= 0
            ? `+${comp.absoluteLift.toFixed(3)}`
            : comp.absoluteLift.toFixed(3);
        const pctLift =
          comp.percentageLift >= 0
            ? `+${comp.percentageLift.toFixed(1)}%`
            : `${comp.percentageLift.toFixed(1)}%`;
        lines.push(
          `  ${comp.metric.padEnd(18)} ${comp.baseline.toFixed(3).padStart(10)} ${comp.candidate.toFixed(3).padStart(10)} ${absLift.padStart(10)} ${pctLift.padStart(10)} ${status.padStart(8)}`
        );
      }
      lines.push(`  ${'-'.repeat(90)}`);

      if (experimentReport.failures.length > 0) {
        lines.push('');
        lines.push('  Failures:');
        for (const failure of experimentReport.failures) {
          lines.push(`    • ${failure}`);
        }
      }
    }
    lines.push('');
    lines.push('Legend: Abs Δ = Absolute Lift, % Lift = Percentage Lift ((B-A)/A × 100)');
  }

  return lines.join('\n');
}

function printHelp() {
  console.log(`
Project RAG Evaluation Report Builder
=============================

Usage: bun run eval:project-rag:report [options]

Options:
  --fixture <id>      Filter by fixture ID (default: all fixtures)
  --variant <id>      Filter by variant ID(s), can be specified multiple times
  --capture <path>    Path to capture JSON file (required unless --plan-only)
  --write <path>      Write JSON report to file
  --json              Output JSON instead of human-readable format
  --plan-only         Show execution plan without evaluation (explicit)
  --help              Show this help message

Examples:
  # Show execution plan for all fixtures
  bun run eval:project-rag:report -- --plan-only

  # Evaluate a specific fixture with captured results
  bun run eval:project-rag:report -- --fixture fixture-ts-service --capture captures.json

  # Compare specific variants
  bun run eval:project-rag:report -- --fixture fixture-ts-service --variant legacy-docs-hybrid --variant project-hybrid --capture captures.json

  # Write JSON report
  bun run eval:project-rag:report -- --capture captures.json --write report.json --json
`);
}

export async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const parsedArgs = parseProjectEvalArgs(args);
  assertProjectEvalArgs(parsedArgs);

  if (parsedArgs.fixtureId && !getProjectFixture(parsedArgs.fixtureId)) {
    console.error(`Unknown fixture: ${parsedArgs.fixtureId}`);
    console.error(`Available fixtures: ${PROJECT_RAG_FIXTURES.map((f) => f.id).join(', ')}`);
    process.exit(1);
  }

  const captures = parsedArgs.capturePath ? loadCaptureFile(parsedArgs.capturePath) : [];
  const report = buildProjectEvalReport(captures, parsedArgs.fixtureId, parsedArgs.variantIds);

  if (parsedArgs.writePath) {
    const absoluteOutput = resolve(parsedArgs.writePath);
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    writeFileSync(absoluteOutput, JSON.stringify(report, null, 2));
    console.log(`Report written to: ${absoluteOutput}`);
  }

  if (parsedArgs.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (parsedArgs.planOnly) {
    console.log('No capture provided. Emitting execution plan only.\n');
    console.log('Use --capture <path> to evaluate captured results.\n');
  }

  console.log(formatHumanReport(report));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
