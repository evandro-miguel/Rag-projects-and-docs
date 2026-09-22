# A/B Testing Framework Implementation (T-21 to T-22)

## Summary

Implemented a comprehensive A/B testing framework for comparing retrieval variants in the Project RAG evaluation system. The framework supports variant comparison with lift calculations and detailed metric tracking.

## Changes Made

### 1. Enhanced Type Definitions (`types.ts`)

Added new interfaces for detailed A/B comparison:

- **`ProjectExperimentMetricComparison`**: Individual metric comparison with baseline, candidate, absolute lift, percentage lift, and pass/fail status
- Enhanced **`ProjectExperimentReport`** with:
  - `lifts`: Percentage lift for each metric ((B-A)/A × 100)
  - `comparisons`: Array of detailed per-metric comparisons
  - `baselineMetrics`: Baseline variant metrics snapshot
  - `candidateMetrics`: Candidate variant metrics snapshot

### 2. Enhanced Metrics Calculation (`metrics.ts`)

Updated `compareExperiment()` function to:

- Calculate percentage lifts using formula: `((candidate - baseline) / baseline) × 100`
- Build detailed `comparisons` array with per-metric pass/fail status
- Populate `baselineMetrics` and `candidateMetrics` for reference
- Include percentage lift in failure messages for better debugging

### 3. Enhanced Report Formatting (`run-project-rag-eval.ts`)

- Added `--variant <id>` option to filter specific variants
- Added `--help` option with usage documentation
- Enhanced human-readable output with:
  - Tabular metric comparison (Baseline, Candidate, Abs Δ, % Lift, Status)
  - Visual pass/fail indicators (✅/❌)
  - Detailed failure messages with percentage context
  - Legend explaining metrics
- JSON output now includes all new A/B testing fields

## Output Format

### Human-Readable Format

```
A/B Experiment Reports
----------------------

fixture-ts-service/project-hybrid-vs-legacy: ❌ FAIL
  Baseline:  legacy-docs-hybrid
  Candidate: project-hybrid

  Metric Comparison:
  ------------------------------------------------------------------------------------------
  Metric               Baseline  Candidate      Abs Δ     % Lift   Status
  ------------------------------------------------------------------------------------------
  hitRate                 1.000      1.000     +0.000      +0.0%        ❌
  exactPathRate           1.000      1.000     +0.000      +0.0%        ❌
  exactSymbolRate         1.000      1.000     +0.000      +0.0%        ❌
  avgQualityScore         0.805      1.000     +0.195     +24.3%        ✅
  latencyP95Ms          800.000    450.000   -350.000     -43.8%        ✅
  ------------------------------------------------------------------------------------------

  Failures:
    • hitRate lift 0.000 (0.0%) < 0.100
    • exactPathRate lift 0.000 (0.0%) < 0.100
    • exactSymbolRate lift 0.000 (0.0%) < 0.100

Legend: Abs Δ = Absolute Lift, % Lift = Percentage Lift ((B-A)/A × 100)
```

### JSON Format

```json
{
  "experimentReports": [
    {
      "fixtureId": "fixture-ts-service",
      "experimentId": "project-hybrid-vs-legacy",
      "baselineVariantId": "legacy-docs-hybrid",
      "candidateVariantId": "project-hybrid",
      "passed": false,
      "deltas": {
        "hitRate": 0,
        "exactPathRate": 0,
        "exactSymbolRate": 0,
        "avgQualityScore": 0.195,
        "latencyP95Ms": -350
      },
      "lifts": {
        "hitRatePercent": 0,
        "exactPathRatePercent": 0,
        "exactSymbolRatePercent": 0,
        "avgQualityScorePercent": 24.3,
        "latencyP95Percent": -43.8
      },
      "comparisons": [
        {
          "metric": "hitRate",
          "baseline": 1.0,
          "candidate": 1.0,
          "absoluteLift": 0,
          "percentageLift": 0,
          "passed": false
        }
        // ... more metrics
      ],
      "baselineMetrics": { /* ... */ },
      "candidateMetrics": { /* ... */ },
      "failures": [
        "hitRate lift 0.000 (0.0%) < 0.100"
      ]
    }
  ]
}
```

## Usage Examples

```bash
# Show execution plan
bun run eval:project-rag -- --plan-only

# Evaluate specific fixture with capture
bun run eval:project-rag -- --fixture fixture-ts-service --capture captures.json

# Compare specific variants only
bun run eval:project-rag -- --fixture fixture-ts-service --variant legacy-docs-hybrid --variant project-hybrid --capture captures.json

# Generate JSON report
bun run eval:project-rag -- --capture captures.json --write report.json --json
```

## Experiment Definitions

Experiments are defined in `fixtures.ts` with the following structure:

```typescript
{
  id: 'project-hybrid-vs-legacy',
  baselineVariantId: 'legacy-docs-hybrid',
  candidateVariantId: 'project-hybrid',
  minHitRateLift: 0.10,           // Minimum 10% lift required
  minExactPathLift: 0.10,         // Minimum 10% lift required
  minExactSymbolLift: 0.10,       // Minimum 10% lift required
  minQualityScoreLift: 0.08,      // Minimum 8% lift required
  maxLatencyRegressionMs: 200,    // Maximum 200ms regression allowed
}
```

## Available Variants

- `legacy-docs-hybrid`: Current mixed retrieval path (baseline)
- `project-keyword`: Project-scoped keyword retrieval
- `project-vector`: Project-scoped semantic retrieval
- `project-hybrid`: Combined project text and vector signals (target)

## Verification

All changes pass:
- ✅ TypeScript type checking
- ✅ Biome linting
- ✅ 106 test files (1993 tests)
- ✅ A/B comparison logic validated
