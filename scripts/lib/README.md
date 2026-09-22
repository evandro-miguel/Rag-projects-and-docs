---
doc_type: module-doc
id: "scripts-lib"
status: active
created_at: "2026-02-25T00:00:00Z"
updated_at: "2026-02-25T00:00:00Z"
---

# Scripts lib Module

## Purpose

Shared utilities and configuration for all operational scripts.

## Location

`scripts/lib/`

## Responsibilities

- Provide centralized configuration
- Offer file operation utilities
- Generate consistent hashes
- Share ingestion logic
- Refine content with LLM

## Components

| Component | File | Description |
|-----------|------|-------------|
| **Config** | `config.ts` | Script configuration |
| **File Helpers** | `file-helpers.ts` | File operations |
| **Hash** | `hash.ts` | Hash utilities |
| **Ingest Shared** | `ingest-shared.ts` | Shared ingestion logic |
| **LLM Refiner** | `llm-refiner.ts` | LLM refinement |

## Exports

### Configuration

| Constant | Type | Description |
|----------|------|-------------|
| `SCRIPT_CONFIG` | object | Script-wide configuration |
| `chunking` | object | Chunking settings |
| `embedding` | object | Embedding settings |
| `search` | object | Search settings |

### Functions

| Function | Description |
|----------|-------------|
| `readFileSafe` | Read file with error handling |
| `writeFileSafe` | Write file with error handling |
| `ensureDirectory` | Create directory if not exists |
| `calculateHash` | Calculate file hash |
| `compareHashes` | Compare two hashes |
| `prepareForIngestion` | Prepare document for ingestion |
| `refineWithLLM` | Refine content with LLM |

## Dependencies

### Internal

- `scripts/lib/config` - Shared configuration
- `scripts/lib/project-content-hash` - Hash utilities

### External

- `node:fs` - File system
- `node:crypto` - Crypto utilities
- `@google/generative-ai` - Gemini API (for LLM refiner)

## Usage Examples

### Configuration

```typescript
import { SCRIPT_CONFIG } from '../lib/config.js';

console.log(`Chunk size: ${SCRIPT_CONFIG.chunking.chunkSize}`);
console.log(`Embedding model: ${SCRIPT_CONFIG.embedding.model}`);
```

### File Operations

```typescript
import { readFileSafe, writeFileSafe, ensureDirectory } from '../lib/file-helpers.js';

// Read file
const content = await readFileSafe('/path/to/file.md');

// Write file
await writeFileSafe('/path/to/output.md', content);

// Ensure directory exists
await ensureDirectory('/path/to/output/');
```

### Hash Operations

```typescript
import { calculateHash, compareHashes } from '../lib/hash.js';

// Calculate hash
const hash = await calculateHash('/path/to/file.md');

// Compare hashes
const hasChanged = await compareHashes(hash1, hash2);
if (hasChanged) {
  console.log('File has changed');
}
```

### Ingestion Preparation

```typescript
import { prepareForIngestion } from '../lib/ingest-shared.js';

const prepared = await prepareForIngestion({
  content: '...',
  title: 'My Document',
  category: 'Documentation',
});

console.log(`Chunks: ${prepared.chunks.length}`);
console.log(`Embeddings: ${prepared.embeddings.length}`);
```

### LLM Refinement

```typescript
import { refineWithLLM } from '../lib/llm-refiner.js';

const refined = await refineWithLLM({
  content: '...',
  instruction: 'Improve clarity and add examples',
});

console.log(refined.content);
```

## Configuration

### Chunking Settings

| Option | Default | Description |
|--------|---------|-------------|
| `chunkSize` | 500 | Characters per chunk |
| `chunkOverlap` | 50 | Overlap between chunks |

### Embedding Settings

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `qwen3-embedding` | Local embedding model |
| `dimensions` | 4096 | Project RAG dimensions; 1024 uses the lab lane |
| `batchSize` | 25 | Embeddings per batch |

### Search Settings

| Option | Default | Description |
|--------|---------|-------------|
| `limit` | 10 | Default search limit |
| `timeout` | 15000 | Search timeout (ms) |

## Data Flow

### File Reading

```text
File Path → readFileSafe → Content String
                │
                └─> Error handling
                └─> Encoding (UTF-8)
```

### Hash Calculation

```text
File Path → read file → crypto.createHash('sha256') → Hash String
```

### Ingestion Preparation

```text
Document → prepareForIngestion
              │
              ├─> Chunk content
              ├─> Generate embeddings
              └─> Return { chunks, embeddings }
```

### LLM Refinement

```text
Content → refineWithLLM → Gemini API → Refined Content
```

## Error Handling

### Error Types

| Error | When Thrown | Recovery |
|-------|-------------|----------|
| `FileNotFoundError` | File doesn't exist | Return null or default |
| `HashError` | Hash calculation failed | Retry or skip |
| `EmbeddingError` | Gemini API failure | Retry with backoff |
| `LLMError` | LLM refinement failed | Return original content |

## Performance Considerations

### Optimization Strategies

- **Batching**: Batch file operations when possible
- **Caching**: Cache file reads for repeated access
- **Streaming**: Use streams for large files
- **Parallel**: Process multiple files concurrently

## Testing

### Test Location

`scripts/lib/` (tests to be added)

### Running Tests

```bash
# Test utilities
bun test scripts/lib/
```

## Related Modules

- [[scripts/lib/project-content-hash]](./project-content-hash.ts) - Backend hash utilities
- [[scripts/lib/config]](./config.ts) - Backend configuration
- [[scripts/docs-sync]](../docs-sync/README.md) - Sync pipeline
- [[scripts]](../README.md) - Scripts overview

## Related Documentation

- See the [scripts overview](../README.md) for product entry points.

## Change Log

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-02-25 | 1.0.0 | Initial module documentation | orchestrator |

---

*Module Documentation: `scripts/lib/README.md`*
*Last Updated: 2026-02-25*
