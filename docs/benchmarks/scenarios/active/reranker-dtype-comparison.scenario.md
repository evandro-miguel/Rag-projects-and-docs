---
schema_version: "1.0.0"
scenario_id: "reranker-dtype-comparison"
title: "Reranker q8 versus fp32 comparison"
feature: "docs-rag-reranker"
journey_type: "api"
status: "active"
version: "1.0.0"
priority: "high"
owner_agent: "benchmarking-agent"

entrypoints:
  routes: []
  commands:
    - "bun run bench:reranker-dtypes"
  endpoints:
    - "POST /rerank"

required_tools:
  - "bun"

benchmark_modes:
  light:
    repetitions: 1
    warmup_runs: 1
    artifacts: "on_failure_minimal"
  standard:
    repetitions: 3
    warmup_runs: 1
    artifacts: "on_failure"
  deep:
    repetitions: 5
    warmup_runs: 1
    artifacts: "enabled"
  diagnostic:
    repetitions: 1
    warmup_runs: 0
    artifacts: "full"

thresholds:
  errors:
    fail_above: 0
  top1_accuracy:
    fail_below: 1
  ranking_spearman:
    warn_below: 0.95

baseline:
  strategy: "same_run_q8_control"
  fallback: "mark_as_baseline_candidate"
---

<!-- markdownlint-disable MD013 -->

## Objective

Compare the local cross-encoder reranker with `q8` and `fp32` model weights under equivalent warm-cache requests.

## Preconditions

- Bun dependencies are installed.
- The Hugging Face model is available from the local cache or the network.
- Ports `3461` and `3462` are available on loopback.

## Test Data

- Four fixed English queries.
- Six fixed documents per query.
- The first document in every case is the expected top result.
- Both arms use `Xenova/ms-marco-MiniLM-L-6-v2`.

## Steps

1. Start an isolated reranker process for one dtype.
2. Wait for its loopback health endpoint.
3. Run one unmeasured warmup pass over every fixture.
4. Run the configured number of measured passes.
5. Capture client latency, server latency, RSS, scores, and top-1 accuracy.
6. Stop the process and repeat for the other dtype.
7. Compare score deltas and ranking correlation between the two arms.

## Expected Result

Both dtypes return finite, non-uniform scores and rank the expected document first for every fixture.

## Required Metrics

- setup_duration_ms
- request_latency_p50_ms
- request_latency_p95_ms
- server_latency_p50_ms
- rss_peak_mb
- top1_accuracy
- score_mae
- score_max_abs_delta
- ranking_spearman_mean

## Success Criteria

- Both arms complete without request or inference errors.
- Both arms achieve `top1_accuracy = 1`.
- Mean Spearman rank correlation is at least `0.95`.
- The run writes normalized JSON and a Markdown report.

## Failure Criteria

- The service cannot start or returns a non-2xx response.
- A response contains missing, non-finite, or uniform fallback scores.
- Either arm fails the top-1 accuracy threshold.
- Required artifacts are missing.

## Expected Artifacts

- Normalized JSON output.
- Markdown report.
- Service stdout and stderr logs for both arms.

## Notes For Agents

- Treat setup duration as diagnostic because the model cache and network affect it.
- Use warm-cache request latency for the primary performance comparison.
- Do not run against an external service or production endpoint.
