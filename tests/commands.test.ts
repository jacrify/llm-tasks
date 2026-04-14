import { describe, it, expect } from "vitest";
import { parseTaskLine } from "../src/note-writer";
import { TaskRecord } from "../src/agents/types";

function findActiveTaskForParsedLine(
    parsed: { sessionId: string; taskText: string },
    activeTasks: TaskRecord[]
): TaskRecord | undefined {
    return activeTasks.find(t => t.id === parsed.sessionId);
}

describe("findActiveTaskForParsedLine", () => {
    const activeTasks: TaskRecord[] = [
        {
            id: "2026-04-14_143022_task-alpha",
            pid: 12345,
            logFile: "/tmp/llm-tasks/2026-04-14_143022_task-alpha.log",
            sourceFile: "notes/test.md",
            sourceLine: 5,
            taskText: "Task alpha",
            started: "2026-04-14T14:30:22",
        },
        {
            id: "2026-04-14_150000_task-beta",
            pid: 12346,
            logFile: "/tmp/llm-tasks/2026-04-14_150000_task-beta.log",
            sourceFile: "notes/test.md",
            sourceLine: 10,
            taskText: "Task beta",
            started: "2026-04-14T15:00:00",
        },
    ];

    it("finds active task by ID", () => {
        const parsed = parseTaskLine(
            "- ⏳ Task alpha <!-- llm:2026-04-14_143022_task-alpha -->"
        )!;
        expect(parsed).not.toBeNull();
        const result = findActiveTaskForParsedLine(parsed, activeTasks);
        expect(result).toBeDefined();
        expect(result!.id).toBe("2026-04-14_143022_task-alpha");
    });

    it("returns undefined when no match found", () => {
        const parsed = parseTaskLine("- ⏳ Unknown task <!-- llm:unknown-id -->");
        expect(parsed).not.toBeNull();
        const result = findActiveTaskForParsedLine(parsed!, activeTasks);
        expect(result).toBeUndefined();
    });
});

describe("parseTaskLine for active task lines", () => {
    it("parses task line with session correctly", () => {
        const line = "- ⏳ My task text <!-- llm:2026-04-14_143022_my-task -->";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("⏳");
        expect(result!.sessionId).toBe("2026-04-14_143022_my-task");
        expect(result!.taskText).toBe("My task text");
    });

    it("parses failed task line", () => {
        const line = "- ❌ My task text <!-- llm:2026-04-14_143022_my-task -->";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("❌");
    });

    it("parses done task line", () => {
        const line = "- ✅ My task text <!-- llm:2026-04-14_143022_my-task -->";
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
