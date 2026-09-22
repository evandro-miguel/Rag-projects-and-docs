export interface ProjectSearchResult {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  searchableText: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
  symbolKind?: string;
  score: number;
}

export interface ProjectSearchLaneDiagnostics {
  lane: string;
  status: 'executed' | 'skipped';
  candidateCount: number;
  reason?: string;
  latencyMs?: number;
}

export interface ProjectSearchPipelineDiagnostics {
  pipeline: string;
  mode: 'keyword' | 'vector' | 'hybrid';
  deterministic: boolean;
  fusion: string;
  lanes: ProjectSearchLaneDiagnostics[];
  candidates: {
    text: number;
    vector: number;
    merged: number;
    returned: number;
  };
  totalLatencyMs?: number;
}
