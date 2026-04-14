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
    workingDirectory: "vault" | "home" | "custom";
    customWorkingDirectory: string;
    pendingMarker: string;
    doneMarker: string;
    failedMarker: string;
    useWikilinks: boolean;
    agentSettings: Record<string, Record<string, any>>;
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
    workingDirectory: "vault",
    customWorkingDirectory: "",
    pendingMarker: "⏳",
    doneMarker: "✅",
    failedMarker: "❌",
    useWikilinks: true,
    agentSettings: {},
};

export function mergeSettings(loaded: Partial<LlmTasksSettings>): LlmTasksSettings {
    const merged = { ...DEFAULT_SETTINGS, ...loaded };
    // Ensure agentSettings is a proper object, not overwritten entirely
    merged.agentSettings = { ...DEFAULT_SETTINGS.agentSettings, ...(loaded.agentSettings || {}) };
    return merged;
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
            .setDesc("Maximum simultaneous agent processes. 0 = unlimited")
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
            .setDesc("Pass full source note content to the agent as context")
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

        // --- Prompt ---
        containerEl.createEl("h3", { text: "Prompt Configuration" });

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

        // --- Agent ---
        containerEl.createEl("h3", { text: "Agent Configuration" });

        const agents = listAgents();
        new Setting(containerEl)
            .setName("Agent type")
            .setDesc("Which agent adapter to use")
            .addDropdown((dropdown) => {
                for (const agent of agents) {
                    dropdown.addOption(agent.id, agent.name);
                }
                dropdown.setValue(this.plugin.settings.agentType);
                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.agentType = value;
                    await this.plugin.saveSettings();
                    this.display(); // re-render to show agent-specific settings
                });
            });

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

        // --- Agent-specific settings ---
        const currentAgent = getAgent(this.plugin.settings.agentType);
        if (currentAgent && currentAgent.settings.length > 0) {
            containerEl.createEl("h4", { text: `${currentAgent.name} Settings` });

            const agentId = currentAgent.id;
            if (!this.plugin.settings.agentSettings[agentId]) {
                this.plugin.settings.agentSettings[agentId] = {};
            }
            const agentConf = this.plugin.settings.agentSettings[agentId];

            for (const def of currentAgent.settings) {
                const currentValue = agentConf[def.key] ?? def.default;

                const setting = new Setting(containerEl)
                    .setName(def.name)
                    .setDesc(def.description);

                if (def.type === "text") {
                    setting.addText((text) =>
                        text.setValue(String(currentValue)).onChange(async (value: string) => {
                            agentConf[def.key] = value;
                            await this.plugin.saveSettings();
                        })
                    );
                } else if (def.type === "number") {
                    setting.addText((text) =>
                        text.setValue(String(currentValue)).onChange(async (value: string) => {
                            const num = parseFloat(value);
                            if (!isNaN(num)) {
                                agentConf[def.key] = num;
                                await this.plugin.saveSettings();
                            }
                        })
                    );
                } else if (def.type === "toggle") {
                    setting.addToggle((toggle) =>
                        toggle.setValue(Boolean(currentValue)).onChange(async (value: boolean) => {
                            agentConf[def.key] = value;
                            await this.plugin.saveSettings();
                        })
                    );
                } else if (def.type === "dropdown" && def.options) {
                    setting.addDropdown((dropdown) => {
                        for (const opt of def.options!) {
                            dropdown.addOption(opt, opt);
                        }
                        dropdown.setValue(String(currentValue));
                        dropdown.onChange(async (value: string) => {
                            agentConf[def.key] = value;
                            await this.plugin.saveSettings();
                        });
                    });
                }
            }
        }

        // --- Task Line Format ---
        containerEl.createEl("h3", { text: "Task Line Format" });

        new Setting(containerEl)
            .setName("Pending marker")
            .setDesc("Emoji/text for in-progress checkbox")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.pendingMarker)
                    .onChange(async (value: string) => {
                        this.plugin.settings.pendingMarker = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Done marker")
            .setDesc("Emoji/text for completed checkbox")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.doneMarker)
                    .onChange(async (value: string) => {
                        this.plugin.settings.doneMarker = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Failed marker")
            .setDesc("Emoji/text for failed checkbox")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.failedMarker)
                    .onChange(async (value: string) => {
                        this.plugin.settings.failedMarker = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Use wikilinks")
            .setDesc("Wrap dispatched tasks in [[wikilinks]]. If false, keep plain text")
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
