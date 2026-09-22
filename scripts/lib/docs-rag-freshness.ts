import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DocsRagFreshnessStatus = 'ok' | 'stale' | 'missing' | 'partial' | 'alert' | 'invalid';

export interface DocsRagSourceCoverage {
  expected: number;
  reported: number;
  missing: string[];
  reportedSourceIds: string[];
}

export interface DocsRagFreshness {
  status: DocsRagFreshnessStatus;
  reportPath: string;
  maxAgeHours: number;
  ageHours?: number;
  finishedAt?: string;
  syncStatus?: string;
  alerts: string[];
  sourceCoverage?: DocsRagSourceCoverage;
  warning?: string;
}

export interface DocsRagFreshnessOptions {
  cwd?: string;
  maxAgeHours?: number;
  now?: Date;
  expectedSourceIds?: readonly string[];
}

const DEFAULT_MAX_AGE_HOURS = 168;

function parseMaxAgeHours(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
}

function buildWarning(freshness: Omit<DocsRagFreshness, 'warning'>): string | undefined {
  if (freshness.status === 'ok') return undefined;
  if (freshness.status === 'missing') {
    return `Docs RAG sync report missing; run bun run sync:external.`;
  }
  if (freshness.status === 'stale') {
    return `Docs RAG sync is stale (${freshness.ageHours?.toFixed(1)}h old; max ${freshness.maxAgeHours}h); run bun run sync:external.`;
  }
  if (freshness.status === 'partial') {
    const coverage = freshness.sourceCoverage;
    const missing = coverage?.missing.slice(0, 8).join(', ');
    const suffix =
      coverage && coverage.missing.length > 8 ? `, +${coverage.missing.length - 8} more` : '';
    return `Docs RAG latest sync covers ${coverage?.reported ?? 0}/${coverage?.expected ?? 0} configured sources; missing ${missing}${suffix}; run bun run sync:external.`;
  }
  if (freshness.status === 'alert') {
    return `Docs RAG last sync reported alerts: ${freshness.alerts.join('; ')}`;
  }
  return `Docs RAG sync report is invalid; run bun run sync:external.`;
}

function readExpectedSourceIds(cwd: string): string[] {
  const sourcesPath = join(cwd, 'scripts', 'sources.json');
  if (!existsSync(sourcesPath)) return [];

  const parsed = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as {
    sources?: unknown;
  };
  if (!Array.isArray(parsed.sources)) return [];

  return parsed.sources
    .map((source) => {
      if (!source || typeof source !== 'object' || !('id' in source)) return undefined;
      return typeof source.id === 'string' ? source.id.trim() : undefined;
    })
    .filter((sourceId): sourceId is string => Boolean(sourceId));
}

function readSourceId(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const sourceRecord = source as Record<string, unknown>;
  for (const key of ['source', 'sourceId', 'sourceName', 'name']) {
    const value = sourceRecord[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readReportedSourceIds(reportSources: unknown): string[] {
  if (!Array.isArray(reportSources)) return [];

  return Array.from(
    new Set(
      reportSources
        .map((source) => readSourceId(source))
        .filter((sourceId): sourceId is string => Boolean(sourceId))
    )
  );
}

interface ParsedSyncReport {
  path: string;
  finishedAt?: string;
  status?: string;
  alerts: string[];
  sourceIds: string[];
}

function parseSyncReport(path: string): ParsedSyncReport | null {
  try {
    const report = JSON.parse(readFileSync(path, 'utf-8')) as {
      finishedAt?: unknown;
      status?: unknown;
      alerts?: unknown;
      sources?: unknown;
      dryRun?: unknown;
    };
    if (report.dryRun === true) return null;
    const finishedAt = typeof report.finishedAt === 'string' ? report.finishedAt : undefined;
    const status = typeof report.status === 'string' ? report.status : undefined;
    const alerts = Array.isArray(report.alerts)
      ? report.alerts.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      path,
      finishedAt,
      status,
      alerts,
      sourceIds: readReportedSourceIds(report.sources),
    };
  } catch {
    return null;
  }
}

function readSyncReports(reportDir: string, latestPath: string): ParsedSyncReport[] {
  const paths = new Set<string>();
  if (existsSync(latestPath)) paths.add(latestPath);
  if (existsSync(reportDir)) {
    for (const entry of readdirSync(reportDir)) {
      if (/^sync-report-.+\.json$/u.test(entry)) {
        paths.add(join(reportDir, entry));
      }
    }
  }
  return [...paths]
    .map((path) => parseSyncReport(path))
    .filter((report): report is ParsedSyncReport => report !== null);
}

function latestReportBySource(reports: readonly ParsedSyncReport[]): Map<string, ParsedSyncReport> {
  const bySource = new Map<string, ParsedSyncReport>();
  for (const report of reports) {
    const finishedTime = report.finishedAt ? new Date(report.finishedAt).getTime() : Number.NaN;
    if (!Number.isFinite(finishedTime)) continue;
    for (const sourceId of report.sourceIds) {
      const current = bySource.get(sourceId);
      const currentTime = current?.finishedAt ? new Date(current.finishedAt).getTime() : Number.NaN;
      if (!current || !Number.isFinite(currentTime) || finishedTime > currentTime) {
        bySource.set(sourceId, report);
      }
    }
  }
  return bySource;
}

function buildSourceCoverage(
  expectedSourceIds: readonly string[],
  reportedSourceIds: readonly string[]
): DocsRagSourceCoverage | undefined {
  if (expectedSourceIds.length === 0) return undefined;

  const reported = new Set(reportedSourceIds);
  const missing = expectedSourceIds.filter((sourceId) => !reported.has(sourceId));

  return {
    expected: expectedSourceIds.length,
    reported: reportedSourceIds.length,
    missing,
    reportedSourceIds: [...reportedSourceIds],
  };
}

export function readDocsRagFreshness(options: DocsRagFreshnessOptions = {}): DocsRagFreshness {
  const cwd = options.cwd ?? process.cwd();
  const maxAgeHours =
    options.maxAgeHours ?? parseMaxAgeHours(process.env.DOCS_RAG_FRESHNESS_MAX_AGE_HOURS);
  const now = options.now ?? new Date();
  const expectedSourceIds = options.expectedSourceIds ?? readExpectedSourceIds(cwd);
  const reportDir = join(cwd, '.data', 'reports', 'sync-external-docs');
  const reportPath = join(reportDir, 'latest.json');

  if (!existsSync(reportPath)) {
    const freshness = {
      status: 'missing' as const,
      reportPath,
      maxAgeHours,
      alerts: [],
    };
    return { ...freshness, warning: buildWarning(freshness) };
  }

  try {
    const reports = readSyncReports(reportDir, reportPath);
    const latestReport = parseSyncReport(reportPath);
    const bySource = latestReportBySource(reports);
    const reportedSourceIds =
      expectedSourceIds.length > 0
        ? expectedSourceIds.filter((sourceId) => bySource.has(sourceId))
        : (latestReport?.sourceIds ?? []);
    const sourceCoverage = buildSourceCoverage(expectedSourceIds, reportedSourceIds);
    const selectedReports =
      expectedSourceIds.length > 0
        ? reportedSourceIds.map((sourceId) => bySource.get(sourceId)).filter(Boolean)
        : latestReport
          ? [latestReport]
          : [];
    const newestSelectedTime = Math.max(
      ...selectedReports.map((report) =>
        report?.finishedAt ? new Date(report.finishedAt).getTime() : Number.NaN
      )
    );
    const oldestSelectedTime = Math.min(
      ...selectedReports.map((report) =>
        report?.finishedAt ? new Date(report.finishedAt).getTime() : Number.NaN
      )
    );
    const newestReport = reports.reduce<ParsedSyncReport | undefined>((newest, report) => {
      const reportTime = report.finishedAt ? new Date(report.finishedAt).getTime() : Number.NaN;
      const newestTime = newest?.finishedAt ? new Date(newest.finishedAt).getTime() : Number.NaN;
      return Number.isFinite(reportTime) &&
        (!newest || !Number.isFinite(newestTime) || reportTime > newestTime)
        ? report
        : newest;
    }, latestReport ?? undefined);
    const corpusFinishedTime =
      expectedSourceIds.length > 0 && reportedSourceIds.length > 0
        ? oldestSelectedTime
        : newestSelectedTime;
    const finishedAt = Number.isFinite(corpusFinishedTime)
      ? new Date(corpusFinishedTime).toISOString()
      : latestReport?.finishedAt;
    const syncStatus =
      selectedReports.some((report) => report?.status === 'alert') ||
      latestReport?.status === 'alert'
        ? 'alert'
        : (newestReport?.status ?? latestReport?.status);
    const alerts = Array.from(
      new Set(
        selectedReports.flatMap((report) => report?.alerts ?? []).concat(latestReport?.alerts ?? [])
      )
    );
    const finishedTime = finishedAt ? new Date(finishedAt).getTime() : Number.NaN;
    const ageHours = Number.isFinite(finishedTime)
      ? (now.getTime() - finishedTime) / 3_600_000
      : undefined;
    const status: DocsRagFreshnessStatus =
      alerts.length > 0 || syncStatus === 'alert'
        ? 'alert'
        : ageHours === undefined || ageHours < 0
          ? 'invalid'
          : ageHours > maxAgeHours
            ? 'stale'
            : sourceCoverage && sourceCoverage.missing.length > 0
              ? 'partial'
              : 'ok';
    const freshness = {
      status,
      reportPath,
      maxAgeHours,
      ageHours,
      finishedAt,
      syncStatus,
      alerts,
      sourceCoverage,
    };
    return { ...freshness, warning: buildWarning(freshness) };
  } catch (error) {
    const freshness = {
      status: 'invalid' as const,
      reportPath,
      maxAgeHours,
      alerts: [error instanceof Error ? error.message : String(error)],
    };
    return { ...freshness, warning: buildWarning(freshness) };
  }
}
