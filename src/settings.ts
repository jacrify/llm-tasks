import { PluginSettingTab, App, Setting } from "obsidian";
import { DEFAULT_PROMPT_TEMPLATE } from "./prompt";

export interface LlmTasksSettings {
    pollInterval: number;
    maxConcurrent: number;
    notifyOnCompletion: boolean;
    includeNoteContext: boolean;
    contextLimit: number;
    promptTemplate: string;
    agentPreset: string;
    agentCommand: string;
    pendingMarker: string;
    doneMarker: string;
    failedMarker: string;
    shellPath: string;
    extraPath: string;
    sessionTemplate: string;
    resumeTemplate: string;
}

export const DEFAULT_SETTINGS: LlmTasksSettings = {
    pollInterval: 5,
    maxConcurrent: 5,
    notifyOnCompletion: true,
    includeNoteContext: true,
    contextLimit: 10000,
    promptTemplate: "",
    agentPreset: "claude",
    agentCommand: "claude -p --dangerously-skip-permissions",
    pendingMarker: "⏳",
    doneMarker: "✅",
    failedMarker: "❌",
    shellPath: "/bin/zsh",
    extraPath: "/opt/homebrew/bin:/usr/local/bin",
    sessionTemplate: "--session-id {sessionId}",
    resumeTemplate: "--resume {sessionId}",
};

const AGENT_PRESETS: Record<string, { agentCommand: string; sessionTemplate: string; resumeTemplate: string }> = {
    claude: {
        agentCommand: 'claude -p --dangerously-skip-permissions',
        sessionTemplate: '--session-id {sessionId}',
        resumeTemplate: '--resume {sessionId}',
    },
    pi: {
        agentCommand: 'pi -p',
        sessionTemplate: '--session /tmp/llm-tasks/sessions/{sessionId}.jsonl',
        resumeTemplate: '--session /tmp/llm-tasks/sessions/{sessionId}.jsonl',
    },
    custom: {
        agentCommand: '',
        sessionTemplate: '',
        resumeTemplate: '',
    },
};

export function mergeSettings(loaded: Partial<LlmTasksSettings>): LlmTasksSettings {
    const clean: Partial<LlmTasksSettings> = {};
    const validKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const [k, v] of Object.entries(loaded)) {
        if (v !== undefined && validKeys.has(k)) {
            (clean as any)[k] = v;
        }
    }

    // Migrate old separate agentCommand + extraArgs into single command
    const old = loaded as any;
    if (old.extraArgs && clean.agentCommand && !clean.agentCommand.includes(old.extraArgs)) {
        const base = clean.agentCommand || old.agentCommand || '';
        // Only migrate if agentCommand looks like old format (no -p flag)
        if (base && !base.includes(' -p')) {
            clean.agentCommand = `${base} -p ${old.extraArgs}`.trim();
        }
    }

    // Migrate old agentCommand defaults
    if (clean.agentCommand === 'claude -p' || clean.agentCommand === '' || clean.agentCommand === 'claude' || clean.agentCommand === 'pi') {
        delete clean.agentCommand;
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

        new Setting(containerEl)
            .setName("Agent preset")
            .setDesc("Select an agent to fill in defaults, or choose Custom to configure manually.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('claude', 'Claude Code')
                    .addOption('pi', 'Pi')
                    .addOption('custom', 'Custom')
                    .setValue(this.plugin.settings.agentPreset || 'claude')
                    .onChange(async (value: string) => {
                        this.plugin.settings.agentPreset = value;
                        const preset = AGENT_PRESETS[value];
                        if (preset && value !== 'custom') {
                            this.plugin.settings.agentCommand = preset.agentCommand;
                            this.plugin.settings.sessionTemplate = preset.sessionTemplate;
                            this.plugin.settings.resumeTemplate = preset.resumeTemplate;
                        }
                        await this.plugin.saveSettings();
                        this.display(); // re-render to update text fields
                    });
            });

        new Setting(containerEl)
            .setName("Agent command")
            .setDesc("Command prefix for the agent. The rendered prompt is appended as the final argument.")
            .addText((text) => {
                text.inputEl.style.width = '300px';
                text.inputEl.style.fontFamily = 'monospace';
                text
                    .setPlaceholder(DEFAULT_SETTINGS.agentCommand)
                    .setValue(this.plugin.settings.agentCommand)
                    .onChange(async (value: string) => {
                        this.plugin.settings.agentCommand = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Session template")
            .setDesc("Args to set session identity. Use {sessionId} placeholder. E.g. --session-id {sessionId} for claude, --session /tmp/llm-tasks/{sessionId}.jsonl for pi.")
            .addText((text) => {
                text.inputEl.style.width = '300px';
                text.inputEl.style.fontFamily = 'monospace';
                text
                    .setPlaceholder("--session-id {sessionId}")
                    .setValue(this.plugin.settings.sessionTemplate)
                    .onChange(async (value: string) => {
                        this.plugin.settings.sessionTemplate = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Resume template")
            .setDesc("Args to resume a session. Use {sessionId} placeholder. E.g. --resume {sessionId} for claude, --session /tmp/llm-tasks/{sessionId}.jsonl for pi.")
            .addText((text) => {
                text.inputEl.style.width = '300px';
                text.inputEl.style.fontFamily = 'monospace';
                text
                    .setPlaceholder("--resume {sessionId}")
                    .setValue(this.plugin.settings.resumeTemplate)
                    .onChange(async (value: string) => {
                        this.plugin.settings.resumeTemplate = value;
                        await this.plugin.saveSettings();
                    });
            });

        // --- Prompt ---
        containerEl.createEl("h3", { text: "Prompt" });

        const promptSetting = new Setting(containerEl)
            .setName("Prompt template")
            .setDesc("The system prompt sent to the agent. Use {{task}}, {{sourceNoteName}}, {{noteContext}}, {{vaultPath}}, {{timestamp}} as placeholders.")
            .addTextArea((text) => {
                text.inputEl.rows = 12;
                text.inputEl.cols = 60;
                text.inputEl.style.fontFamily = 'monospace';
                text.inputEl.style.fontSize = '12px';
                text
                    .setPlaceholder("(default prompt)")
                    .setValue(this.plugin.settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE)
                    .onChange(async (value: string) => {
                        // Store empty string if it matches default (so future default changes apply)
                        this.plugin.settings.promptTemplate = value === DEFAULT_PROMPT_TEMPLATE ? "" : value;
                        await this.plugin.saveSettings();
                    });
            });
        promptSetting.settingEl.addClass('llm-tasks-wide-setting');

        new Setting(containerEl)
            .setName("Include note context")
            .setDesc("Pass the full source note content to the agent via {{noteContext}}")
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

        // --- Shell ---
        containerEl.createEl("h3", { text: "Shell" });

        new Setting(containerEl)
            .setName("Shell path")
            .setDesc("Shell used to run agent commands. Must support -c flag.")
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
            .setDesc("Colon-separated paths prepended to PATH when running agents. Needed because Obsidian GUI apps have a minimal PATH.")
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
    }
}
