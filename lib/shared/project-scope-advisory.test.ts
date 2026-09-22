import { describe, expect, it } from 'vitest';
import {
  buildProjectScopeAdvisory,
  PROJECT_SCOPE_ACK_TOKEN,
  requireProjectScopeAck,
  validateProjectScopeAck,
} from './project-scope-advisory.js';

describe('project-scope-advisory', () => {
  it('builds a critical warning that names the common noisy folders', () => {
    const advisory = buildProjectScopeAdvisory({
      operation: 'register',
      rootPath: '/repo',
      includeRoots: ['src', 'docs'],
      target: 'demo-project',
    });

    expect(advisory).toContain('Critical project scope warning');
    expect(advisory).toContain('`.agents/`');
    expect(advisory).toContain('`dist/`');
    expect(advisory).toContain(PROJECT_SCOPE_ACK_TOKEN);
  });

  it('rejects missing scope acknowledgement tokens', () => {
    const result = validateProjectScopeAck(undefined);

    expect(result.valid).toBe(false);
    expect(result.confirmationInstruction).toContain(PROJECT_SCOPE_ACK_TOKEN);
  });

  it('accepts the explicit scope acknowledgement token', () => {
    expect(validateProjectScopeAck(PROJECT_SCOPE_ACK_TOKEN)).toEqual({
      valid: true,
      advisory: '',
      confirmationInstruction: `Set scopeAck=${PROJECT_SCOPE_ACK_TOKEN} to confirm you read the project scope warning.`,
    });
  });

  it('includes advisory text in the confirmation error wrapper', () => {
    const result = requireProjectScopeAck(undefined, {
      operation: 'ingest',
      rootPath: '/repo',
      target: 'project ingestion',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Project scope confirmation is required');
    expect(result.advisory).toContain('Critical project scope warning');
  });
});
