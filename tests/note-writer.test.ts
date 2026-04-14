import { describe, it, expect } from "vitest";
import {
    generateTaskId,
    formatTaskLine,
    updateTaskMarker,
    parseTaskLine,
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
