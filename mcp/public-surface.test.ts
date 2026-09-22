import { describe, expect, it } from 'vitest';
import {
  getMcpToolSurfaceStatus,
  getPublicMcpToolName,
  isPublicMcpTool,
  resolveMcpContractToolName,
  toPublicMcpTool,
} from './public-surface.js';

describe('MCP public surface policy', () => {
  it('internalizes repository inventory and dead-code tools', () => {
    for (const name of ['get_code_metrics', 'search_inventory', 'get_dead_code_report']) {
      expect(isPublicMcpTool(name)).toBe(false);
      expect(getMcpToolSurfaceStatus(name)).toBe('internal');
      expect(resolveMcpContractToolName(name)).toBeUndefined();
    }
  });

  it('advertises directory grouping under an honest name and preserves the old alias', () => {
    expect(getPublicMcpToolName('get_feature_hubs')).toBe('get_directory_groups');
    expect(resolveMcpContractToolName('get_directory_groups')).toBe('get_feature_hubs');
    expect(getMcpToolSurfaceStatus('get_directory_groups')).toBe('experimental');
    expect(getMcpToolSurfaceStatus('get_feature_hubs')).toBe('deprecated');

    const publicTool = toPublicMcpTool({
      name: 'get_feature_hubs',
      inputSchema: { type: 'object' },
    });
    expect(publicTool?.name).toBe('get_directory_groups');
  });

  it('labels semantic navigation as experimental', () => {
    expect(getMcpToolSurfaceStatus('get_semantic_clusters')).toBe('experimental');
    expect(getMcpToolSurfaceStatus('get_navigation_paths')).toBe('experimental');
    expect(getMcpToolSurfaceStatus('get_topic_groups')).toBe('experimental');
  });
});
