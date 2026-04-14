import { describe, it, expect } from 'vitest';
import { renderPrompt, truncateContext, DEFAULT_PROMPT_TEMPLATE, PromptVariables } from '../src/prompt';

function makeVars(overrides: Partial<PromptVariables> = {}): PromptVariables {
    return {
        task: 'Refactor the module',
        sourceNoteName: 'Project Notes',
        noteContext: 'Some context about the project',
        vaultPath: '/Users/test/vault',
        timestamp: '2026-04-14T14:30:00Z',
        agentId: 'pi',
        contextLimit: 10000,
        ...overrides,
    };
}

describe('renderPrompt', () => {
    it('uses default template when custom is null', () => {
        const result = renderPrompt(null, makeVars());
        expect(result).toContain('Refactor the module');
        expect(result).toContain('/Users/test/vault');
        expect(result).toContain('Project Notes');
        expect(result).toContain('Complete the task directly');
        expect(result).not.toContain('{{task}}');
        expect(result).not.toContain('{{vaultPath}}');
    });

    it('uses default template when custom is undefined', () => {
        const result = renderPrompt(undefined, makeVars());
        expect(result).toContain('Refactor the module');
        expect(result).toContain('Complete the task directly');
    });

    it('appends custom template to default when custom is provided', () => {
        const custom = 'Always respond in French. Use {{task}} as reference.';
        const result = renderPrompt(custom, makeVars());
        // Has the default
        expect(result).toContain('Complete the task directly');
        expect(result).toContain('Refactor the module');
        // Has the custom appended
        expect(result).toContain('Additional Instructions');
        expect(result).toContain('Always respond in French');
        // Placeholders in custom are also replaced
        expect(result).not.toContain('{{task}}');
    });

    it('replaces all placeholders in both default and custom', () => {
        const custom = 'Agent: {{agentId}}, Time: {{timestamp}}';
        const result = renderPrompt(custom, makeVars());
        expect(result).toContain('Agent: pi');
        expect(result).toContain('Time: 2026-04-14T14:30:00Z');
        expect(result).not.toContain('{{agentId}}');
        expect(result).not.toContain('{{timestamp}}');
    });

    it('truncates noteContext to contextLimit characters', () => {
        const longContext = 'A'.repeat(500);
        const vars = makeVars({ noteContext: longContext, contextLimit: 100 });
        const result = renderPrompt(null, vars);
        // The context in the rendered output should be truncated
        expect(result).not.toContain('A'.repeat(500));
        expect(result).toContain('A'.repeat(100));
    });

    it('handles empty task string', () => {
        const result = renderPrompt(null, makeVars({ task: '' }));
        expect(result).toContain('## Task\n\n\n');
    });

    it('does not include Additional Instructions section when custom is null', () => {
        const result = renderPrompt(null, makeVars());
        expect(result).not.toContain('Additional Instructions');
    });
});

describe('truncateContext', () => {
    it('returns context unchanged when under limit', () => {
        expect(truncateContext('hello', 100)).toBe('hello');
    });

    it('truncates to exactly limit characters', () => {
        const result = truncateContext('A'.repeat(200), 50);
        expect(result.length).toBe(50);
    });

    it('handles zero limit', () => {
        expect(truncateContext('hello', 0)).toBe('');
    });
});

describe('DEFAULT_PROMPT_TEMPLATE', () => {
    it('contains expected placeholders', () => {
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('{{task}}');
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('{{sourceNoteName}}');
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('{{noteContext}}');
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('{{vaultPath}}');
    });

    it('tells agent to not ask questions', () => {
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('Complete the task directly');
        expect(DEFAULT_PROMPT_TEMPLATE).toContain('Do not ask clarifying questions');
    });
});
