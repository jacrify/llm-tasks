import { describe, it, expect } from 'vitest';
import { piAdapter } from '../src/agents/pi';
import { claudeCodeAdapter } from '../src/agents/claude-code';
import { getAgent, listAgents } from '../src/agents/registry';

const baseParams = {
    renderedPrompt: 'Do the thing',
    task: 'Do the thing',
    extraArgs: [] as string[],
};

describe('pi adapter', () => {
    it('has correct defaultCommand', () => {
        expect(piAdapter.defaultCommand).toBe('pi');
    });

    it('buildArgs returns correct args', () => {
        const result = piAdapter.buildArgs(baseParams);
        expect(result).toEqual(['-p', 'Do the thing']);
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
});

describe('agent registry', () => {
    it('get("pi") returns pi adapter', () => {
        const agent = getAgent('pi');
        expect(agent).toBeDefined();
        expect(agent!.id).toBe('pi');
    });

    it('get("claude-code") returns claude-code adapter', () => {
        const agent = getAgent('claude-code');
        expect(agent).toBeDefined();
        expect(agent!.id).toBe('claude-code');
    });

    it('list() returns both adapters', () => {
        const agents = listAgents();
        const ids = agents.map(a => a.id);
        expect(ids).toContain('pi');
        expect(ids).toContain('claude-code');
    });
});
