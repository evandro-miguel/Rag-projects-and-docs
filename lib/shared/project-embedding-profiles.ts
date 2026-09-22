export type ProjectEmbeddingProfileId = 'qwen3-8b-4096' | 'qwen3-4b-2560' | 'qwen3-0.6b-1024';

export type ProjectEmbeddingProfileStage = 'current' | 'lab';
export type ProjectEmbeddingDimensions = 4096 | 2560 | 1024;
export type ProjectVectorIndexedEmbeddingDimensions = 4096 | 1024;
export type ProjectEmbeddingTableName = 'project_embeddings_4096' | 'project_embeddings_1024';

export interface ProjectEmbeddingProfile {
  readonly id: ProjectEmbeddingProfileId;
  readonly stage: ProjectEmbeddingProfileStage;
  readonly dimensions: ProjectEmbeddingDimensions;
  readonly model: 'qwen3-embedding' | 'qwen3-embedding-1024';
  readonly provider: 'llamacpp';
  readonly vectorIndexed: boolean;
}

export const PROJECT_EMBEDDING_PROFILES = {
  'qwen3-8b-4096': {
    id: 'qwen3-8b-4096',
    stage: 'current',
    dimensions: 4096,
    model: 'qwen3-embedding',
    provider: 'llamacpp',
    vectorIndexed: true,
  },
  'qwen3-4b-2560': {
    id: 'qwen3-4b-2560',
    stage: 'lab',
    dimensions: 2560,
    model: 'qwen3-embedding',
    provider: 'llamacpp',
    vectorIndexed: false,
  },
  'qwen3-0.6b-1024': {
    id: 'qwen3-0.6b-1024',
    stage: 'current',
    dimensions: 1024,
    model: 'qwen3-embedding-1024',
    provider: 'llamacpp',
    vectorIndexed: true,
  },
} as const satisfies Record<ProjectEmbeddingProfileId, ProjectEmbeddingProfile>;

export const DEFAULT_PROJECT_EMBEDDING_PROFILE_ID = 'qwen3-0.6b-1024';

export const DEFAULT_PROJECT_EMBEDDING_PROFILE =
  PROJECT_EMBEDDING_PROFILES[DEFAULT_PROJECT_EMBEDDING_PROFILE_ID];

export const PROJECT_EMBEDDING_DIMENSIONS = DEFAULT_PROJECT_EMBEDDING_PROFILE.dimensions;
export const DEFAULT_PROJECT_EMBEDDING_MODEL = DEFAULT_PROJECT_EMBEDDING_PROFILE.model;
export const DEFAULT_PROJECT_EMBEDDING_PROVIDER = DEFAULT_PROJECT_EMBEDDING_PROFILE.provider;

export function getProjectEmbeddingProfile(
  profileId: ProjectEmbeddingProfileId
): ProjectEmbeddingProfile {
  return PROJECT_EMBEDDING_PROFILES[profileId];
}

export const PROJECT_VECTOR_INDEXED_EMBEDDING_DIMENSIONS = [4096, 1024] as const;
const PROJECT_EMBEDDING_TABLE_BY_DIMENSIONS = {
  4096: 'project_embeddings_4096',
  1024: 'project_embeddings_1024',
} as const satisfies Record<ProjectVectorIndexedEmbeddingDimensions, ProjectEmbeddingTableName>;

export function isProjectVectorIndexedEmbeddingDimensions(
  dimensions: number
): dimensions is ProjectVectorIndexedEmbeddingDimensions {
  return PROJECT_VECTOR_INDEXED_EMBEDDING_DIMENSIONS.includes(
    dimensions as ProjectVectorIndexedEmbeddingDimensions
  );
}

export function formatProjectVectorIndexedEmbeddingDimensions(): string {
  return PROJECT_VECTOR_INDEXED_EMBEDDING_DIMENSIONS.join(', ');
}

export function getProjectEmbeddingTableForDimensions(
  dimensions: ProjectVectorIndexedEmbeddingDimensions
): ProjectEmbeddingTableName {
  return PROJECT_EMBEDDING_TABLE_BY_DIMENSIONS[dimensions];
}

export function isProjectEmbeddingProfileId(value: string): value is ProjectEmbeddingProfileId {
  return value in PROJECT_EMBEDDING_PROFILES;
}

export function parseProjectEmbeddingProfileId(
  value: string | undefined
): ProjectEmbeddingProfileId | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isProjectEmbeddingProfileId(value)) {
    throw new Error(`Unknown project embedding profile: ${value}`);
  }

  return value;
}

export interface ProjectVectorIndexedEmbeddingLane {
  readonly profileId: ProjectEmbeddingProfileId;
  readonly dimensions: ProjectVectorIndexedEmbeddingDimensions;
  readonly table: ProjectEmbeddingTableName;
}

export function resolveProjectVectorIndexedEmbeddingLane(args: {
  dimensions: number;
  profileId?: ProjectEmbeddingProfileId;
}): ProjectVectorIndexedEmbeddingLane {
  const profile = args.profileId ? getProjectEmbeddingProfile(args.profileId) : undefined;

  if (profile && !profile.vectorIndexed) {
    throw new Error(
      `Unsupported project embedding profile lane: ${profile.id} (${profile.dimensions} dimensions)`
    );
  }

  if (profile && profile.dimensions !== args.dimensions) {
    throw new Error(
      `Embedding profile ${profile.id} expects ${profile.dimensions} dimensions, got ${args.dimensions}`
    );
  }

  if (!isProjectVectorIndexedEmbeddingDimensions(args.dimensions)) {
    throw new Error(
      `Invalid embedding dimension: supported indexed dimensions are ${formatProjectVectorIndexedEmbeddingDimensions()}, got ${args.dimensions}`
    );
  }

  return {
    profileId:
      profile?.id ??
      (args.dimensions === 1024 ? 'qwen3-0.6b-1024' : DEFAULT_PROJECT_EMBEDDING_PROFILE_ID),
    dimensions: args.dimensions,
    table: getProjectEmbeddingTableForDimensions(args.dimensions),
  };
}
