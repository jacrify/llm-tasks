import { PluginSettingTab, App, Setting } from "obsidian";
import { listAgents, getAgent } from "./agents/registry";

export interface LlmTasksSettings {
    logFolder: string;
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
    useWikilinks: boolean;
}

export const DEFAULT_SETTINGS: LlmTasksSettings = {
    logFolder: "llmlogs",
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
    useWikilinks: true,
};

export function mergeSettings(loaded: Partial<LlmTasksSettings>): LlmTasksSettings {
    return { ...DEFAULT_SETTINGS, ...loaded };
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
            .setDesc("Determines cost extraction, session handling, and default command")
            .addDropdown((dropdown) => {
                for (const agent of agents) {
                    dropdown.addOption(agent.id, agent.name);
                }
                dropdown.setValue(this.plugin.settings.agentType);
                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.agentType = value;
                    // Clear custom command so it picks up the new default
                    this.plugin.settings.agentCommand = "";
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        const currentAgent = getAgent(this.plugin.settings.agentType);
        const defaultCmd = currentAgent?.defaultCommand || "pi";

        new Setting(containerEl)
            .setName("Command")
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

        // --- General ---
        containerEl.createEl("h3", { text: "General" });

        new Setting(containerEl)
            .setName("Log folder")
            .setDesc("Vault-relative path for log notes")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.logFolder)
                    .onChange(async (value: string) => {
                        this.plugin.settings.logFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

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

        new Setting(containerEl)
            .setName("Use wikilinks")
            .setDesc("Wrap dispatched tasks in [[wikilinks]]")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useWikilinks)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.useWikilinks = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
