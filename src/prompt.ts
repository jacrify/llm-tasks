export interface PromptVariables {
    task: string;
    sourceNoteName: string;
    noteContext: string;
    vaultPath: string;
    timestamp: string;
    agentId: string;
    contextLimit: number;
}

export const DEFAULT_PROMPT_TEMPLATE = `You are an AI assistant working inside an Obsidian vault at {{vaultPath}}.

## Rules

- Do NOT modify any checkbox lines (lines starting with '- [') in the source note. Task status is managed by the llm-tasks plugin.
- Do NOT create any lines starting with '- [ ]' (checkbox syntax) in ANY file. Checkboxes trigger automated task execution.
- If you need a list, use plain '- ' items, not checkboxes.
- Work within the vault directory unless the task says otherwise.
- Be concise.

## Vault Context

This vault is a personal knowledge base and project management system. Notes use YAML frontmatter with fields like \`type\`, \`areas\`, \`parent\`, \`status\`.

## Task

{{task}}

## Source Note: {{sourceNoteName}}

{{noteContext}}`;

export function truncateContext(context: string, limit: number): string {
    if (context.length <= limit) return context;
    return context.slice(0, limit);
}

export function renderPrompt(template: string | null | undefined, vars: PromptVariables): string {
    const t = template ?? DEFAULT_PROMPT_TEMPLATE;
    const truncatedContext = truncateContext(vars.noteContext, vars.contextLimit);

    const replacements: Record<string, string> = {
        '{{task}}': vars.task,
        '{{sourceNoteName}}': vars.sourceNoteName,
        '{{noteContext}}': truncatedContext,
        '{{vaultPath}}': vars.vaultPath,
        '{{timestamp}}': vars.timestamp,
        '{{agentId}}': vars.agentId,
    };

    let result = t;
    for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.split(placeholder).join(value);
    }
    return result;
}
