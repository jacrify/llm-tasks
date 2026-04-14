import { CostData } from "./agents/types";

/**
 * Generate a task ID from timestamp + slugified task text.
 * Format: "2026-04-14_143022_slug-of-task-text"
 */
export function generateTaskId(taskText: string, timestamp: Date): string {
    const date = timestamp.toISOString().slice(0, 10); // 2026-04-14
    const time = timestamp.toISOString().slice(11, 19).replace(/:/g, ""); // 143022
    const slug = taskText
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)
        .replace(/-$/, "");
    return `${date}_${time}_${slug}`;
}

/**
 * Format a task line for the source note.
 * With wikilinks: `- ⏳ [[llmlogs/2026-04-14_143022_slug|Task text]]`
 * Without:        `- ⏳ Task text`
 */
export function formatTaskLine(
    taskText: string,
    logNotePath: string,
    marker: string,
    useWikilinks: boolean
): string {
    if (useWikilinks) {
        return `- ${marker} [[${logNotePath}|${taskText}]]`;
    }
    return `- ${marker} ${taskText}`;
}

/**
 * Replace the marker in a formatted task line.
 */
export function updateTaskMarker(line: string, oldMarker: string, newMarker: string): string {
    // Replace the first occurrence of the old marker with the new one
    return line.replace(`- ${oldMarker} `, `- ${newMarker} `);
}

/**
 * Build the full log note markdown content.
 */
export function buildLogNote(params: {
    taskText: string;
    sourceNoteName: string;
    agentId: string;
    started: string;
    pid: number;
    resumeCommand: string;
}): string {
    const { taskText, sourceNoteName, agentId, started, pid, resumeCommand } = params;
    // Format started for display: "2026-04-14T14:30:22" → "2026-04-14 14:30:22"
    const startedDisplay = started.replace("T", " ").slice(0, 19);
    const startedFm = started.slice(0, 19);

    return `---
type: llm-task
status: running
source: "[[${sourceNoteName}]]"
task: '${taskText.replace(/'/g, "''")}'
agent: ${agentId}
started: ${startedFm}
pid: ${pid}
---

# ⏳ ${taskText}

**Source:** [[${sourceNoteName}]]
**Status:** ⏳ Running
**Agent:** ${agentId}
**Started:** ${startedDisplay}

## Resume

\`\`\`bash
${resumeCommand}
\`\`\`

## Output

_Waiting for completion..._
`;
}

/**
 * Update a log note on task completion.
 * Changes status in frontmatter and body, replaces waiting text with output,
 * adds cost line if CostData provided.
 */
export function updateLogNoteOnComplete(
    logContent: string,
    params: {
        success: boolean;
        output: string;
        doneMarker: string;
        failedMarker: string;
        cost: CostData | null;
        finished: string;
    }
): string {
    const { success, output, doneMarker, failedMarker, cost, finished } = params;
    const marker = success ? doneMarker : failedMarker;
    const statusWord = success ? "done" : "failed";
    const statusLine = success ? `${doneMarker} Done` : `${failedMarker} Failed`;

    let result = logContent;

    // Update frontmatter status
    result = result.replace(/^status: running$/m, `status: ${statusWord}`);

    // Add cost to frontmatter if available
    if (cost) {
        const costFields: string[] = [];
        if (cost.cost != null) costFields.push(`cost: ${cost.cost.toFixed(4)}`);
        if (cost.model) costFields.push(`model: '${cost.model}'`);
        if (cost.inputTokens != null) costFields.push(`input_tokens: ${cost.inputTokens}`);
        if (cost.outputTokens != null) costFields.push(`output_tokens: ${cost.outputTokens}`);
        if (cost.cacheReadTokens) costFields.push(`cache_read_tokens: ${cost.cacheReadTokens}`);
        if (cost.cacheWriteTokens) costFields.push(`cache_write_tokens: ${cost.cacheWriteTokens}`);
        if (costFields.length > 0) {
            result = result.replace(
                /^(pid: .+)$/m,
                `$1\n${costFields.join('\n')}`
            );
        }
    }

    // Update heading
    result = result.replace(/^# ⏳ /m, `# ${marker} `);

    // Update body status line
    result = result.replace(/\*\*Status:\*\* ⏳ Running/, `**Status:** ${statusLine}`);

    // Add finished timestamp after Started line
    result = result.replace(
        /(\*\*Started:\*\* .+)/,
        `$1\n**Finished:** ${finished.replace("T", " ").slice(0, 19)}`
    );

    // Replace waiting text with output
    result = result.replace("_Waiting for completion..._", output);

    return result;
}

/**
 * Parse a formatted task line to extract components.
 * Returns null for non-task lines.
 */
export function parseTaskLine(
    line: string
): { marker: string; logNotePath: string; taskText: string } | null {
    // Try wikilink format: - marker [[path|taskText]]
    const wikiMatch = line.match(
        /^- ([^\s\[]+) \[\[([^|]+)\|(.+?)\]\]$/
    );
    if (wikiMatch) {
        return {
            marker: wikiMatch[1],
            logNotePath: wikiMatch[2],
            taskText: wikiMatch[3],
        };
    }

    // Try plain format: - marker taskText
    const plainMatch = line.match(/^- ([^\s\[]+) (.+)$/);
    if (plainMatch) {
        return {
            marker: plainMatch[1],
            logNotePath: "",
            taskText: plainMatch[2],
        };
    }

    return null;
}
