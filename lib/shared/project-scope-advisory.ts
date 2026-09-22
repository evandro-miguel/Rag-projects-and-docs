export const PROJECT_SCOPE_ACK_TOKEN = 'I_UNDERSTAND_PROJECT_RAG_SCOPE_V1' as const;

export type ProjectScopeOperation = 'register' | 'ingest';

export interface ProjectScopeAdvisoryOptions {
  operation: ProjectScopeOperation;
  rootPath?: string;
  includeRoots?: string[];
  target?: string;
}

export interface ProjectScopeAckResult {
  valid: boolean;
  error?: string;
  advisory: string;
  confirmationInstruction: string;
}

function formatScopeList(values?: string[]): string {
  if (!values || values.length === 0) {
    return 'the explicitly selected include roots';
  }

  return values.map((value) => `\`${value}\``).join(', ');
}

export function buildProjectScopeAdvisory({
  operation,
  rootPath,
  includeRoots,
  target,
}: ProjectScopeAdvisoryOptions): string {
  const scopeTarget = target ? ` for ${target}` : '';
  const scopeContext = rootPath ? ` at \`${rootPath}\`` : '';
  const rootsText = formatScopeList(includeRoots);

  return [
    `Critical project scope warning${scopeTarget}${scopeContext}:`,
    `Project RAG will ingest only ${rootsText}. Keep the index focused on source code, config, docs, tests, and other intentional project assets inside those roots.`,
    'Avoid agent/workbench folders such as `.agents/`, `.workbench/`, `.codex/`, `.cursor/`, `.claude/`, and `.opencode/`.',
    'Avoid generated outputs, build artifacts, archives, caches, logs, vendor dependencies, temp files, and other operational noise such as `dist/`, `build/`, `out/`, `coverage/`, `.next/`, `node_modules/`, and `vendor/`.',
    'If broader coverage is needed, change the scope deliberately instead of ingesting everything.',
    `To proceed with ${operation}, confirm explicitly with \`scopeAck=${PROJECT_SCOPE_ACK_TOKEN}\`.`,
  ].join('\n');
}

export function validateProjectScopeAck(scopeAck: unknown): ProjectScopeAckResult {
  const confirmationInstruction = `Set scopeAck=${PROJECT_SCOPE_ACK_TOKEN} to confirm you read the project scope warning.`;

  if (scopeAck === PROJECT_SCOPE_ACK_TOKEN) {
    return {
      valid: true,
      advisory: '',
      confirmationInstruction,
    };
  }

  return {
    valid: false,
    error: 'Project scope confirmation is required before register or ingest.',
    advisory: '',
    confirmationInstruction,
  };
}

export function requireProjectScopeAck(
  scopeAck: unknown,
  advisoryOptions: ProjectScopeAdvisoryOptions
): ProjectScopeAckResult {
  const validation = validateProjectScopeAck(scopeAck);
  if (validation.valid) {
    return validation;
  }

  return {
    ...validation,
    advisory: buildProjectScopeAdvisory(advisoryOptions),
    error: `${validation.error} ${validation.confirmationInstruction}`,
  };
}
