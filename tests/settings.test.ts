import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, LlmTasksSettings } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
    it("has all expected keys with correct default values", () => {
        expect(DEFAULT_SETTINGS.logFolder).toBe("llmlogs");
        expect(DEFAULT_SETTINGS.pollInterval).toBe(5);
        expect(DEFAULT_SETTINGS.maxConcurrent).toBe(5);
        expect(DEFAULT_SETTINGS.notifyOnCompletion).toBe(true);
        expect(DEFAULT_SETTINGS.includeNoteContext).toBe(true);
        expect(DEFAULT_SETTINGS.contextLimit).toBe(10000);
        expect(DEFAULT_SETTINGS.promptFile).toBe("llm-tasks-prompt.md");
        expect(DEFAULT_SETTINGS.agentType).toBe("pi");
        expect(DEFAULT_SETTINGS.workingDirectory).toBe("vault");
        expect(DEFAULT_SETTINGS.customWorkingDirectory).toBe("");
        expect(DEFAULT_SETTINGS.pendingMarker).toBe("⏳");
        expect(DEFAULT_SETTINGS.doneMarker).toBe("✅");
        expect(DEFAULT_SETTINGS.failedMarker).toBe("❌");
        expect(DEFAULT_SETTINGS.useWikilinks).toBe(true);
        expect(DEFAULT_SETTINGS.agentSettings).toEqual({});
    });

    it("contains exactly the expected keys", () => {
        const expectedKeys = [
            "logFolder",
            "pollInterval",
            "maxConcurrent",
            "notifyOnCompletion",
            "includeNoteContext",
            "contextLimit",
            "promptFile",
            "agentType",
            "workingDirectory",
            "customWorkingDirectory",
            "pendingMarker",
            "doneMarker",
            "failedMarker",
            "useWikilinks",
            "agentSettings",
        ];
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(expectedKeys.sort());
    });
});

describe("mergeSettings", () => {
    it("returns full defaults when given empty object", () => {
        const result = mergeSettings({});
        expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it("keeps overrides and fills rest with defaults", () => {
        const result = mergeSettings({
            logFolder: "custom-logs",
            pollInterval: 10,
            useWikilinks: false,
        });
        expect(result.logFolder).toBe("custom-logs");
        expect(result.pollInterval).toBe(10);
        expect(result.useWikilinks).toBe(false);
        // rest should be defaults
        expect(result.maxConcurrent).toBe(5);
        expect(result.notifyOnCompletion).toBe(true);
        expect(result.includeNoteContext).toBe(true);
        expect(result.contextLimit).toBe(10000);
        expect(result.promptFile).toBe("llm-tasks-prompt.md");
        expect(result.agentType).toBe("pi");
        expect(result.workingDirectory).toBe("vault");
        expect(result.customWorkingDirectory).toBe("");
        expect(result.pendingMarker).toBe("⏳");
        expect(result.doneMarker).toBe("✅");
        expect(result.failedMarker).toBe("❌");
        expect(result.agentSettings).toEqual({});
    });

    it("preserves agentSettings for known agents", () => {
        const result = mergeSettings({
            agentSettings: {
                pi: { binaryPath: "/usr/local/bin/pi", model: "opus" },
                "claude-code": { binaryPath: "/usr/bin/claude" },
            },
        });
        expect(result.agentSettings.pi).toEqual({
            binaryPath: "/usr/local/bin/pi",
            model: "opus",
        });
        expect(result.agentSettings["claude-code"]).toEqual({
            binaryPath: "/usr/bin/claude",
        });
        // Other settings should be defaults
        expect(result.logFolder).toBe("llmlogs");
    });

    it("does not lose agentSettings when other fields are overridden", () => {
        const result = mergeSettings({
            logFolder: "my-logs",
            agentSettings: {
                pi: { model: "sonnet" },
            },
        });
        expect(result.logFolder).toBe("my-logs");
        expect(result.agentSettings.pi).toEqual({ model: "sonnet" });
    });
});
