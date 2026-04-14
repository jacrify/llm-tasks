import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
    it("has correct default values", () => {
        expect(DEFAULT_SETTINGS.pollInterval).toBe(5);
        expect(DEFAULT_SETTINGS.maxConcurrent).toBe(5);
        expect(DEFAULT_SETTINGS.notifyOnCompletion).toBe(true);
        expect(DEFAULT_SETTINGS.includeNoteContext).toBe(true);
        expect(DEFAULT_SETTINGS.contextLimit).toBe(10000);
        expect(DEFAULT_SETTINGS.promptTemplate).toBe("");
        expect(DEFAULT_SETTINGS.agentCommand).toBe("claude -p --dangerously-skip-permissions");
        expect(DEFAULT_SETTINGS.pendingMarker).toBe("⏳");
        expect(DEFAULT_SETTINGS.doneMarker).toBe("✅");
        expect(DEFAULT_SETTINGS.failedMarker).toBe("❌");
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
            "promptTemplate",
            "agentPreset",
            "agentCommand",
            "pendingMarker",
            "doneMarker",
            "failedMarker",
            "shellPath",
            "extraPath",
            "sessionTemplate",
            "resumeTemplate",
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
            shellPath: "/bin/bash",
        });
        expect(result.pollInterval).toBe(10);
        expect(result.shellPath).toBe("/bin/bash");
        expect(result.maxConcurrent).toBe(5);
        expect(result.notifyOnCompletion).toBe(true);
    });

    it("preserves custom agentCommand", () => {
        const result = mergeSettings({
            agentCommand: "pi -p --model opus",
        });
        expect(result.agentCommand).toBe("pi -p --model opus");
    });

    it("strips stale keys like logFolder, useWikilinks, tmuxCommand, openTerminalCommand, attachOnDispatch", () => {
        const result = mergeSettings({
            logFolder: "llmlogs",
            useWikilinks: true,
            tmuxCommand: "/opt/homebrew/bin/tmux",
            openTerminalCommand: "some command",
            attachOnDispatch: true,
            pollInterval: 10,
        } as any);
        expect(result.pollInterval).toBe(10);
        expect((result as any).logFolder).toBeUndefined();
        expect((result as any).useWikilinks).toBeUndefined();
        expect((result as any).tmuxCommand).toBeUndefined();
        expect((result as any).openTerminalCommand).toBeUndefined();
        expect((result as any).attachOnDispatch).toBeUndefined();
    });

    it("migrates bare 'claude' or 'pi' agentCommand to default", () => {
        expect(mergeSettings({ agentCommand: '' }).agentCommand).toBe('claude -p --dangerously-skip-permissions');
        expect(mergeSettings({ agentCommand: 'claude' }).agentCommand).toBe('claude -p --dangerously-skip-permissions');
        expect(mergeSettings({ agentCommand: 'pi' }).agentCommand).toBe('claude -p --dangerously-skip-permissions');
        expect(mergeSettings({ agentCommand: 'claude -p' }).agentCommand).toBe('claude -p --dangerously-skip-permissions');
    });
});
