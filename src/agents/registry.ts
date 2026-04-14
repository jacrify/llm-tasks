import { AgentAdapter } from './types';
import { piAdapter } from './pi';
import { claudeCodeAdapter } from './claude-code';

const agents: Map<string, AgentAdapter> = new Map();

export function registerAgent(adapter: AgentAdapter): void {
    agents.set(adapter.id, adapter);
}

export function getAgent(id: string): AgentAdapter | undefined {
    return agents.get(id);
}

export function listAgents(): AgentAdapter[] {
    return Array.from(agents.values());
}

// Register built-in adapters
registerAgent(piAdapter);
registerAgent(claudeCodeAdapter);
