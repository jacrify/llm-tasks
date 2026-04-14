import { describe, it, expect } from "vitest";
import {
    generateTaskId,
    formatTaskLine,
    formatContinuationLine,
    updateTaskMarker,
    parseTaskLine,
    parseContinuationLine,
    updateTaskSession,
    getIndent,
    findResumeSession,
    findParentTaskLine,
    isIndentedLine,
} from "../src/note-writer";

describe("generateTaskId", () => {
    it("creates correct format with timestamp and slug", () => {
        const ts = new Date("2026-04-14T14:30:22.000Z");
        const id = generateTaskId("Refactor the secret redaction extension", ts);
        expect(id).toBe("2026-04-14_143022_refactor-the-secret-redaction-extension");
    });

    it("handles special characters in task text", () => {
        const ts = new Date("2026-04-14T14:30:22.000Z");
        const id = generateTaskId("Fix bug #123: can't parse @mentions & <tags>!", ts);
        expect(id).toMatch(/^2026-04-14_143022_fix-bug-123-can-t-parse-mentions-tags/);
        expect(id).not.toMatch(/-$/);
        expect(id).not.toMatch(/^.*_-/);
    });
});

describe("formatTaskLine", () => {
    it("produces correct format with session ID in HTML comment", () => {
        const result = formatTaskLine(
            "Refactor the extension",
            "llm-2026-04-14_143022_refactor-the-extension",
            "⏳",
        );
        expect(result).toBe(
            "- ⏳ Refactor the extension <!-- llm:llm-2026-04-14_143022_refactor-the-extension -->"
        );
    });
});

describe("formatContinuationLine", () => {
    it("produces indented line with llm tag, no marker", () => {
        const result = formatContinuationLine(
            "Now add tests",
            "2026-04-14_153000_now-add-tests",
            "  ",
        );
        expect(result).toBe("  - Now add tests <!-- llm:2026-04-14_153000_now-add-tests -->");
    });

    it("handles deeper indent", () => {
        const result = formatContinuationLine("Fix it", "task-id", "    ");
        expect(result).toBe("    - Fix it <!-- llm:task-id -->");
    });
});

describe("updateTaskMarker", () => {
    it("swaps ⏳→✅ correctly", () => {
        const line = "- ⏳ Refactor the extension <!-- llm:llm-123 -->";
        const result = updateTaskMarker(line, "⏳", "✅");
        expect(result).toBe("- ✅ Refactor the extension <!-- llm:llm-123 -->");
    });

    it("swaps ⏳→❌ correctly", () => {
        const line = "- ⏳ Refactor the extension <!-- llm:llm-123 -->";
        const result = updateTaskMarker(line, "⏳", "❌");
        expect(result).toBe("- ❌ Refactor the extension <!-- llm:llm-123 -->");
    });
});

describe("parseTaskLine", () => {
    it("parses task line with session ID", () => {
        const line = "- ⏳ My task text <!-- llm:llm-2026-04-14_143022_my-task -->";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("⏳");
        expect(result!.taskText).toBe("My task text");
        expect(result!.sessionId).toBe("llm-2026-04-14_143022_my-task");
        expect(result!.agentSessionId).toBeUndefined();
    });

    it("parses task line with session UUID", () => {
        const line = "- ✅ Refactor auth <!-- llm:2026-04-14_143022_refactor-auth session:43f72127 -->";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("✅");
        expect(result!.taskText).toBe("Refactor auth");
        expect(result!.sessionId).toBe("2026-04-14_143022_refactor-auth");
        expect(result!.agentSessionId).toBe("43f72127");
    });

    it("parses failed task line", () => {
        const line = "- ❌ My task text <!-- llm:llm-2026-04-14_143022_my-task -->";
        const result = parseTaskLine(line);
        expect(result).not.toBeNull();
        expect(result!.marker).toBe("❌");
    });

    it("parses done task line", () => {
        const line = "- ✅ My task text <!-- llm:llm-2026-04-14_143022_my-task -->";
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

    it("returns null for empty lines", () => {
        expect(parseTaskLine("")).toBeNull();
    });

    it("returns null for old wikilink format", () => {
        const result = parseTaskLine("- ⏳ [[llmlogs/some-task|Some task]]");
        expect(result).toBeNull();
    });
});

describe("parseContinuationLine", () => {
    it("parses indented continuation with llm tag", () => {
        const line = "  - Now add tests <!-- llm:2026-04-14_153000_now-add-tests -->";
        const result = parseContinuationLine(line);
        expect(result).not.toBeNull();
        expect(result!.indent).toBe("  ");
        expect(result!.taskText).toBe("Now add tests");
        expect(result!.taskId).toBe("2026-04-14_153000_now-add-tests");
        expect(result!.agentSessionId).toBeUndefined();
    });

    it("parses continuation with session UUID", () => {
        const line = "  - Add tests <!-- llm:task-123 session:abc-def -->";
        const result = parseContinuationLine(line);
        expect(result).not.toBeNull();
        expect(result!.agentSessionId).toBe("abc-def");
    });

    it("returns null for non-indented lines", () => {
        const line = "- ⏳ Task <!-- llm:task-123 -->";
        expect(parseContinuationLine(line)).toBeNull();
    });

    it("returns null for lines without llm tag", () => {
        const line = "  - Just a sub-item";
        expect(parseContinuationLine(line)).toBeNull();
    });
});

describe("updateTaskSession", () => {
    it("appends session UUID to tag without existing session", () => {
        const line = "- ⏳ Task text <!-- llm:task-123 -->";
        const result = updateTaskSession(line, "abc-def-456");
        expect(result).toBe("- ⏳ Task text <!-- llm:task-123 session:abc-def-456 -->");
    });

    it("replaces existing session UUID", () => {
        const line = "- ✅ Task text <!-- llm:task-123 session:old-session -->";
        const result = updateTaskSession(line, "new-session");
        expect(result).toBe("- ✅ Task text <!-- llm:task-123 session:new-session -->");
    });

    it("works on continuation lines", () => {
        const line = "  - Sub task <!-- llm:task-456 -->";
        const result = updateTaskSession(line, "sess-789");
        expect(result).toBe("  - Sub task <!-- llm:task-456 session:sess-789 -->");
    });
});

describe("getIndent", () => {
    it("returns empty string for non-indented lines", () => {
        expect(getIndent("- task")).toBe("");
    });

    it("returns spaces for indented lines", () => {
        expect(getIndent("  - task")).toBe("  ");
        expect(getIndent("    - task")).toBe("    ");
    });

    it("returns tabs", () => {
        expect(getIndent("\t- task")).toBe("\t");
    });
});

describe("isIndentedLine", () => {
    it("returns true for indented list items", () => {
        expect(isIndentedLine("  - task")).toBe(true);
        expect(isIndentedLine("    - task")).toBe(true);
    });

    it("returns false for non-indented list items", () => {
        expect(isIndentedLine("- task")).toBe(false);
    });

    it("returns false for non-list items", () => {
        expect(isIndentedLine("  some text")).toBe(false);
    });
});

describe("findResumeSession", () => {
    it("finds session from sibling above", () => {
        const lines = [
            "- ✅ Parent task <!-- llm:parent session:parent-sess -->",
            "  - First follow-up <!-- llm:follow1 session:follow1-sess -->",
            "  - Second follow-up",
        ];
        expect(findResumeSession(lines, 2)).toBe("follow1-sess");
    });

    it("falls back to parent when no sibling has session", () => {
        const lines = [
            "- ✅ Parent task <!-- llm:parent session:parent-sess -->",
            "  - First follow-up",
        ];
        expect(findResumeSession(lines, 1)).toBe("parent-sess");
    });

    it("returns null for non-indented lines", () => {
        const lines = [
            "- ✅ Task one <!-- llm:t1 session:s1 -->",
            "- New task",
        ];
        expect(findResumeSession(lines, 1)).toBeNull();
    });

    it("returns null when no session found anywhere", () => {
        const lines = [
            "- ✅ Parent task <!-- llm:parent -->",
            "  - Follow-up",
        ];
        expect(findResumeSession(lines, 1)).toBeNull();
    });

    it("finds closest sibling session (skips siblings without session)", () => {
        const lines = [
            "- ✅ Parent <!-- llm:p session:p-sess -->",
            "  - First <!-- llm:f1 session:f1-sess -->",
            "  - Second <!-- llm:f2 -->",
            "  - Third",
        ];
        // Third should find Second, but Second has no session, so it continues to First
        // Actually, scanning upward: line 2 (Second) has no session, line 1 (First) has session
        expect(findResumeSession(lines, 3)).toBe("f1-sess");
    });

    it("skips children of siblings (deeper indent)", () => {
        const lines = [
            "- ✅ Parent <!-- llm:p session:p-sess -->",
            "  - First <!-- llm:f1 session:f1-sess -->",
            "      - Nested under first",
            "  - Second follow-up",
        ];
        expect(findResumeSession(lines, 3)).toBe("f1-sess");
    });
});

describe("findParentTaskLine", () => {
    it("finds immediate parent", () => {
        const lines = [
            "- ✅ Parent task <!-- llm:parent session:p-sess -->",
            "  - Follow-up",
        ];
        expect(findParentTaskLine(lines, 1)).toBe(0);
    });

    it("returns null for top-level lines", () => {
        const lines = [
            "- ✅ Task <!-- llm:t1 -->",
        ];
        expect(findParentTaskLine(lines, 0)).toBeNull();
    });

    it("returns null when parent is not a task", () => {
        const lines = [
            "Some heading",
            "  - Sub item",
        ];
        expect(findParentTaskLine(lines, 1)).toBeNull();
    });

    it("skips siblings to find parent", () => {
        const lines = [
            "- ✅ Parent <!-- llm:p session:p-sess -->",
            "  - First <!-- llm:f1 session:f1-sess -->",
            "  - Second",
        ];
        expect(findParentTaskLine(lines, 2)).toBe(0);
    });
});
