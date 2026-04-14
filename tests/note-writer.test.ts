import { describe, it, expect } from "vitest";
import {
    generateTaskId,
    formatTaskLine,
    updateTaskMarker,
    buildLogNote,
    updateLogNoteOnComplete,
    parseTaskLine,
} from "../src/note-writer";
import { CostData } from "../src/agents/types";

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
        // No leading/trailing hyphens
        expect(id).not.toMatch(/-$/);
        expect(id).not.toMatch(/^.*_-/);
    });
});

describe("formatTaskLine", () => {
    it("produces correct wikilink with useWikilinks=true", () => {
        const result = formatTaskLine(
            "Refactor the extension",
            "llmlogs/2026-04-14_143022_refactor-the-extension",
            "⏳",
            true
        );
        expect(result).toBe(
            "- [⏳] [[llmlogs/2026-04-14_143022_refactor-the-extension|⏳ Refactor the extension]]"
        );
    });

    it("produces plain text with useWikilinks=false", () => {
        const result = formatTaskLine("Refactor the extension", "", "⏳", false);
        expect(result).toBe("- [⏳] Refactor the extension");
    });
});

describe("updateTaskMarker", () => {
    it("swaps ⏳→✅ correctly in wikilink line", () => {
        const line =
            "- [⏳] [[llmlogs/2026-04-14_143022_refactor|⏳ Refactor the extension]]";
        const result = updateTaskMarker(line, "⏳", "✅");
        expect(result).toBe(
            "- [✅] [[llmlogs/2026-04-14_143022_refactor|✅ Refactor the extension]]"
        );
    });

    it("swaps ⏳→❌ correctly", () => {
        const line =
            "- [⏳] [[llmlogs/2026-04-14_143022_refactor|⏳ Refactor the extension]]";
        const result = updateTaskMarker(line, "⏳", "❌");
        expect(result).toBe(
            "- [❌] [[llmlogs/2026-04-14_143022_refactor|❌ Refactor the extension]]"
        );
    });
});

describe("buildLogNote", () => {
    const params = {
        taskText: "Refactor the extension",
        sourceNoteName: "My Project",
        agentId: "pi",
        started: "2026-04-14T14:30:22",
        pid: 48291,
        resumeCommand: "pi --session /tmp/llm-tasks/sessions/abc",
    };

    it("produces valid YAML frontmatter with all required fields", () => {
        const note = buildLogNote(params);
        expect(note).toContain("---\n");
        expect(note).toContain("type: llm-task");
        expect(note).toContain("status: running");
        expect(note).toContain('source: "[[My Project]]"');
        expect(note).toContain("task: 'Refactor the extension'");
        expect(note).toContain("agent: pi");
        expect(note).toContain("started: 2026-04-14T14:30:22");
        expect(note).toContain("pid: 48291");
    });

    it("body has correct sections (Resume, Output)", () => {
        const note = buildLogNote(params);
        expect(note).toContain("# ⏳ Refactor the extension");
        expect(note).toContain("**Source:** [[My Project]]");
        expect(note).toContain("**Status:** ⏳ Running");
        expect(note).toContain("## Resume");
        expect(note).toContain("pi --session /tmp/llm-tasks/sessions/abc");
        expect(note).toContain("## Output");
        expect(note).toContain("_Waiting for completion..._");
    });
});

describe("updateLogNoteOnComplete", () => {
    const baseLogNote = buildLogNote({
        taskText: "Refactor the extension",
        sourceNoteName: "My Project",
        agentId: "pi",
        started: "2026-04-14T14:30:22",
        pid: 48291,
        resumeCommand: "pi --session /tmp/llm-tasks/sessions/abc",
    });

    it("changes status to done on success", () => {
        const result = updateLogNoteOnComplete(baseLogNote, {
            success: true,
            output: "All done!",
            doneMarker: "✅",
            failedMarker: "❌",
            cost: null,
            finished: "2026-04-14T14:35:00",
        });
        expect(result).toContain("status: done");
        expect(result).toContain("# ✅ Refactor the extension");
        expect(result).toContain("**Status:** ✅ Done");
    });

    it("changes status to failed on failure", () => {
        const result = updateLogNoteOnComplete(baseLogNote, {
            success: false,
            output: "Error occurred",
            doneMarker: "✅",
            failedMarker: "❌",
            cost: null,
            finished: "2026-04-14T14:35:00",
        });
        expect(result).toContain("status: failed");
        expect(result).toContain("# ❌ Refactor the extension");
        expect(result).toContain("**Status:** ❌ Failed");
    });

    it("appends output text", () => {
        const result = updateLogNoteOnComplete(baseLogNote, {
            success: true,
            output: "Refactoring complete. 3 files changed.",
            doneMarker: "✅",
            failedMarker: "❌",
            cost: null,
            finished: "2026-04-14T14:35:00",
        });
        expect(result).toContain("Refactoring complete. 3 files changed.");
        expect(result).not.toContain("_Waiting for completion..._");
    });

    it("adds cost line when CostData provided", () => {
        const cost: CostData = {
            model: "us.anthropic.claude-sonnet-4-20250514",
            cost: 0.0534,
            inputTokens: 9603,
            outputTokens: 217,
        };
        const result = updateLogNoteOnComplete(baseLogNote, {
            success: true,
            output: "Done!",
            doneMarker: "✅",
            failedMarker: "❌",
            cost,
            finished: "2026-04-14T14:35:00",
        });
        expect(result).toContain("**Cost:** $0.0534 · us.anthropic.claude-sonnet-4-20250514 · 9,603 in · 217 out");
        expect(result).toContain("cost: 0.0534");
    });

    it("omits cost line when CostData is null", () => {
        const result = updateLogNoteOnComplete(baseLogNote, {
            success: true,
            output: "Done!",
            doneMarker: "✅",
            failedMarker: "❌",
            cost: null,
            finished: "2026-04-14T14:35:00",
        });
        expect(result).not.toContain("**Cost:**");
        expect(result).not.toMatch(/^cost:/m);
    });
});

describe("parseTaskLine", () => {
    it("extracts components from wikilink task line", () => {
        const line =
            "- [⏳] [[llmlogs/2026-04-14_143022_refactor|⏳ Refactor the extension]]";
        const parsed = parseTaskLine(line);
        expect(parsed).not.toBeNull();
        expect(parsed!.marker).toBe("⏳");
        expect(parsed!.logNotePath).toBe("llmlogs/2026-04-14_143022_refactor");
        expect(parsed!.taskText).toBe("Refactor the extension");
    });

    it("extracts components from plain task line", () => {
        const line = "- [⏳] Refactor the extension";
        const parsed = parseTaskLine(line);
        expect(parsed).not.toBeNull();
        expect(parsed!.marker).toBe("⏳");
        expect(parsed!.logNotePath).toBe("");
        expect(parsed!.taskText).toBe("Refactor the extension");
    });

    it("returns null for regular text lines", () => {
        expect(parseTaskLine("Just a regular line of text")).toBeNull();
    });

    it("returns null for empty lines", () => {
        expect(parseTaskLine("")).toBeNull();
    });
});
