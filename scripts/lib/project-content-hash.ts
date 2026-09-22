import { SCRIPT_CONFIG } from './config.js';
import { calculateHash } from './hash.js';

export interface ProjectContentHashConfig {
  chunkSize: number;
  chunkOverlap: number;
  model: string;
}

export function buildProjectContentHashSeed(
  config: ProjectContentHashConfig = {
    chunkSize: SCRIPT_CONFIG.CHUNK_SIZE,
    chunkOverlap: SCRIPT_CONFIG.CHUNK_OVERLAP,
    model: SCRIPT_CONFIG.EMBEDDING_MODEL,
  }
): string {
  return JSON.stringify({
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    model: config.model,
  });
}

export async function calculateProjectContentHash(
  content: string,
  config?: ProjectContentHashConfig
): Promise<string> {
  return await calculateHash(`${buildProjectContentHashSeed(config)}::${content}`);
}
