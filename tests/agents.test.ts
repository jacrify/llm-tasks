import { describe, it, expect } from 'vitest';
import { piAdapter } from '../src/agents/pi';
import { claudeCodeAdapter } from '../src/agents/claude-code';
import { getAgent, listAgents } from '../src/agents/registry';

const baseParams = {
    renderedPrompt: 'Do the thing',
    logFile: '/tmp/llm-tasks/test.log',
    sessionFile: '/tmp/llm-tasks/sessions/test',
    workingDirectory: '/home/user/vault',
    agentSettings: {} as Record<string, any>,
};

describe('pi adapter', () => {
    it('buildCommand returns correct command/args with default settings', () => {
        const result = piAdapter.buildCommand(baseParams);
        expect(result.command).toBe('pi');
        expect(result.args).toEqual(['-p', '--session', '/tmp/llm-tasks/sessions/test', 'Do the thing']);
    });

    it('buildCommand includes --model only when model is set', () => {
        const withModel = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { model: 'sonnet' },
        });
        expect(withModel.args).toContain('--model');
        expect(withModel.args).toContain('sonnet');

        const withoutModel = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { model: '' },
        });
        expect(withoutModel.args).not.toContain('--model');
    });

    it('buildCommand includes --provider only when set', () => {
        const withProvider = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { provider: 'anthropic' },
        });
        expect(withProvider.args).toContain('--provider');
        expect(withProvider.args).toContain('anthropic');

        const withoutProvider = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { provider: '' },
        });
        expect(withoutProvider.args).not.toContain('--provider');
    });

    it('buildCommand splits additionalArgs correctly', () => {
        const result = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { additionalArgs: '--verbose  --timeout 30' },
        });
        expect(result.args).toContain('--verbose');
        expect(result.args).toContain('--timeout');
        expect(result.args).toContain('30');
    });

    it('buildCommand uses custom binaryPath', () => {
        const result = piAdapter.buildCommand({
            ...baseParams,
            agentSettings: { binaryPath: '/usr/local/bin/pi' },
        });
        expect(result.command).toBe('/usr/local/bin/pi');
    });
});

describe('claude-code adapter', () => {
    it('buildCommand returns correct command/args', () => {
        const result = claudeCodeAdapter.buildCommand(baseParams);
        expect(result.command).toBe('claude');
        expect(result.args).toEqual(['-p', 'Do the thing']);
    });

    it('buildCommand includes --model when set', () => {
        const result = claudeCodeAdapter.buildCommand({
            ...baseParams,
            agentSettings: { model: 'opus' },
        });
        expect(result.args).toEqual(['-p', '--model', 'opus', 'Do the thing']);
    });
});

describe('agent registry', () => {
    it('get("pi") returns pi adapter', () => {
        const agent = getAgent('pi');
        expect(agent).toBeDefined();
        expect(agent!.id).toBe('pi');
        expect(agent!.name).toBe('Pi');
    });

    it('get("claude-code") returns claude-code adapter', () => {
        const agent = getAgent('claude-code');
        expect(agent).toBeDefined();
        expect(agent!.id).toBe('claude-code');
        expect(agent!.name).toBe('Claude Code');
    });

    it('list() returns both adapters', () => {
        const agents = listAgents();
        expect(agents.length).toBeGreaterThanOrEqual(2);
        const ids = agents.map(a => a.id);
        expect(ids).toContain('pi');
        expect(ids).toContain('claude-code');
    });
});
