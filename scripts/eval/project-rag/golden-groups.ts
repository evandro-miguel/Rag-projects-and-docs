import { summarizeScenarioMetrics } from './metrics.js';
import type {
  ProjectEvalGoldenGroupId,
  ProjectEvalScenario,
  ProjectFixtureManifest,
  ProjectGoldenGroupReport,
  ProjectScenarioEvaluation,
  ProjectVariantReport,
} from './types.js';

export const PROJECT_GOLDEN_GROUP_LABELS: Record<ProjectEvalGoldenGroupId, string> = {
  'project-lexical': 'Project RAG Lexical',
  'project-conceptual': 'Project RAG Conceptual',
  'project-symbol-graph': 'Project RAG Symbol Graph',
  'project-caller-reference': 'Project RAG Caller/Reference',
  'project-active-file': 'Project RAG Active File',
};

function hasTag(scenario: ProjectEvalScenario, tag: string): boolean {
  return (scenario.tags ?? []).some((value) => value.toLowerCase() === tag);
}

export function resolveScenarioGoldenGroup(
  scenario: ProjectEvalScenario
): ProjectEvalGoldenGroupId {
  if (hasTag(scenario, 'callers') || hasTag(scenario, 'caller') || hasTag(scenario, 'reference')) {
    return 'project-caller-reference';
  }

  if (scenario.category === 'graph') {
    return 'project-symbol-graph';
  }

  if (scenario.category === 'drift' || hasTag(scenario, 'incremental-sync')) {
    return 'project-active-file';
  }

  if (scenario.category === 'fallback') {
    return 'project-conceptual';
  }

  return 'project-lexical';
}

export function buildGoldenGroupReports(
  fixture: ProjectFixtureManifest,
  variantReport: ProjectVariantReport
): ProjectGoldenGroupReport[] {
  const scenarioById = new Map(fixture.scenarios.map((scenario) => [scenario.id, scenario]));
  const grouped = new Map<ProjectEvalGoldenGroupId, ProjectScenarioEvaluation[]>();

  for (const evaluation of variantReport.scenarios) {
    const scenario = scenarioById.get(evaluation.scenarioId);
    if (!scenario) {
      continue;
    }
    const groupId = resolveScenarioGoldenGroup(scenario);
    const current = grouped.get(groupId) ?? [];
    current.push(evaluation);
    grouped.set(groupId, current);
  }

  return Array.from(grouped.entries()).map(([groupId, evaluations]) => ({
    fixtureId: fixture.id,
    variantId: variantReport.variantId,
    groupId,
    groupLabel: PROJECT_GOLDEN_GROUP_LABELS[groupId],
    scenarioCount: evaluations.length,
    metrics: summarizeScenarioMetrics(evaluations),
    scenarioIds: evaluations.map((evaluation) => evaluation.scenarioId),
  }));
}
