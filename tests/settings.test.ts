import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, LlmTasksSettings } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
    it("has all expected keys with correct default values", () => {
        expect(DEFAULT_SETTINGS.pollInterval).toBe(5);
        expect(DEFAULT_SETTINGS.maxConcurrent).toBe(5);
        expect(DEFAULT_SETTINGS.notifyOnCompletion).toBe(true);
        expect(DEFAULT_SETTINGS.includeNoteContext).toBe(true);
        expect(DEFAULT_SETTINGS.contextLimit).toBe(10000);
        expect(DEFAULT_SETTINGS.promptFile).toBe("llm-tasks-prompt.md");
        expect(DEFAULT_SETTINGS.agentType).toBe("pi");
        expect(DEFAULT_SETTINGS.agentCommand).toBe("");
        expect(DEFAULT_SETTINGS.extraArgs).toBe("");
        expect(DEFAULT_SETTINGS.workingDirectory).toBe("vault");
        expect(DEFAULT_SETTINGS.customWorkingDirectory).toBe("");
        expect(DEFAULT_SETTINGS.pendingMarker).toBe("⏳");
        expect(DEFAULT_SETTINGS.doneMarker).toBe("✅");
        expect(DEFAULT_SETTINGS.failedMarker).toBe("❌");
        expect(DEFAULT_SETTINGS.tmuxCommand).toBe("tmux");
        expect(DEFAULT_SETTINGS.openTerminalCommand).toContain("osascript");
        expect(DEFAULT_SETTINGS.openTerminalCommand).toContain("{cmd}");
        expect(DEFAULT_SETTINGS.shellPath).toBe("/bin/zsh");
        expect(DEFAULT_SETTINGS.extraPath).toBe("/opt/homebrew/bin:/usr/local/bin");
    });

    it("contains exactly the expected keys", () => {
        const expectedKeys = [
            "pollInterval",
            "maxConcurrent",
            "notifyOnCompletion",
            "includeNoteContext",
            "contextLimit",
            "promptFile",
            "agentType",
            "agentCommand",
            "extraArgs",
            "workingDirectory",
            "customWorkingDirectory",
            "pendingMarker",
            "doneMarker",
            "failedMarker",
            "tmuxCommand",
            "openTerminalCommand",
            "shellPath",
            "extraPath",
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
            pollInterval: 10,
            tmuxCommand: "/opt/homebrew/bin/tmux",
            shellPath: "/bin/bash",
        });
        expect(result.pollInterval).toBe(10);
        expect(result.tmuxCommand).toBe("/opt/homebrew/bin/tmux");
        expect(result.shellPath).toBe("/bin/bash");
        expect(result.maxConcurrent).toBe(5);
        expect(result.notifyOnCompletion).toBe(true);
    });

    it("preserves agentCommand and extraArgs overrides", () => {
        const result = mergeSettings({
            agentCommand: "/usr/local/bin/pi",
            extraArgs: "--model opus --provider amazon-bedrock",
        });
        expect(result.agentCommand).toBe("/usr/local/bin/pi");
        expect(result.extraArgs).toBe("--model opus --provider amazon-bedrock");
    });

    it("strips stale keys like logFolder and useWikilinks", () => {
        const result = mergeSettings({
            logFolder: "llmlogs",
            useWikilinks: true,
            pollInterval: 10,
        } as any);
        expect(result.pollInterval).toBe(10);
        expect((result as any).logFolder).toBeUndefined();
        expect((result as any).useWikilinks).toBeUndefined();
    });

    it("migrates old openTerminalCommand default to new one with activate", () => {
        const result = mergeSettings({
            openTerminalCommand: `osascript -e 'tell application "Terminal" to do script "{cmd}"'`,
        });
        expect(result.openTerminalCommand).toContain("activate");
        expect(result.openTerminalCommand).toBe(DEFAULT_SETTINGS.openTerminalCommand);
    });

    it("preserves custom openTerminalCommand", () => {
        const custom = `osascript -e 'tell application "iTerm" to do script "{cmd}"'`;
        const result = mergeSettings({ openTerminalCommand: custom });
        expect(result.openTerminalCommand).toBe(custom);
    });
});
