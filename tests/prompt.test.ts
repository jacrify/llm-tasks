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
    it('replaces all 6 known placeholders', () => {
        const template = '{{task}} | {{sourceNoteName}} | {{noteContext}} | {{vaultPath}} | {{timestamp}} | {{agentId}}';
        const vars = makeVars();
        const result = renderPrompt(template, vars);
        expect(result).toBe('Refactor the module | Project Notes | Some context about the project | /Users/test/vault | 2026-04-14T14:30:00Z | pi');
    });

    it('leaves unknown placeholders like {{foo}} as-is', () => {
        const template = '{{task}} and {{foo}} and {{bar}}';
        const result = renderPrompt(template, makeVars());
        expect(result).toBe('Refactor the module and {{foo}} and {{bar}}');
    });

    it('falls back to DEFAULT_PROMPT_TEMPLATE when template is null', () => {
        const result = renderPrompt(null, makeVars());
        expect(result).toContain('Refactor the module');
        expect(result).toContain('/Users/test/vault');
        expect(result).toContain('Project Notes');
        expect(result).not.toContain('{{task}}');
        expect(result).not.toContain('{{vaultPath}}');
    });

    it('falls back to DEFAULT_PROMPT_TEMPLATE when template is undefined', () => {
        const result = renderPrompt(undefined, makeVars());
        expect(result).toContain('Refactor the module');
    });

    it('truncates noteContext to contextLimit characters', () => {
        const longContext = 'A'.repeat(500);
        const vars = makeVars({ noteContext: longContext, contextLimit: 100 });
        const result = renderPrompt('Context: {{noteContext}}', vars);
        expect(result).toBe('Context: ' + 'A'.repeat(100));
    });

    it('handles empty task string', () => {
        const result = renderPrompt('Task: {{task}}', makeVars({ task: '' }));
        expect(result).toBe('Task: ');
    });

    it('returns template unchanged when it has no placeholders', () => {
        const template = 'Just a plain template with no placeholders.';
        const result = renderPrompt(template, makeVars());
        expect(result).toBe(template);
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
});
