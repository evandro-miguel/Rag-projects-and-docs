import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type RateLimiter, rateLimiters } from './lib/rate-limiter.js';
import { readPositiveIntegerEnv, readRequiredPositiveIntegerEnv } from './lib/timeout.js';
import { prepareProjectTool, publicProjectTools } from './project-tools.js';
import {
  adaptDocsTool,
  ensureRerankerTool,
  findProjectSymbolTool,
  findSymbolReferencesTool,
  getCodeMetricsTool,
  getDeadCodeReportTool,
  getDocumentTool,
  getFeatureHubsTool,
  getNavigationPathsTool,
  getProjectSkeletonTool,
  getSemanticClustersTool,
  getTopicGroupsTool,
  healthCheckTool,
  ingestProjectFileTool,
  ingestProjectTool,
  listCategoriesTool,
  searchAndAdaptTool,
  searchDocsTool,
  searchInventoryTool,
  searchProjectDocsTool,
} from './tools.js';

export type McpToolset = 'all' | 'docs' | 'projects';
export type McpCapability = 'read' | 'write' | 'admin';
export type McpRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type McpPermissionMode = 'read_write' | 'read_only';
export type McpToolsetScope = McpToolset;

export interface ToolCapabilityMetadata {
  readonly toolName: string;
  readonly risk: McpRiskLevel;
  readonly sideEffects: string[];
  readonly capability: McpCapability;
  readonly toolset: McpToolset;
  readonly requiresAck: boolean;
  readonly requiresDryRun: boolean;
  readonly durableJobType?: string;
}

export interface McpToolDeadline {
  readonly kind: 'read' | 'none';
  readonly timeoutMs?: number;
  readonly databaseTimeoutMs?: number;
}

export interface McpRateLimitBinding {
  readonly limiter: RateLimiter;
  readonly key: string;
}

export interface McpToolContract<TInput = any> {
  readonly name: string;
  readonly tool: Tool;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: NonNullable<Tool['outputSchema']>;
  readonly metadata: ToolCapabilityMetadata;
  readonly deadline: McpToolDeadline;
  readonly rateLimit?: McpRateLimitBinding;
  readonly annotations: NonNullable<Tool['annotations']>;
  readonly dispatch: (args: TInput, signal?: AbortSignal) => Promise<unknown>;
}

const GenericOutputSchema: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'object' },
    error: { type: 'object' },
  },
};

const ErrorOutputSchema: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        timestamp: { type: 'string' },
        retryAfter: { type: 'number' },
      },
      required: ['code', 'message', 'timestamp'],
    },
    data: { type: 'object' },
  },
  required: ['success', 'error'],
};

function withErrorOutputSchema(
  successSchema: NonNullable<Tool['outputSchema']>
): NonNullable<Tool['outputSchema']> {
  return {
    type: 'object',
    anyOf: [successSchema, ErrorOutputSchema],
  };
}

const SearchDocsSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  categories: z.array(z.string()).optional(),
  tags: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      operator: z.enum(['AND', 'OR']).optional().default('OR'),
    })
    .optional(),
  limit: z.number().min(1).max(50).optional().default(10),
  active_file: z.string().optional(),
  sourceId: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  language: z.string().optional(),
  kind: z.enum(['official-docs', 'book', 'package-docs', 'repository-docs']).optional(),
  authority: z.enum(['official', 'publisher', 'community-vetted']).optional(),
  sourceTags: z.array(z.string()).optional(),
  retrievalMode: z.enum(['hybrid', 'local_first']).optional().default('hybrid'),
  includePageRefs: z.boolean().optional().default(false),
  includeTrust: z.boolean().optional().default(false),
});

const SearchProjectCodeSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  query: z.string().min(1, 'query is required'),
  limit: z.number().min(1).max(50).optional().default(10),
  activeFile: z.string().optional(),
  mode: z.enum(['keyword', 'vector', 'hybrid']).optional().default('hybrid'),
  includeDiagnostics: z.boolean().optional().default(false),
});

const SearchProjectDocsAliasSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  query: z.string().min(1, 'query is required'),
  limit: z.number().min(1).max(50).optional().default(10),
  active_file: z.string().optional(),
  mode: z.enum(['keyword', 'vector', 'hybrid']).optional().default('hybrid'),
});

const GetDocumentSchema = z.object({
  sourcePath: z.string().min(1, 'sourcePath is required'),
});

const IngestProjectSchema = z.object({
  force: z.boolean().optional().default(false),
  rootPath: z.string().trim().min(1, 'rootPath must be at least 1 character').optional(),
  includeRoots: z
    .array(z.string().trim().min(1, 'includeRoots entries must be non-empty'))
    .min(1, 'includeRoots must contain at least one folder')
    .optional(),
  scopeAck: z.string().min(1, 'scopeAck must be at least 1 character').optional(),
  maxFiles: z.number().int().min(1).optional(),
  executionMode: z.enum(['inline', 'durable']).optional().default('inline'),
});

const IngestProjectFileSchema = z.object({
  filePath: z.string().min(1, 'filePath is required'),
  force: z.boolean().optional().default(false),
  rootPath: z.string().trim().min(1, 'rootPath must be at least 1 character').optional(),
  scopeAck: z.string().min(1, 'scopeAck must be at least 1 character').optional(),
});

const AdaptDocsSchema = z.object({
  content: z.string().min(1, 'content is required'),
  context: z.enum(['code-focused', 'architecture', 'beginner', 'senior', 'quick-ref']),
  maxLength: z.number().optional().default(2000),
  preserveCode: z.boolean().optional().default(true),
});

const SearchAndAdaptSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  context: z.enum(['code-focused', 'architecture', 'beginner', 'senior', 'quick-ref']),
  categories: z.array(z.string()).optional(),
  limit: z.number().min(1).max(20).optional().default(5),
  maxLength: z.number().optional().default(2000),
  preserveCode: z.boolean().optional().default(true),
});

const GetCodeMetricsSchema = z.object({ category: z.string().optional() });
const SearchInventorySchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  category: z.string().optional(),
  limit: z.number().min(1).max(100).optional().default(20),
});
const GetDeadCodeReportSchema = z.object({
  category: z.string().optional(),
  includeUnreviewed: z.boolean().optional().default(true),
  minLines: z.number().optional().default(0),
});
const GetProjectSkeletonSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  sourcePath: z.string().min(1, 'sourcePath is required'),
});
const GetProjectFileSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  sourcePath: z.string().min(1, 'sourcePath is required'),
});
const GetProjectOutlineSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  sourcePath: z.string().min(1, 'sourcePath is required'),
});

export const BlockedFindingAllowlistEntrySchema = z
  .object({
    relativePath: z
      .string()
      .min(1, 'relativePath must be at least 1 character')
      .max(200, 'relativePath must be at most 200 characters'),
    category: z.string().min(1, 'category must be at least 1 character'),
  })
  .strict();

export const RegisterProjectSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    rootPath: z.string().min(1, 'rootPath is required'),
    includeRoots: z.array(z.string().min(1, 'includeRoots entries must be non-empty')).min(1),
    scopeAck: z.string().min(1, 'scopeAck must be at least 1 character').optional(),
    gitRemote: z.string().optional(),
    defaultBranch: z.string().optional(),
    blockedFindingAllowlist: z
      .array(BlockedFindingAllowlistEntrySchema)
      .min(0)
      .max(32, 'blockedFindingAllowlist must have at most 32 entries')
      .optional(),
    replaceBlockedFindingAllowlist: z.boolean().optional(),
  })
  .strict();

const VerifyProjectIndexSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});
const PrepareProjectSchema = z.object({
  rootPath: z.string().trim().min(1, 'rootPath is required'),
  projectId: z.string().trim().min(1).optional(),
  includeRoots: z
    .array(z.string().trim().min(1, 'includeRoots entries must be non-empty'))
    .min(1)
    .optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  maxFiles: z.number().int().min(1).max(2_000).optional(),
  maxBatches: z.number().int().min(1).max(128).optional(),
});
const FindProjectSymbolSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  symbolName: z.string().min(1, 'symbolName is required'),
  symbolType: z.string().optional(),
  limit: z.number().min(1).max(50).optional().default(10),
});
const FindSymbolReferencesSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  symbolName: z.string().min(1, 'symbolName is required'),
  limit: z.number().min(1).max(50).optional().default(20),
});
const EnsureRerankerSchema = z.object({ timeout: z.number().min(1).optional() });
const GetSemanticClustersSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  maxClusters: z.number().min(1).max(20).optional().default(10),
  minClusterSize: z.number().min(2).max(10).optional().default(2),
});
const GetFeatureHubsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  minFiles: z.number().min(1).max(10).optional().default(2),
});
const GetNavigationPathsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  sourcePath: z.string().min(1, 'sourcePath is required'),
  limit: z.number().min(1).max(50).optional().default(10),
});
const GetTopicGroupsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  maxTopics: z.number().min(1).max(20).optional().default(8),
  minTopicSize: z.number().min(2).max(10).optional().default(2),
});

const READ_TIMEOUT_MS = readRequiredPositiveIntegerEnv('MCP_READ_TIMEOUT_MS', 30_000);
const DATABASE_TIMEOUT_MS = readPositiveIntegerEnv('PROJECT_RAG_DB_TIMEOUT_MS', 5_000);

const READ_ANNOTATIONS: NonNullable<Tool['annotations']> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE_ANNOTATIONS: NonNullable<Tool['annotations']> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

type ContractOptions<TInput> = {
  tool: Tool;
  inputSchema: z.ZodType<TInput>;
  metadata: Omit<ToolCapabilityMetadata, 'toolName'>;
  deadline: McpToolDeadline;
  rateLimit?: McpRateLimitBinding;
  dispatch: (args: TInput, signal?: AbortSignal) => Promise<unknown>;
};

function createContract<TInput>(options: ContractOptions<TInput>): McpToolContract<TInput> {
  const outputSchema = withErrorOutputSchema(options.tool.outputSchema ?? GenericOutputSchema);
  const annotations = options.metadata.capability === 'read' ? READ_ANNOTATIONS : WRITE_ANNOTATIONS;
  const tool = {
    ...options.tool,
    outputSchema,
    annotations: options.tool.annotations ?? annotations,
  } satisfies Tool;
  return {
    name: tool.name,
    tool,
    inputSchema: options.inputSchema,
    outputSchema,
    metadata: { toolName: tool.name, ...options.metadata },
    deadline: options.deadline,
    rateLimit: options.rateLimit,
    annotations: tool.annotations ?? annotations,
    dispatch: options.dispatch,
  };
}

function readDeadline(toolset: McpToolset): McpToolDeadline {
  return {
    kind: 'read',
    timeoutMs: READ_TIMEOUT_MS,
    databaseTimeoutMs: toolset === 'projects' ? DATABASE_TIMEOUT_MS : undefined,
  };
}

function writeDeadline(): McpToolDeadline {
  return { kind: 'none' };
}

const read = (toolset: McpToolset): Omit<ToolCapabilityMetadata, 'toolName'> => ({
  risk: 'low',
  sideEffects: [],
  capability: 'read',
  toolset,
  requiresAck: false,
  requiresDryRun: false,
});

const write = (
  toolset: McpToolset,
  sideEffects: string[],
  durableJobType?: string
): Omit<ToolCapabilityMetadata, 'toolName'> => ({
  risk: 'high',
  sideEffects,
  capability: 'write',
  toolset,
  requiresAck: true,
  requiresDryRun: false,
  durableJobType,
});

const searchRateLimit = (key: string): McpRateLimitBinding => ({
  limiter: rateLimiters.search,
  key,
});

const baseToolContracts: McpToolContract<any>[] = [
  createContract({
    tool: searchDocsTool,
    inputSchema: SearchDocsSchema,
    metadata: read('docs'),
    deadline: readDeadline('docs'),
    rateLimit: searchRateLimit('search_docs'),
    dispatch: (args, signal) =>
      import('./docs-handlers.js').then((module) =>
        module.handleSearchDocs(args as never, ['external'], signal)
      ),
  }),
  createContract({
    tool: searchProjectDocsTool,
    inputSchema: SearchProjectDocsAliasSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    rateLimit: searchRateLimit('search_project_docs'),
    dispatch: (args, signal) => {
      const alias = args as z.infer<typeof SearchProjectDocsAliasSchema>;
      return import('./project-handlers.js').then((module) =>
        module.handleSearchProjectCode(
          {
            projectId: alias.projectId,
            query: alias.query,
            limit: alias.limit,
            activeFile: alias.active_file,
            mode: alias.mode,
          },
          signal
        )
      );
    },
  }),
  createContract({
    tool: ingestProjectTool,
    inputSchema: IngestProjectSchema,
    metadata: write(
      'projects',
      ['project_index_mutation', 'filesystem_scan', 'embedding_compute'],
      'project_ingest_full'
    ),
    deadline: writeDeadline(),
    rateLimit: { limiter: rateLimiters.ingest, key: 'ingest_project' },
    dispatch: (args) => import('./handlers.js').then((module) => module.handleIngestProject(args)),
  }),
  createContract({
    tool: ingestProjectFileTool,
    inputSchema: IngestProjectFileSchema,
    metadata: write('projects', ['project_index_mutation', 'filesystem_read', 'embedding_compute']),
    deadline: writeDeadline(),
    rateLimit: { limiter: rateLimiters.ingestFile, key: 'ingest_project_file' },
    dispatch: (args) =>
      import('./handlers.js').then((module) => module.handleIngestProjectFile(args)),
  }),
  createContract({
    tool: listCategoriesTool,
    inputSchema: z.object({}),
    metadata: read('docs'),
    deadline: readDeadline('docs'),
    dispatch: () => import('./docs-handlers.js').then((module) => module.handleListCategories()),
  }),
  createContract({
    tool: healthCheckTool,
    inputSchema: z.object({}),
    metadata: read('all'),
    deadline: readDeadline('all'),
    dispatch: () => import('./docs-handlers.js').then((module) => module.handleHealthCheck()),
  }),
  createContract({
    tool: getDocumentTool,
    inputSchema: GetDocumentSchema,
    metadata: read('docs'),
    deadline: readDeadline('docs'),
    dispatch: (args) =>
      import('./docs-handlers.js').then((module) => module.handleGetDocument(args)),
  }),
  createContract({
    tool: adaptDocsTool,
    inputSchema: AdaptDocsSchema,
    metadata: read('docs'),
    deadline: readDeadline('docs'),
    dispatch: (args) => import('./docs-handlers.js').then((module) => module.handleAdaptDocs(args)),
  }),
  createContract({
    tool: searchAndAdaptTool,
    inputSchema: SearchAndAdaptSchema,
    metadata: read('docs'),
    deadline: readDeadline('docs'),
    dispatch: (args) =>
      import('./docs-handlers.js').then((module) => module.handleSearchAndAdapt(args)),
  }),
  createContract({
    tool: getCodeMetricsTool,
    inputSchema: GetCodeMetricsSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) => import('./handlers.js').then((module) => module.handleGetCodeMetrics(args)),
  }),
  createContract({
    tool: searchInventoryTool,
    inputSchema: SearchInventorySchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./handlers.js').then((module) => module.handleSearchInventory(args)),
  }),
  createContract({
    tool: getDeadCodeReportTool,
    inputSchema: GetDeadCodeReportSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./handlers.js').then((module) => module.handleGetDeadCodeReport(args)),
  }),
  createContract({
    tool: findProjectSymbolTool,
    inputSchema: FindProjectSymbolSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleFindProjectSymbol(args)),
  }),
  createContract({
    tool: findSymbolReferencesTool,
    inputSchema: FindSymbolReferencesSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleFindSymbolReferences(args)),
  }),
  createContract({
    tool: getProjectSkeletonTool,
    inputSchema: GetProjectSkeletonSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleGetProjectSkeleton(args)),
  }),
  createContract({
    tool: ensureRerankerTool,
    inputSchema: EnsureRerankerSchema,
    metadata: {
      ...write('docs', ['local_service_start']),
      risk: 'high',
    },
    deadline: writeDeadline(),
    dispatch: (args) =>
      import('./docs-handlers.js').then((module) => module.handleEnsureReranker(args)),
  }),
  createContract({
    tool: getSemanticClustersTool,
    inputSchema: GetSemanticClustersSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleGetSemanticClusters(args)),
  }),
  createContract({
    tool: getFeatureHubsTool,
    inputSchema: GetFeatureHubsSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleGetFeatureHubs(args)),
  }),
  createContract({
    tool: getNavigationPathsTool,
    inputSchema: GetNavigationPathsSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleGetNavigationPaths(args)),
  }),
  createContract({
    tool: getTopicGroupsTool,
    inputSchema: GetTopicGroupsSchema,
    metadata: read('projects'),
    deadline: readDeadline('projects'),
    dispatch: (args) =>
      import('./project-handlers.js').then((module) => module.handleGetTopicGroups(args)),
  }),
];

const projectCoreContracts: McpToolContract<any>[] = publicProjectTools.map((tool) => {
  const inputSchema: z.ZodTypeAny =
    tool.name === 'search_project_code'
      ? SearchProjectCodeSchema
      : tool.name === 'get_project_file'
        ? GetProjectFileSchema
        : tool.name === 'get_project_outline'
          ? GetProjectOutlineSchema
          : tool.name === 'register_project'
            ? RegisterProjectSchema
            : tool.name === prepareProjectTool.name
              ? PrepareProjectSchema
              : VerifyProjectIndexSchema;
  const metadata =
    tool.name === 'register_project'
      ? write('projects', ['project_registry_write'])
      : tool.name === prepareProjectTool.name
        ? {
            ...write(
              'projects',
              [
                'project_registry_write',
                'project_index_prepare',
                'filesystem_scan',
                'embedding_compute',
                'local_service_start',
              ],
              'project_prepare'
            ),
            requiresAck: false,
          }
        : read('projects');
  const dispatch = (args: unknown, signal?: AbortSignal): Promise<unknown> => {
    switch (tool.name) {
      case 'search_project_code':
        return import('./project-handlers.js').then((module) =>
          module.handleSearchProjectCode(args as never, signal)
        );
      case 'get_project_file':
        return import('./project-handlers.js').then((module) =>
          module.handleGetProjectFile(args as never)
        );
      case 'get_project_outline':
        return import('./project-handlers.js').then((module) =>
          module.handleGetProjectOutline(args as never)
        );
      case 'register_project':
        return import('./project-handlers.js').then((module) =>
          module.handleRegisterProject(args as never)
        );
      case 'prepare_project':
        return import('./project-handlers.js').then((module) =>
          module.handlePrepareProject(args as never, signal)
        );
      default:
        return import('./project-handlers.js').then((module) =>
          module.handleVerifyProjectIndex(args as never)
        );
    }
  };
  return createContract({
    tool,
    inputSchema,
    metadata,
    deadline: metadata.capability === 'read' ? readDeadline('projects') : writeDeadline(),
    dispatch,
  });
});

export const mcpToolContracts: readonly McpToolContract[] = [
  ...baseToolContracts,
  ...projectCoreContracts,
];

const contractsByName = new Map(mcpToolContracts.map((contract) => [contract.name, contract]));
if (contractsByName.size !== mcpToolContracts.length) {
  throw new Error('INVALID_CONFIG: duplicate MCP tool contract name');
}

export function getMcpToolContract(name: string): McpToolContract {
  const contract = contractsByName.get(name);
  if (!contract) {
    throw new Error(`MCP_TOOL_METADATA_MISSING: ${name}`);
  }
  return contract;
}

export function getToolCapabilityMetadata(toolName: string): ToolCapabilityMetadata {
  return getMcpToolContract(toolName).metadata;
}

export function isToolEnabledForToolset(toolName: string, toolset: McpToolset): boolean {
  const contract = contractsByName.get(toolName);
  return Boolean(
    contract &&
      (toolset === 'all' ||
        contract.metadata.toolset === 'all' ||
        contract.metadata.toolset === toolset)
  );
}

export function isWriteCapability(capability: McpCapability): boolean {
  return capability === 'write' || capability === 'admin';
}

export function resolveMcpPermissionMode(): McpPermissionMode {
  const raw = (process.env.MCP_PERMISSION_MODE ?? 'read_only').trim().toLowerCase();
  return raw === 'read_write' ? 'read_write' : 'read_only';
}

export function resolveMcpToolset(): McpToolset {
  const raw = (
    process.env.MCP_TOOLSET ??
    process.env.RAG_MCP_TOOLSET ??
    process.env.RAG_MCP_SURFACE ??
    'all'
  )
    .trim()
    .toLowerCase();
  if (raw === 'all') return 'all';
  if (['docs', 'doc', 'documentation', 'rag-docs'].includes(raw)) return 'docs';
  if (['projects', 'project', 'rag-projects', 'project-rag'].includes(raw)) return 'projects';
  throw new Error(`INVALID_CONFIG: unsupported MCP toolset "${raw}"`);
}

export const allRegisteredTools: Tool[] = mcpToolContracts.map((contract) => contract.tool);
