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
 * Format a continuation line (indented, no marker emoji).
 * Renders as: `  - Task text <!-- llm:task-id -->`
 */
export function formatContinuationLine(
    taskText: string,
    taskId: string,
    indent: string,
): string {
    return `${indent}- ${taskText} <!-- llm:${taskId} -->`;
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
 * Supports both `<!-- llm:id -->` and `<!-- llm:id session:uuid -->`.
 */
export function parseTaskLine(
    line: string
): { marker: string; sessionId: string; taskText: string; agentSessionId?: string } | null {
    // Format: - marker Task text <!-- llm:session-id -->
    // or:     - marker Task text <!-- llm:session-id session:uuid -->
    const match = line.match(
        /^(\s*)- ([^\s]+) (.+?) <!-- llm:([^\s]+?)(?:\s+session:([^\s]+))? -->$/
    );
    if (match) {
        return {
            marker: match[2],
            taskText: match[3],
            sessionId: match[4],
            agentSessionId: match[5] || undefined,
        };
    }

    return null;
}

/**
 * Parse a continuation line (indented, no marker emoji).
 * Returns null if not a continuation with an llm tag.
 */
export function parseContinuationLine(
    line: string
): { indent: string; taskText: string; taskId: string; agentSessionId?: string } | null {
    const match = line.match(
        /^(\s+)- (.+?) <!-- llm:([^\s]+?)(?:\s+session:([^\s]+))? -->$/
    );
    if (match) {
        return {
            indent: match[1],
            taskText: match[2],
            taskId: match[3],
            agentSessionId: match[4] || undefined,
        };
    }
    return null;
}

/**
 * Append session UUID to an existing HTML comment tag.
 * `<!-- llm:task-id -->` becomes `<!-- llm:task-id session:uuid -->`
 * If session already present, replaces it.
 */
export function updateTaskSession(line: string, sessionId: string): string {
    // Replace existing session tag
    const withSession = line.replace(
        /<!-- llm:([^\s]+?)(?:\s+session:[^\s]+)? -->/,
        `<!-- llm:$1 session:${sessionId} -->`
    );
    return withSession;
}

/**
 * Get the indent level of a line (number of leading whitespace chars).
 */
export function getIndent(line: string): string {
    const match = line.match(/^(\s*)/);
    return match ? match[1] : "";
}

/**
 * Scan upward from lineIndex to find the nearest session tag to resume from.
 * First checks siblings (same indent), then parent (less indent).
 * Returns the agent session ID or null.
 */
export function findResumeSession(lines: string[], lineIndex: number): string | null {
    const currentIndent = getIndent(lines[lineIndex]);
    if (currentIndent.length === 0) return null; // Not indented, can't be a continuation

    // Scan upward for siblings at same indent level
    for (let i = lineIndex - 1; i >= 0; i--) {
        const lineIndent = getIndent(lines[i]);
        if (lineIndent.length < currentIndent.length) {
            // Reached parent level — check this line for session
            const parsed = parseTaskLine(lines[i]);
            if (parsed?.agentSessionId) {
                return parsed.agentSessionId;
            }
            // Also check as continuation line
            const cont = parseContinuationLine(lines[i]);
            if (cont?.agentSessionId) {
                return cont.agentSessionId;
            }
            break; // Stop at parent level
        }
        if (lineIndent.length === currentIndent.length) {
            // Sibling — check for session tag
            const cont = parseContinuationLine(lines[i]);
            if (cont?.agentSessionId) {
                return cont.agentSessionId;
            }
            const parsed = parseTaskLine(lines[i]);
            if (parsed?.agentSessionId) {
                return parsed.agentSessionId;
            }
        }
        // Skip lines with greater indent (children of siblings)
    }

    return null;
}

/**
 * Find the top-level parent task line for a continuation.
 * Walks upward to find the line with less indent that has an llm tag.
 * Returns the line index or null.
 */
export function findParentTaskLine(lines: string[], lineIndex: number): number | null {
    const currentIndent = getIndent(lines[lineIndex]);
    if (currentIndent.length === 0) return null; // Already top-level

    for (let i = lineIndex - 1; i >= 0; i--) {
        const lineIndent = getIndent(lines[i]);
        if (lineIndent.length < currentIndent.length) {
            // Check if this is a task line
            const parsed = parseTaskLine(lines[i]);
            if (parsed) {
                // If this line itself is indented, recurse up to find the true top-level
                if (lineIndent.length > 0) {
                    const grandParent = findParentTaskLine(lines, i);
                    return grandParent !== null ? grandParent : i;
                }
                return i;
            }
            return null; // Parent is not a task line
        }
    }
    return null;
}

/**
 * Check if a line is indented (starts with whitespace before "- ").
 */
export function isIndentedLine(line: string): boolean {
    return /^\s+- /.test(line);
}
