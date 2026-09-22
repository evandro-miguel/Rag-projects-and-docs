---
doc_type: module-doc
id: "scripts-lib-llm-refiner"
status: active
created_at: "2026-02-26T12:00:00Z"
updated_at: "2026-02-26T12:00:00Z"
links:
  parent: "scripts/lib/README.md"
---

# LLM Refiner Module

## Purpose

Refine external documentation by removing noise and increasing technical
information density before RAG ingestion.  Default behavior is deterministic
post-processing with no external LLM dependency.  An optional llama.cpp path
is available when explicitly configured.

## Location

`scripts/lib/llm-refiner.ts`

## Responsibilities

- Deterministic post-processing (noise stripping, frontmatter normalization)
- Optional llama.cpp LLM-based refinement via `LLM_REFINER_PROVIDER=llamacpp`
- Preserve code blocks and technical details
- Rewrite in concise, dense Markdown format
- Expand/overage guard (default 1.15× ratio limit)

## Architecture

### Overview

```
┌──────────────────────────────────────────────────────────────┐
│                   LLM Refiner Pipeline                       │
├──────────────────────────────────────────────────────────────┤
│  Input: Raw Markdown/HTML                                    │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────┐                                        │
│  │ Resolve Provider │ ← LLM_REFINER_PROVIDER                 │
│  └───────┬──────────┘                                        │
│          │                                                    │
│     ┌────┴────┐                                              │
│     ▼         ▼                                               │
│  ┌──────┐ ┌──────────┐                                       │
│  │ none │ │ llamacpp │                               │
│  └──┬───┘ └─────┬────┘                                       │
│     │           │                                             │
│     ▼           ▼                                             │
│  ┌──────────────────┐                                        │
│  │ Post-Process     │ ← Noise regexes, frontmatter normalize │
│  └────────┬─────────┘                                        │
│           │                                                   │
│           ▼                                                   │
│  Output: Refined Markdown                                    │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| **Post-process** | `llm-refiner.ts` | Deterministic noise stripping and frontmatter normalization |
| **llama.cpp** | `llm-refiner.ts` | Optional LLM-based refinement via local llama.cpp |
| **Prompt** | `ingest/prompts/refinement-prompt.md` | System instruction (fallback to embedded constant) |

## Exports

### Functions

| Function | Description | Signature |
|----------|-------------|-----------|
| `refineDocument` | Refine document (deterministic or llamacpp) | `(content: string, options?) => Promise<string>` |
| `postProcessRefinedContent` | Deterministic post-processing only | `(content: string, options?) => string` |
| `getRefinerRuntimeConfig` | Resolve provider and model config | `(env?) => RefinerRuntimeConfig` |

## Dependencies

### Internal

- None (self-contained module)

### External

- `p-retry` — Retry wrapper for llama.cpp HTTP calls
- `process.env` — Runtime configuration via env vars

## Usage Examples

### Basic Refinement (Deterministic)

```typescript
import { refineDocument } from './lib/llm-refiner.js';

const rawContent = `
# API Guide

Welcome to our amazing product! This is the best API ever.

## Navigation Menu
- Home
- Docs
- About Us
- Contact

## Usage

\`\`\`typescript
const client = new Client();
await client.connect();
\`\`\`

For more information, visit our website at...
`;

const refined = await refineDocument(rawContent);
// Returns cleaned content without marketing text and navigation
```

### External Docs Pipeline

```typescript
import { refineDocument } from './lib/llm-refiner.js';
import { readFile, writeFile } from 'node:fs/promises';

async function processExternalDoc(filePath: string) {
  const rawMd = await readFile(filePath, 'utf-8');
  const cleanMd = await refineDocument(rawMd);
  await writeFile(`processed/${filePath}`, cleanMd);
  console.log(`Refined: ${filePath}`);
}
```

### Enabling llama.cpp Refinement

```typescript
// Set in environment:
// LLM_REFINER_PROVIDER=llamacpp
// LLAMA_CPP_BASE_URL=http://127.0.0.1:8080

import { refineDocument } from './lib/llm-refiner.js';
const refined = await refineDocument(rawContent);
// Uses local llama.cpp; errors propagate when provider is explicitly set.
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_REFINER_PROVIDER` | No | `none` | Provider: `none` (deterministic) or `llamacpp` |
| `LLAMA_CPP_BASE_URL` | With llamacpp | `http://127.0.0.1:8080` | Base URL for llama.cpp server |
| `LLAMA_CPP_CHAT_PATH` | No | `/v1/chat/completions` | Chat completions path |
| `LLAMA_CPP_REFINER_MODEL` | No | `gemma` | Model name for llama.cpp |
| `LLAMA_CPP_API_KEY` | No | — | Optional API key for llamacpp |
| `REFINEMENT_PROMPT_PATH` | No | `ingest/prompts/refinement-prompt.md` | Custom refinement prompt file |
| `LLM_REFINER_MAX_EXPANSION_RATIO` | No | `1.15` | Max output/input ratio (1.0 = no expansion) |
| `LLM_REFINER_MIN_FRONTMATTER_CHARS` | No | `1200` | Min body chars to include frontmatter |
| `LLM_REFINER_INCLUDE_FRONTMATTER` | No | `false` | Include generated frontmatter in output |

### Provider Behavior

| Provider | Behavior |
|----------|----------|
| `none` (default) | Deterministic post-processing: noise stripping, frontmatter normalization. No external dependency. |
| `llamacpp` | Calls local llama.cpp endpoint. Errors are rethrown (not silently degraded). |

## System Prompt

The default prompt instructs the model to extract technical content:

```
You are an expert technical documentation summarizer and cleaner for a RAG system.

Your goal is to extract core technical knowledge, APIs, code examples, and architectural concepts.

You MUST:
- Remove UI/UX boilerplate, navigation menus, long licenses
- Remove redundant marketing text and filler words
- Rewrite into high-density, concise Markdown format
- Keep all code blocks intact
- Output ONLY the processed Markdown (no conversational text)
```

## Testing

### Test Location

`scripts/lib/tests/llm-refiner.test.ts`

### Running Tests

```bash
bun test scripts/lib/tests/llm-refiner.test.ts
```

### Notable Test Cases

- TC-01: Deterministic post-processing by default (no LLM)
- TC-02: llamacpp provider calls the correct endpoint
- TC-03: llamacpp errors propagate (no silent fallback) when explicitly configured
- TC-04: Expansion guard limits bloated output
- TC-05: MDX noise removal outside code fences
- TC-06: YAML frontmatter normalization

## Related Modules

- [[scripts/sync-external-docs]](../sync-external-docs.ts) — Pipeline that uses this module
- [[scripts/lib/hash]](./hash.ts) — Hash-based caching
- [External document sync implementation](../../scripts/sync-external-docs.ts) — Post-refinement pipeline

## Change Log

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-02-26 | 1.0.0 | Initial module documentation | orchestrator |
| 2026-07-18 | 1.1.0 | Retired Gemini; documented deterministic + llamacpp only | agent |

---

*Module Documentation: `scripts/lib/llm-refiner.md`*
*Last Updated: 2026-07-18*
