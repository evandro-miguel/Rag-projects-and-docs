/**
 * @module agent_isolation
 * @description Retired agent isolation helper.
 */

import { EventEmitter } from 'node:events';

export type AgentMode = 'anonymous' | 'shared' | 'isolated';

export interface AgentIdentity {
  id: string;
  mode: AgentMode;
  createdAt: Date;
  name?: string;
  metadata?: Record<string, unknown>;
}

interface IsolationContext {
  agentId: string;
  namespace: string;
  startTime: number;
}

interface IsolatedClientConfig {
  namespace?: string;
  timeoutMs?: number;
}

const RETIRED_CLIENT_MESSAGE =
  'Agent isolation is retired; use explicit Postgres Project RAG scripts instead.';

export class AgentIsolation extends EventEmitter {
  private agentIdentity: AgentIdentity | null = null;

  constructor(_config: IsolatedClientConfig = {}) {
    super();
  }

  static getAgentMode(): AgentMode {
    return 'shared';
  }

  static isIsolationEnabled(): boolean {
    return AgentIsolation.getAgentMode() !== 'shared';
  }

  async initialize(): Promise<AgentIdentity> {
    this.agentIdentity = {
      id: 'postgres-project-rag',
      mode: 'shared',
      createdAt: new Date(),
      name: 'postgres-project-rag',
      metadata: { retired: true },
    };
    this.emit('initialized', this.agentIdentity);
    return this.agentIdentity;
  }

  getClient(): never {
    // ponytail: no replacement client factory; callers use explicit scripts now.
    throw new Error(RETIRED_CLIENT_MESSAGE);
  }

  async runInIsolation<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  getCurrentContext(): IsolationContext | undefined {
    return undefined;
  }

  getAgentIdentity(): AgentIdentity | null {
    return this.agentIdentity;
  }

  async cleanup(): Promise<void> {
    this.removeAllListeners();
  }

  getStats(): {
    agentId: string | null;
    mode: AgentMode;
    activeConnections: number;
    totalRequests: number;
  } {
    return {
      agentId: this.agentIdentity?.id ?? null,
      mode: this.agentIdentity?.mode ?? 'shared',
      activeConnections: 0,
      totalRequests: 0,
    };
  }
}

let globalInstance: AgentIsolation | null = null;

export function getAgentIsolation(config?: IsolatedClientConfig): AgentIsolation {
  globalInstance ??= new AgentIsolation(config);
  return globalInstance;
}

export function resetAgentIsolation(): void {
  globalInstance?.removeAllListeners();
  globalInstance = null;
}

export function isIsolatedMode(): boolean {
  return AgentIsolation.isIsolationEnabled();
}

export function getIsolatedClient(): never {
  return getAgentIsolation().getClient();
}

export default {
  AgentIsolation,
  getAgentIsolation,
  resetAgentIsolation,
  isIsolatedMode,
  getIsolatedClient,
};
