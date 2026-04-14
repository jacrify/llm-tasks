import { PluginSettingTab, App, Setting } from "obsidian";
import { listAgents, getAgent } from "./agents/registry";

export interface LlmTasksSettings {
    pollInterval: number;
    maxConcurrent: number;
    notifyOnCompletion: boolean;
    includeNoteContext: boolean;
    contextLimit: number;
    promptFile: string;
    agentType: string;
    agentCommand: string;
    extraArgs: string;
    workingDirectory: "vault" | "home" | "custom";
    customWorkingDirectory: string;
    pendingMarker: string;
    doneMarker: string;
    failedMarker: string;
    tmuxCommand: string;
    openTerminalCommand: string;
    shellPath: string;
    extraPath: string;
}

export const DEFAULT_SETTINGS: LlmTasksSettings = {
    pollInterval: 5,
    maxConcurrent: 5,
    notifyOnCompletion: true,
    includeNoteContext: true,
    contextLimit: 10000,
    promptFile: "llm-tasks-prompt.md",
    agentType: "pi",
    agentCommand: "",
    extraArgs: "",
    workingDirectory: "vault",
    customWorkingDirectory: "",
    pendingMarker: "⏳",
    doneMarker: "✅",
    failedMarker: "❌",
    tmuxCommand: "tmux",
    openTerminalCommand: `osascript -e 'tell application "Terminal"' -e 'do script "{cmd}"' -e 'activate' -e 'end tell'`,
    shellPath: "/bin/zsh",
    extraPath: "/opt/homebrew/bin:/usr/local/bin",
};

const OLD_OPEN_TERMINAL = `osascript -e 'tell application "Terminal" to do script "{cmd}"'`;

export function mergeSettings(loaded: Partial<LlmTasksSettings>): LlmTasksSettings {
    // Filter out undefined values so they don't overwrite defaults
    const clean: Partial<LlmTasksSettings> = {};
    const validKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const [k, v] of Object.entries(loaded)) {
        // Drop unknown/stale keys and undefined values
        if (v !== undefined && validKeys.has(k)) {
            (clean as any)[k] = v;
        }
    }

    // Migrate old openTerminalCommand default (missing 'activate')
    if (clean.openTerminalCommand === OLD_OPEN_TERMINAL) {
        delete clean.openTerminalCommand;
    }

    return { ...DEFAULT_SETTINGS, ...clean };
}

export class LlmTasksSettingTab extends PluginSettingTab {
    plugin: any;

    constructor(app: App, plugin: any) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "LLM Tasks Settings" });

        // --- Agent ---
        containerEl.createEl("h3", { text: "Agent" });

        const agents = listAgents();
        new Setting(containerEl)
            .setName("Agent type")
            .setDesc("Which agent to use for task dispatch")
            .addDropdown((dropdown) => {
                for (const agent of agents) {
                    dropdown.addOption(agent.id, agent.name);
                }
                dropdown.setValue(this.plugin.settings.agentType);
                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.agentType = value;
                    this.plugin.settings.agentCommand = "";
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        const currentAgent = getAgent(this.plugin.settings.agentType);
        const defaultCmd = currentAgent?.defaultCommand || "pi";

        new Setting(containerEl)
            .setName("Agent command")
            .setDesc(`Agent binary to run. Leave blank for default: "${defaultCmd}"`)
            .addText((text) =>
                text
                    .setPlaceholder(defaultCmd)
                    .setValue(this.plugin.settings.agentCommand)
                    .onChange(async (value: string) => {
                        this.plugin.settings.agentCommand = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Extra arguments")
            .setDesc("Additional CLI args, e.g. --model opus --provider amazon-bedrock")
            .addText((text) =>
                text
                    .setPlaceholder("--model sonnet")
                    .setValue(this.plugin.settings.extraArgs)
                    .onChange(async (value: string) => {
                        this.plugin.settings.extraArgs = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Working directory")
            .setDesc("Where to run agent processes")
            .addDropdown((dropdown) => {
                dropdown.addOption("vault", "Vault root");
                dropdown.addOption("home", "User home");
                dropdown.addOption("custom", "Custom path");
                dropdown.setValue(this.plugin.settings.workingDirectory);
                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.workingDirectory = value as "vault" | "home" | "custom";
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        if (this.plugin.settings.workingDirectory === "custom") {
            new Setting(containerEl)
                .setName("Custom working directory")
                .setDesc("Absolute path for agent working directory")
                .addText((text) =>
                    text
                        .setValue(this.plugin.settings.customWorkingDirectory)
                        .onChange(async (value: string) => {
                            this.plugin.settings.customWorkingDirectory = value;
                            await this.plugin.saveSettings();
                        })
                );
        }

        // --- Terminal ---
        containerEl.createEl("h3", { text: "Terminal" });

        new Setting(containerEl)
            .setName("tmux command")
            .setDesc("Path to tmux binary")
            .addText((text) =>
                text
                    .setPlaceholder("tmux")
                    .setValue(this.plugin.settings.tmuxCommand)
                    .onChange(async (value: string) => {
                        this.plugin.settings.tmuxCommand = value;
                        await this.plugin.saveSettings();
                    })
            );

        const termSetting = new Setting(containerEl)
            .setName("Open terminal command")
            .setDesc('Shell command to open a terminal window. Use {cmd} where the tmux attach command should go.')
            .addTextArea((text) => {
                text.inputEl.rows = 3;
                text.inputEl.cols = 60;
                text.inputEl.style.fontFamily = 'monospace';
                text.inputEl.style.fontSize = '12px';
                text
                    .setPlaceholder(DEFAULT_SETTINGS.openTerminalCommand)
                    .setValue(this.plugin.settings.openTerminalCommand)
                    .onChange(async (value: string) => {
                        this.plugin.settings.openTerminalCommand = value;
                        await this.plugin.saveSettings();
                    });
            });
        termSetting.settingEl.addClass('llm-tasks-wide-setting');

        new Setting(containerEl)
            .setName("Shell path")
            .setDesc("Shell used to run tmux commands. Must support -c flag.")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_SETTINGS.shellPath)
                    .setValue(this.plugin.settings.shellPath)
                    .onChange(async (value: string) => {
                        this.plugin.settings.shellPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Extra PATH entries")
            .setDesc("Colon-separated paths prepended to PATH when running tmux. Needed because Obsidian GUI apps have a minimal PATH.")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_SETTINGS.extraPath)
                    .setValue(this.plugin.settings.extraPath)
                    .onChange(async (value: string) => {
                        this.plugin.settings.extraPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- General ---
        containerEl.createEl("h3", { text: "General" });

        new Setting(containerEl)
            .setName("Prompt file")
            .setDesc("Vault-relative path to the prompt template")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.promptFile)
                    .onChange(async (value: string) => {
                        this.plugin.settings.promptFile = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Poll interval")
            .setDesc("Seconds between checking for task completion")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.pollInterval))
                    .onChange(async (value: string) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.pollInterval = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(containerEl)
            .setName("Max concurrent tasks")
            .setDesc("Maximum simultaneous agents. 0 = unlimited")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.maxConcurrent))
                    .onChange(async (value: string) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num >= 0) {
                            this.plugin.settings.maxConcurrent = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(containerEl)
            .setName("Notify on completion")
            .setDesc("Show Obsidian notice when a task finishes")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.notifyOnCompletion)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.notifyOnCompletion = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Include note context")
            .setDesc("Pass full source note content to the agent")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.includeNoteContext)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.includeNoteContext = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Context limit")
            .setDesc("Max characters of note context to include")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.contextLimit))
                    .onChange(async (value: string) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.contextLimit = num;
                            await this.plugin.saveSettings();
                        }
                    })
            );
    }
}
