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
 * Format a task line with the session ID encoded in an HTML comment.
 * Renders as: `- ⏳ Task text <!-- llm:session-id -->`
 * The HTML comment is invisible in Obsidian reading mode.
 */
export function formatTaskLine(
    taskText: string,
    sessionId: string,
    marker: string,
): string {
    return `- ${marker} ${taskText} <!-- llm:${sessionId} -->`;
}

/**
 * Replace the marker in a formatted task line.
 */
export function updateTaskMarker(line: string, oldMarker: string, newMarker: string): string {
    return line.replace(`- ${oldMarker} `, `- ${newMarker} `);
}

/**
 * Parse a formatted task line to extract components.
 * Returns null for non-task lines.
 */
export function parseTaskLine(
    line: string
): { marker: string; sessionId: string; taskText: string } | null {
    // Format: - marker Task text <!-- llm:session-id -->
    const match = line.match(
        /^- ([^\s]+) (.+?) <!-- llm:([^\s]+) -->$/
    );
    if (match) {
        return {
            marker: match[1],
            taskText: match[2],
            sessionId: match[3],
        };
    }

    return null;
}
