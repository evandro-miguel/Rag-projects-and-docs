export type ProjectRagDirtyPathKind = 'modified' | 'deleted' | 'untracked';
export interface ProjectRagDirtyPath {
  readonly path: string;
  readonly kind: ProjectRagDirtyPathKind;
}
export function deriveProjectRagBuildOverlay(args: {
  readonly publishedDirtyDigest: string | null;
  readonly currentDirtyDigest: string;
  readonly publishedIdentityDigest?: string | null;
  readonly currentIdentityDigest?: string | null;
  readonly dirtyPaths?: readonly ProjectRagDirtyPath[];
}) {
  const identityUnverified =
    !args.publishedIdentityDigest ||
    !args.currentIdentityDigest ||
    args.currentDirtyDigest.length === 0;
  const dirtyDrift =
    args.publishedDirtyDigest !== null && args.publishedDirtyDigest !== args.currentDirtyDigest;
  const identityDrift =
    Boolean(args.publishedIdentityDigest && args.currentIdentityDigest) &&
    args.publishedIdentityDigest !== args.currentIdentityDigest;
  const invalid =
    identityUnverified || dirtyDrift || identityDrift || args.publishedDirtyDigest === null;
  const contextStatus = identityUnverified
    ? ('unverified' as const)
    : invalid
      ? ('drift' as const)
      : ('covered' as const);
  return {
    status: invalid ? ('invalid' as const) : ('published' as const),
    contextStatus,
    semanticFreshness: invalid ? ('degraded' as const) : ('current' as const),
    searchLane: invalid ? ('unavailable' as const) : ('published_hybrid' as const),
    dirtyPaths: invalid ? [...(args.dirtyPaths ?? [])] : [],
  };
}
