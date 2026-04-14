import { describe, it, expect } from "vitest";
import { parseTaskLine } from "../src/note-writer";
import {
    extractRetryTaskText,
    extractLogNotePath,
    findActiveTaskForParsedLine,
} from "../src/main";
import { TaskRecord } from "../src/agents/types";

describe("extractRetryTaskText", () => {
    it("extracts original task text from a failed wikilink line", () => {
        const line = "- ❌ [[llmlogs/2026-04-14_143022_refactor-stuff|Refactor the secret redaction]]";
        const result = extractRetryTaskText(line, "❌");
        expect(result).toBe("Refactor the secret redaction");
    });

    it("extracts original task text from a failed plain line", () => {
        const line = "- ❌ Fix the broken test";
        const result = extractRetryTaskText(line, "❌");
        expect(result).toBe("Fix the broken test");
    });

    it("returns null for a non-failed line (pending)", () => {
        const line = "- ⏳ [[llmlogs/2026-04-14_143022_some-task|Some task]]";
        const result = extractRetryTaskText(line, "❌");
        expect(result).toBeNull();
    });

    it("returns null for a non-failed line (done)", () => {
        const line = "- ✅ [[llmlogs/2026-04-14_143022_done-task|Done task]]";
        const result = extractRetryTaskText(line, "❌");
        expect(result).toBeNull();
    });

    it("returns null for a non-task line", () => {
        const line = "Just a regular line of text";
        const result = extractRetryTaskText(line, "❌");
        expect(result).toBeNull();
    });
});

describe("extractLogNotePath", () => {
    it("extracts log note path from wikilink task line", () => {
        const line = "- ⏳ [[llmlogs/2026-04-14_143022_refactor-stuff|Refactor stuff]]";
        const result = extractLogNotePath(line);
        expect(result).toBe("llmlogs/2026-04-14_143022_refactor-stuff");
    });

    it("returns null for plain format task line (no log path)", () => {
        const line = "- ⏳ Some plain task";
        const result = extractLogNotePath(line);
        expect(result).toBeNull();
    });

    it("returns null for non-task line", () => {
        const line = "# A heading";
        const result = extractLogNotePath(line);
        expect(result).toBeNull();
    });
});

describe("findActiveTaskForParsedLine", () => {
    const activeTasks: TaskRecord[] = [
        {
            id: "2026-04-14_143022_task-alpha",
            pid: 1234,
            sourceFile: "notes/test.md",
            sourceLine: 5,
            taskText: "Task alpha",
            logNote: "llmlogs/2026-04-14_143022_task-alpha",
            logFile: "/tmp/llm-tasks/2026-04-14_143022_task-alpha.log",
            sessionFile: "/tmp/llm-tasks/sessions/2026-04-14_143022_task-alpha",
            agentId: "pi",
            started: "2026-04-14T14:30:22",
        },
        {
            id: "2026-04-14_150000_task-beta",
            pid: 5678,
            sourceFile: "notes/test.md",
            sourceLine: 10,
            taskText: "Task beta",
            logNote: "llmlogs/2026-04-14_150000_task-beta",
            logFile: "/tmp/llm-tasks/2026-04-14_150000_task-beta.log",
            sessionFile: "/tmp/llm-tasks/sessions/2026-04-14_150000_task-beta",
            agentId: "pi",
            started: "2026-04-14T15:00:00",
        },
    ];

    it("finds active task by logNotePath", () => {
        const parsed = parseTaskLine(
            "- ⏳ [[llmlogs/2026-04-14_143022_task-alpha|Task alpha]]"
        )!;
        expect(parsed).not.toBeNull();
        const result = findActiveTaskForParsedLine(parsed, activeTasks);
        expect(result).toBeDefined();
        expect(result!.id).toBe("2026-04-14_143022_task-alpha");
    });

    it("finds active task by task text fallback", () => {
        const parsed = parseTaskLine("- ⏳ Task beta")!;
        expect(parsed).not.toBeNull();
        const result = findActiveTaskForParsedLine(parsed, activeTasks);
        expect(result).toBeDefined();
        expect(result!.id).toBe("2026-04-14_150000_task-beta");
    });

    it("returns undefined when no match found", () => {
        const parsed = parseTaskLine("- ⏳ Unknown task")!;
        expect(parsed).not.toBeNull();
        const result = findActiveTaskForParsedLine(parsed, activeTasks);
        expect(result).toBeUndefined();
    });
});

describe("parseTaskLine for active task lines", () => {
    it("parses wikilink format correctly", () => {
        const line = "- ⏳ [[llmlogs/2026-04-14_143022_my-task|My task text]]";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("⏳");
        expect(result!.logNotePath).toBe("llmlogs/2026-04-14_143022_my-task");
        expect(result!.taskText).toBe("My task text");
    });

    it("parses failed wikilink format", () => {
        const line = "- ❌ [[llmlogs/2026-04-14_143022_my-task|My task text]]";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("❌");
        expect(result!.logNotePath).toBe("llmlogs/2026-04-14_143022_my-task");
        expect(result!.taskText).toBe("My task text");
    });

    it("parses done wikilink format", () => {
        const line = "- ✅ [[llmlogs/2026-04-14_143022_my-task|My task text]]";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("✅");
    });

    it("returns null for plain text (not a task)", () => {
        const result = parseTaskLine("Just some text");
        expect(result).toBeNull();
    });

    it("returns null for headings", () => {
        const result = parseTaskLine("# Heading");
        expect(result).toBeNull();
    });
});

describe("peek - log file path extraction", () => {
    it("extracts correct log note path for peek lookup", () => {
        const line = "- ⏳ [[llmlogs/2026-04-14_143022_my-task|My task text]]";
        const parsed = parseTaskLine(line)!;
        expect(parsed.logNotePath).toBe("llmlogs/2026-04-14_143022_my-task");

        // The active task's logFile would be at the tmp path, found via matching logNote
        const task: TaskRecord = {
            id: "2026-04-14_143022_my-task",
            pid: 999,
            sourceFile: "notes/test.md",
            sourceLine: 3,
            taskText: "My task text",
            logNote: "llmlogs/2026-04-14_143022_my-task",
            logFile: "/tmp/llm-tasks/2026-04-14_143022_my-task.log",
            sessionFile: "/tmp/llm-tasks/sessions/2026-04-14_143022_my-task",
            agentId: "pi",
            started: "2026-04-14T14:30:22",
        };

        const found = findActiveTaskForParsedLine(parsed, [task]);
        expect(found).toBeDefined();
        expect(found!.logFile).toBe("/tmp/llm-tasks/2026-04-14_143022_my-task.log");
    });
});
