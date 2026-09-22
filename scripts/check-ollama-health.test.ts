import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessEmbeddingLatency,
  checkLlamaCppGpuOffload,
  checkLlamaCppGpuOffloadDuringRequest,
  checkModel,
  resolveEmbeddingBaseUrl,
  resolveEmbeddingHealthProfile,
  resolveEmbeddingHealthTarget,
  resolveEmbeddingModel,
  resolveEmbeddingProvider,
  validateEmbeddingResponse,
} from './check-embedding-health.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveEmbeddingProvider', () => {
  it('defaults to llama.cpp for this RAG system', () => {
    expect(resolveEmbeddingProvider({})).toBe('llamacpp');
  });

  it('rejects Ollama because this RAG system only supports llama.cpp', () => {
    expect(() => resolveEmbeddingProvider({ EMBEDDING_PROVIDER: 'ollama' })).toThrow(
      'Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.'
    );
  });
});

describe('resolveEmbeddingModel', () => {
  it('prefers llama.cpp model env over the shared embedding envs', () => {
    expect(
      resolveEmbeddingModel({
        LLAMACPP_EMBEDDING_MODEL: 'qwen3-embedding-gguf',
        EMBEDDING_MODEL: 'bge-m3',
        OLLAMA_MODEL: 'mxbai-embed-large',
      })
    ).toBe('qwen3-embedding-gguf');
  });

  it('falls back to EMBEDDING_MODEL when provider-specific env is absent', () => {
    expect(
      resolveEmbeddingModel({
        EMBEDDING_MODEL: 'bge-m3',
        OLLAMA_MODEL: 'mxbai-embed-large',
      })
    ).toBe('bge-m3');
  });

  it('ignores legacy Ollama names unless Ollama mode is explicit', () => {
    expect(resolveEmbeddingModel({ OLLAMA_MODEL: 'mxbai-embed-large' })).toBe(
      'qwen3-embedding-1024'
    );
    expect(resolveEmbeddingModel({})).toBe('qwen3-embedding-1024');
  });

  it('rejects explicit Ollama mode before model resolution', () => {
    expect(() =>
      resolveEmbeddingModel({
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text',
        EMBEDDING_MODEL: 'bge-m3',
      })
    ).toThrow('Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.');
  });
});

describe('resolveEmbeddingBaseUrl', () => {
  it('defaults host-side checks to the RAG-scoped llama.cpp endpoint', () => {
    expect(resolveEmbeddingBaseUrl({})).toBe('http://127.0.0.1:8082');
  });

  it('rejects explicit Ollama mode before base URL resolution', () => {
    expect(() =>
      resolveEmbeddingBaseUrl({
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: 'http://localhost:11434',
      })
    ).toThrow('Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.');
  });
});

describe('resolveEmbeddingHealthProfile', () => {
  it('uses the default lane unless a project profile is requested', () => {
    expect(resolveEmbeddingHealthProfile([], {})).toBe('default');
  });

  it('accepts the explicit project-rag profile flag', () => {
    expect(resolveEmbeddingHealthProfile(['--project-rag'], {})).toBe('project-rag');
    expect(resolveEmbeddingHealthProfile([], { EMBEDDING_HEALTH_PROFILE: 'project-rag' })).toBe(
      'project-rag'
    );
  });
});

describe('resolveEmbeddingHealthTarget', () => {
  it('keeps the default lane on the Project RAG GPU dimensions', () => {
    expect(resolveEmbeddingHealthTarget([], {})).toMatchObject({
      profile: 'default',
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'qwen3-embedding-1024',
      expectedDimensions: 1024,
    });
  });

  it('derives the project lane from the Project RAG embedding config', () => {
    expect(resolveEmbeddingHealthTarget(['--project-rag'], {})).toMatchObject({
      profile: 'project-rag',
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'qwen3-embedding-1024',
      expectedDimensions: 1024,
      timeoutMs: 60000,
    });
  });

  it('rejects explicit Ollama mode before resolving the health target', () => {
    expect(() =>
      resolveEmbeddingHealthTarget([], {
        EMBEDDING_PROVIDER: 'ollama',
      })
    ).toThrow('Unsupported EMBEDDING_PROVIDER "ollama". This RAG system requires llama.cpp.');
  });

  it('lets explicit dimension overrides win over the profile default', () => {
    expect(
      resolveEmbeddingHealthTarget(['--project-rag', '--dimensions', '768'], {
        EMBEDDING_EXPECTED_DIMENSIONS: '512',
      })
    ).toMatchObject({
      expectedDimensions: 768,
    });
  });

  it('uses EMBEDDING_EXPECTED_DIMENSIONS when only the env override is set', () => {
    expect(
      resolveEmbeddingHealthTarget([], {
        EMBEDDING_EXPECTED_DIMENSIONS: '1536',
      })
    ).toMatchObject({
      expectedDimensions: 1536,
    });
  });

  it('keeps legacy EMBEDDING_DIMENSIONS overrides working for existing scripts', () => {
    expect(
      resolveEmbeddingHealthTarget([], {
        EMBEDDING_DIMENSIONS: '2048',
      })
    ).toMatchObject({
      expectedDimensions: 2048,
    });
  });
});

describe('validateEmbeddingResponse', () => {
  it('fails when embed response is missing embeddings array', () => {
    const result = validateEmbeddingResponse({});
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Invalid response');
  });

  it('fails when embedding dimensions are incorrect', () => {
    const result = validateEmbeddingResponse({ embeddings: [new Array(128).fill(0)] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Wrong dimensions');
    expect(result.details).toContain('Expected 1024 dimensions');
  });

  it('passes when embedding shape and dimensions are valid', () => {
    const result = validateEmbeddingResponse({ embeddings: [[0, 1, 2]] }, 3);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('3 dimensions');
  });

  it('accepts OpenAI-compatible llama.cpp embeddings responses', () => {
    const result = validateEmbeddingResponse({ data: [{ embedding: [0, 1, 2] }] }, 3);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('3 dimensions');
  });
});

describe('checkLlamaCppGpuOffload', () => {
  it('keeps static CUDA capability evidence non-green', () => {
    const result = checkLlamaCppGpuOffload('llamacpp', 'http://127.0.0.1:8082', (command) => {
      if (command.startsWith('lsof')) return '1234\n';
      if (command.includes('/proc/1234/maps')) {
        return '/usr/local/lib/libggml-cuda.so.0\n/usr/lib/wsl/lib/libcuda.so.1\n';
      }
      if (command.includes('/proc/1234/fd')) return '/dev/dxg\n';
      throw new Error(`unexpected command: ${command}`);
    });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('request-time GPU offload unproven');
  });

  it('fails when the local listener has no CUDA evidence', () => {
    const result = checkLlamaCppGpuOffload('llamacpp', 'http://127.0.0.1:8082', (command) => {
      if (command.startsWith('lsof')) return '1234\n';
      throw new Error(`unexpected command: ${command}`);
    });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.message).toContain('offload unproven');
  });

  it('passes only when the same current-boot listener reports full GPU offload and a new request', async () => {
    let requestCompleted = false;
    const completionJournalCommands: string[] = [];
    const operation = vi.fn(async () => {
      requestCompleted = true;
      return 'ready';
    });
    const result = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      operation,
      (command) => {
        if (command.startsWith('lsof')) return '1234\n';
        if (command.includes("--grep='offloaded")) {
          return 'load_tensors: offloaded 29/29 layers to GPU\n';
        }
        if (command.includes("--grep='done request")) {
          completionJournalCommands.push(command);
          return JSON.stringify({
            __CURSOR: requestCompleted ? 'cursor-after' : 'cursor-before',
            MESSAGE: 'srv log_server_r: done request: POST /v1/embeddings loopback 200',
          });
        }
        throw new Error(`unexpected command: ${command}`);
      }
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(result.value).toBe('ready');
    expect(result.gpu.ok).toBe(true);
    expect(result.gpu.message).toContain('PID 1234');
    expect(result.gpu.details).toContain('29/29');
    expect(completionJournalCommands.every((command) => command.includes('--lines=1'))).toBe(true);
  });

  it('waits for a completed embedding request to become visible in the journal', async () => {
    let requestCompleted = false;
    let postRequestJournalReads = 0;
    const result = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      async () => {
        requestCompleted = true;
        return 'ready';
      },
      (command) => {
        if (command.startsWith('lsof')) return '1234\n';
        if (command.includes("--grep='offloaded")) {
          return 'load_tensors: offloaded 29/29 layers to GPU\n';
        }
        if (command.includes("--grep='done request")) {
          if (!requestCompleted) return '';
          postRequestJournalReads += 1;
          return postRequestJournalReads >= 2
            ? 'srv log_server_r: done request: POST /v1/embeddings loopback 200\n'
            : '';
        }
        throw new Error(`unexpected command: ${command}`);
      },
      async () => {}
    );

    expect(result.value).toBe('ready');
    expect(result.gpu.ok).toBe(true);
    expect(postRequestJournalReads).toBeGreaterThanOrEqual(2);
  });

  it('stays non-green after a real request when full GPU offload is not reported', async () => {
    let requestCompleted = false;
    const result = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      async () => {
        requestCompleted = true;
        return 'ready';
      },
      (command) => {
        if (command.startsWith('lsof')) return '1234\n';
        if (command.includes("--grep='offloaded")) return '';
        if (command.includes("--grep='done request")) {
          return requestCompleted
            ? 'srv log_server_r: done request: POST /v1/embeddings loopback 200\n'
            : '';
        }
        if (command.includes('/proc/1234/maps')) {
          return '/usr/local/lib/libggml-cuda.so.0\n/usr/lib/wsl/lib/libcuda.so.1\n';
        }
        if (command.includes('/proc/1234/fd')) return '/dev/dxg\n';
        throw new Error(`unexpected command: ${command}`);
      }
    );

    expect(result.value).toBe('ready');
    expect(result.gpu.ok).toBe(false);
    expect(result.gpu.message).toContain('unproven after real embedding request');
  });

  it('does not attribute an unowned user unit when the listener PID is invisible', async () => {
    let requestCompleted = false;
    const unitJournalCommands: string[] = [];
    const operation = vi.fn(async () => {
      requestCompleted = true;
      return 'ready';
    });
    const result = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      operation,
      (command) => {
        if (
          command.startsWith('lsof') ||
          command.startsWith('fuser') ||
          command.startsWith('ss ')
        ) {
          return '';
        }
        if (command.includes('--user-unit')) {
          unitJournalCommands.push(command);
          return command.includes("--grep='offloaded")
            ? 'load_tensors: offloaded 29/29 layers to GPU\n'
            : JSON.stringify({
                __CURSOR: requestCompleted ? 'cursor-after' : 'cursor-before',
                MESSAGE: 'srv log_server_r: done request: POST /v1/embeddings loopback 200',
              });
        }
        throw new Error(`unexpected command: ${command}`);
      },
      async () => {}
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(result.value).toBe('ready');
    expect(result.gpu.ok).toBe(false);
    expect(result.gpu.message).toContain('unproven after real embedding request');
    expect(result.gpu.details).toContain('No visible listener PID');
    expect(unitJournalCommands).toHaveLength(0);
  });

  it('does not attribute a journal completion when concurrent listeners share the endpoint', async () => {
    const journalCommands: string[] = [];
    const operation = vi.fn(async () => 'ready');
    const result = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      operation,
      (command) => {
        if (command.startsWith('lsof')) return '1234\n5678\n';
        if (command.startsWith('fuser') || command.startsWith('ss ')) return '';
        if (command.startsWith('ps ') || command.startsWith('find ')) return '';
        if (command.includes('--user-unit') || command.includes('journalctl')) {
          journalCommands.push(command);
          return 'load_tensors: offloaded 29/29 layers to GPU\n';
        }
        throw new Error(`unexpected command: ${command}`);
      },
      async () => {}
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(result.value).toBe('ready');
    expect(result.gpu.ok).toBe(false);
    expect(result.gpu.message).toContain('unproven after real embedding request');
    expect(result.gpu.details).toContain('Multiple listener PIDs');
    expect(journalCommands).toHaveLength(0);
  });

  it('does not use the unit fallback for noncanonical endpoints or dimensions', async () => {
    const calls: string[] = [];
    const execText = (command: string) => {
      calls.push(command);
      if (command.includes('--user-unit')) {
        throw new Error('unit fallback must stay disabled');
      }
      if (command.startsWith('lsof') || command.startsWith('fuser') || command.startsWith('ss ')) {
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const noncanonical = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://localhost:8082',
      async () => 'ready',
      execText,
      async () => {}
    );
    const wrongDimensions = await checkLlamaCppGpuOffloadDuringRequest(
      'llamacpp',
      'http://127.0.0.1:8082',
      async () => 'ready',
      execText,
      async () => {},
      4096
    );

    expect(noncanonical.gpu.ok).toBe(false);
    expect(wrongDimensions.gpu.ok).toBe(false);
    expect(calls.some((command) => command.includes('--user-unit'))).toBe(false);
  });
});

describe('checkModel', () => {
  it('hard-fails llama.cpp when the configured model is not listed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'nomic-embed-text' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const result = await checkModel('llamacpp', 'http://127.0.0.1:8082', 'qwen3-embedding', 50);

    expect(result.ok).toBe(false);
    expect(result.level).toBe('error');
    expect(result.message).toBe('Configured model name not listed');
    expect(result.details).toContain('nomic-embed-text');
  });

  it('keeps model mismatch degraded only when explicitly allowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'nomic-embed-text' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const result = await checkModel(
      'llamacpp',
      'http://127.0.0.1:8082',
      'qwen3-embedding',
      50,
      true
    );

    expect(result.ok).toBe(true);
    expect(result.level).toBe('warning');
    expect(result.message).toBe('Configured model name not listed; endpoint is still scoped');
  });
});

describe('assessEmbeddingLatency', () => {
  it('marks fast embeddings as healthy', () => {
    const result = assessEmbeddingLatency(4200, 5000);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
  });

  it('marks slow embeddings as degraded warning without failing readiness', () => {
    const result = assessEmbeddingLatency(7800, 5000);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('warning');
    expect(result.details).toContain('degraded');
  });
});
