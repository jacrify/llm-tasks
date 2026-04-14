import { describe, it, expect } from 'vitest';
import { piAdapter } from '../src/agents/pi';
import { claudeCodeAdapter } from '../src/agents/claude-code';
import { getAgent, listAgents } from '../src/agents/registry';

const baseParams = {
    renderedPrompt: 'Do the thing',
    sessionFile: '/tmp/llm-tasks/sessions/test',
    extraArgs: [] as string[],
};

describe('pi adapter', () => {
    it('has correct defaultCommand', () => {
        expect(piAdapter.defaultCommand).toBe('pi');
    });

    it('buildArgs returns correct args with no extra args', () => {
        const result = piAdapter.buildArgs(baseParams);
        expect(result).toEqual(['-p', '--session', '/tmp/llm-tasks/sessions/test', 'Do the thing']);
    });

    it('buildArgs includes extra args when provided', () => {
        const result = piAdapter.buildArgs({
            ...baseParams,
            extraArgs: ['--model', 'sonnet'],
        });
        expect(result).toContain('--model');
        expect(result).toContain('sonnet');
    });

    it('buildArgs includes --provider in extra args', () => {
        const result = piAdapter.buildArgs({
            ...baseParams,
            extraArgs: ['--provider', 'anthropic'],
        });
        expect(result).toContain('--provider');
        expect(result).toContain('anthropic');
    });

    it('buildArgs passes through multiple extra args', () => {
        const result = piAdapter.buildArgs({
            ...baseParams,
            extraArgs: ['--verbose', '--timeout', '30'],
        });
        expect(result).toContain('--verbose');
        expect(result).toContain('--timeout');
        expect(result).toContain('30');
    });

    it('isSuccess returns true for exit code 0', () => {
        expect(piAdapter.isSuccess(0)).toBe(true);
    });

    it('isSuccess returns false for non-zero exit code', () => {
        expect(piAdapter.isSuccess(1)).toBe(false);
    });
});

describe('claude-code adapter', () => {
    it('has correct defaultCommand', () => {
        expect(claudeCodeAdapter.defaultCommand).toBe('claude');
    });

    it('buildArgs returns correct args', () => {
        const result = claudeCodeAdapter.buildArgs(baseParams);
        expect(result).toEqual(['-p', 'Do the thing']);
    });

    it('buildArgs includes extra args when set', () => {
        const result = claudeCodeAdapter.buildArgs({
            ...baseParams,
            extraArgs: ['--model', 'opus'],
        });
        expect(result).toEqual(['-p', '--model', 'opus', 'Do the thing']);
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
