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

- Complete the task directly. Do not ask clarifying questions — make reasonable assumptions and proceed.
- Do NOT modify any lines matching \`- ⏳\`, \`- ✅\`, \`- ❌\`, or \`<!-- llm:\` in the source note. Task status is managed by the llm-tasks plugin.
- Work within the vault directory unless the task says otherwise.
- Be concise.

## Task

{{task}}

## Source Note: {{sourceNoteName}}

{{noteContext}}`;

export function truncateContext(context: string, limit: number): string {
    if (context.length <= limit) return context;
    return context.slice(0, limit);
}

export function renderPrompt(customTemplate: string | null | undefined, vars: PromptVariables): string {
    // Always start with the built-in default prompt.
    // If a custom prompt file exists, append it.
    let t = DEFAULT_PROMPT_TEMPLATE;
    if (customTemplate) {
        t += '\n\n## Additional Instructions\n\n' + customTemplate;
    }
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
