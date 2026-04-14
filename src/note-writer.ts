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
 * With wikilinks: `- [⏳] [[llmlogs/2026-04-14_143022_slug|⏳ Task text]]`
 * Without:        `- [⏳] Task text`
 */
export function formatTaskLine(
    taskText: string,
    logNotePath: string,
    marker: string,
    useWikilinks: boolean
): string {
    if (useWikilinks) {
        return `- [${marker}] [[${logNotePath}|${marker} ${taskText}]]`;
    }
    return `- [${marker}] ${taskText}`;
}

/**
 * Replace the marker in a formatted task line (both checkbox and wikilink alias).
 */
export function updateTaskMarker(line: string, oldMarker: string, newMarker: string): string {
    // Replace checkbox marker: [old] → [new]
    let result = line.replace(`[${oldMarker}]`, `[${newMarker}]`);
    // Replace wikilink alias marker: |old  → |new
    result = result.replace(`|${oldMarker} `, `|${newMarker} `);
    return result;
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
    if (cost && cost.cost != null) {
        result = result.replace(
            /^(pid: .+)$/m,
            `$1\ncost: ${cost.cost.toFixed(4)}`
        );
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

    // Build cost line if available
    let costLine = "";
    if (cost) {
        const parts: string[] = [];
        if (cost.cost != null) parts.push(`$${cost.cost.toFixed(4)}`);
        if (cost.model) parts.push(cost.model);
        if (cost.inputTokens != null)
            parts.push(`${cost.inputTokens.toLocaleString()} in`);
        if (cost.outputTokens != null)
            parts.push(`${cost.outputTokens.toLocaleString()} out`);
        costLine = `**Cost:** ${parts.join(" · ")}\n`;
    }

    // Replace waiting text with output (and optional cost)
    const outputSection = costLine
        ? `${costLine}\n${output}`
        : output;
    result = result.replace("_Waiting for completion..._", outputSection);

    return result;
}

/**
 * Parse a formatted task line to extract components.
 * Returns null for non-task lines.
 */
export function parseTaskLine(
    line: string
): { marker: string; logNotePath: string; taskText: string } | null {
    // Try wikilink format: - [marker] [[path|marker taskText]]
    const wikiMatch = line.match(
        /^- \[([^\]]+)\] \[\[([^|]+)\|[^\]]*? (.+?)\]\]$/
    );
    if (wikiMatch) {
        return {
            marker: wikiMatch[1],
            logNotePath: wikiMatch[2],
            taskText: wikiMatch[3],
        };
    }

    // Try plain format: - [marker] taskText
    const plainMatch = line.match(/^- \[([^\]]+)\] (.+)$/);
    if (plainMatch) {
        return {
            marker: plainMatch[1],
            logNotePath: "",
            taskText: plainMatch[2],
        };
    }

    return null;
}
