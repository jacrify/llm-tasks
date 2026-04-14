import { Plugin, Notice, Modal, MarkdownView, App } from "obsidian";
import { TaskManager, TaskManagerDeps } from "./task-manager";
import { LlmTasksSettings, DEFAULT_SETTINGS, mergeSettings, LlmTasksSettingTab } from "./settings";
import { formatTaskLine, parseTaskLine } from "./note-writer";
import { getAgent } from "./agents/registry";
import { TaskRecord } from "./agents/types";

class PeekModal extends Modal {
    private title: string;
    private content: string;

    constructor(app: App, title: string, content: string) {
        super(app);
        this.title = title;
        this.content = content;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: this.title });
        const pre = contentEl.createEl("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.maxHeight = "400px";
        pre.style.overflow = "auto";
        pre.setText(this.content);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class ActiveTasksModal extends Modal {
    private plugin: LlmTasksPlugin;

    constructor(app: App, plugin: LlmTasksPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Active Tasks" });

        const tasks = this.plugin.taskManager!.getActiveTasks();
        if (tasks.length === 0) {
            contentEl.createEl("p", { text: "No active tasks." });
            return;
        }

        const table = contentEl.createEl("table");
        table.style.width = "100%";
        const thead = table.createEl("thead");
        const headerRow = thead.createEl("tr");
        headerRow.createEl("th", { text: "Task" });
        headerRow.createEl("th", { text: "Runtime" });
        headerRow.createEl("th", { text: "Status" });
        headerRow.createEl("th", { text: "Actions" });

        const tbody = table.createEl("tbody");
        for (const task of tasks) {
            const row = tbody.createEl("tr");
            const preview = task.taskText.length > 50 ? task.taskText.slice(0, 50) + "…" : task.taskText;
            row.createEl("td", { text: preview });

            const elapsed = Math.floor((Date.now() - new Date(task.started).getTime()) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            row.createEl("td", { text: `${minutes}m ${seconds}s` });

            row.createEl("td", { text: "⏳ Running" });

            const actionsCell = row.createEl("td");
            const peekBtn = actionsCell.createEl("button", { text: "Peek" });
            peekBtn.addEventListener("click", async () => {
                const agent = getAgent(task.agentId);
                if (agent) {
                    const output = await agent.peek(task.logFile);
                    new PeekModal(this.app, `Peek: ${preview}`, output).open();
                }
            });

            const cancelBtn = actionsCell.createEl("button", { text: "Cancel" });
            cancelBtn.style.marginLeft = "4px";
            cancelBtn.addEventListener("click", async () => {
                try {
                    await this.plugin.taskManager!.cancel(task.id);
                    new Notice("Task cancelled.");
                    this.close();
                } catch (e: any) {
                    new Notice(`Cancel failed: ${e.message}`);
                }
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export default class LlmTasksPlugin extends Plugin {
    settings: LlmTasksSettings = DEFAULT_SETTINGS;
    taskManager: TaskManager | null = null;
    private statusBarEl: HTMLElement | null = null;

    async onload() {
        // Load settings
        const loaded = await this.loadData() || {};
        this.settings = mergeSettings(loaded.settings || loaded || {});

        // Create deps
        const deps = this.createDeps();

        // Create task manager
        this.taskManager = new TaskManager(deps, this.settings);

        // Detect stale tasks from previous sessions
        await this.taskManager.detectStaleTasks();

        // Start polling
        this.taskManager.startPolling();

        // Status bar
        this.statusBarEl = this.addStatusBarItem();
        this.updateStatusBar(this.taskManager.getActiveTaskCount());
        this.statusBarEl.addEventListener("click", () => {
            new ActiveTasksModal(this.app, this).open();
        });

        // Register commands
        this.registerCommands();

        // Settings tab
        this.addSettingTab(new LlmTasksSettingTab(this.app, this));
    }

    onunload() {
        if (this.taskManager) {
            this.taskManager.stopPolling();
            // Fire-and-forget cleanup — kills active processes
            this.taskManager.cleanup();
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData({ settings: this.settings });
        if (this.taskManager) {
            this.taskManager.updateSettings(this.settings);
        }
    }

    private createDeps(): TaskManagerDeps {
        return {
            readFile: async (filePath: string): Promise<string | null> => {
                try {
                    return await this.app.vault.adapter.read(filePath);
                } catch {
                    return null;
                }
            },
            writeFile: async (filePath: string, content: string): Promise<void> => {
                const existing = this.app.vault.getAbstractFileByPath(filePath);
                if (existing) {
                    await this.app.vault.adapter.write(filePath, content);
                } else {
                    await this.app.vault.create(filePath, content);
                }
            },
            ensureFolder: async (folderPath: string): Promise<void> => {
                const existing = this.app.vault.getAbstractFileByPath(folderPath);
                if (!existing) {
                    try {
                        await this.app.vault.createFolder(folderPath);
                    } catch {
                        // folder may already exist
                    }
                }
            },
            getVaultPath: (): string => {
                return (this.app.vault.adapter as any).getBasePath?.() || "";
            },
            loadData: async (): Promise<any> => {
                return await this.loadData();
            },
            saveData: async (data: any): Promise<void> => {
                // Merge with existing settings data
                const existing = await this.loadData() || {};
                await this.saveData({ ...existing, ...data });
            },
            notify: (message: string): void => {
                new Notice(message);
            },
            onTaskCountChanged: (count: number): void => {
                this.updateStatusBar(count);
            },
        };
    }

    private updateStatusBar(count: number): void {
        if (this.statusBarEl) {
            this.statusBarEl.setText(count > 0 ? `🤖 ${count} running` : `🤖 0`);
        }
    }

    private registerCommands(): void {
        // dispatch
        this.addCommand({
            id: "dispatch",
            name: "Dispatch task",
            editorCallback: async (editor: any, view: any) => {
                const cursor = editor.getCursor();
                const line = cursor.line;
                const lineText = editor.getLine(line);
                const noteContent = editor.getValue();
                const sourceFile = view.file?.path || "";

                try {
                    const record = await this.taskManager!.dispatch(
                        lineText,
                        sourceFile,
                        line,
                        noteContent
                    );
                    const taskLine = formatTaskLine(
                        record.taskText,
                        record.logNote,
                        this.settings.pendingMarker,
                        this.settings.useWikilinks
                    );
                    editor.setLine(line, taskLine);
                } catch (e: any) {
                    new Notice(e.message);
                }
            },
        });

        // cancel
        this.addCommand({
            id: "cancel",
            name: "Cancel task",
            editorCallback: async (editor: any) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                const parsed = parseTaskLine(lineText);
                if (!parsed) {
                    new Notice("Current line is not a task.");
                    return;
                }
                const task = this.findActiveTaskForLine(parsed);
                if (!task) {
                    new Notice("No active task found for this line.");
                    return;
                }
                try {
                    await this.taskManager!.cancel(task.id);
                    new Notice("Task cancelled.");
                } catch (e: any) {
                    new Notice(`Cancel failed: ${e.message}`);
                }
            },
        });

        // retry
        this.addCommand({
            id: "retry",
            name: "Retry task",
            editorCallback: async (editor: any, view: any) => {
                const cursor = editor.getCursor();
                const line = cursor.line;
                const lineText = editor.getLine(line);
                const parsed = parseTaskLine(lineText);
                if (!parsed) {
                    new Notice("Current line is not a task.");
                    return;
                }
                if (parsed.marker !== this.settings.failedMarker) {
                    new Notice("Can only retry failed tasks.");
                    return;
                }
                const taskText = parsed.taskText;
                const noteContent = editor.getValue();
                const sourceFile = view.file?.path || "";

                try {
                    const record = await this.taskManager!.dispatch(
                        taskText,
                        sourceFile,
                        line,
                        noteContent
                    );
                    const taskLine = formatTaskLine(
                        record.taskText,
                        record.logNote,
                        this.settings.pendingMarker,
                        this.settings.useWikilinks
                    );
                    editor.setLine(line, taskLine);
                } catch (e: any) {
                    new Notice(e.message);
                }
            },
        });

        // show-log
        this.addCommand({
            id: "show-log",
            name: "Show log",
            editorCallback: async (editor: any) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                const parsed = parseTaskLine(lineText);
                if (!parsed || !parsed.logNotePath) {
                    new Notice("No log note found for this line.");
                    return;
                }
                await this.app.workspace.openLinkText(parsed.logNotePath, "");
            },
        });

        // peek
        this.addCommand({
            id: "peek",
            name: "Peek at task",
            editorCallback: async (editor: any) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                const parsed = parseTaskLine(lineText);
                if (!parsed) {
                    new Notice("Current line is not a task.");
                    return;
                }

                // Try active task first
                const task = this.findActiveTaskForLine(parsed);
                if (task) {
                    const agent = getAgent(task.agentId);
                    if (agent) {
                        const output = await agent.peek(task.logFile);
                        new PeekModal(this.app, `Peek: ${task.taskText.slice(0, 50)}`, output).open();
                        return;
                    }
                }

                // Fallback: tail the tmpdir log file directly
                if (parsed.logNotePath) {
                    const taskId = parsed.logNotePath.split('/').pop() || '';
                    const logFile = require('path').join(require('os').tmpdir(), 'llm-tasks', `${taskId}.log`);
                    const fs = require('fs');
                    if (fs.existsSync(logFile)) {
                        const content = fs.readFileSync(logFile, 'utf-8');
                        const lines = content.split('\n');
                        const tail = lines.slice(-50).join('\n');
                        new PeekModal(this.app, `Peek: ${parsed.taskText.slice(0, 50)}`, tail || '(empty)').open();
                        return;
                    }
                }

                new Notice("Could not read task output.");
            },
        });

        // show-active
        this.addCommand({
            id: "show-active",
            name: "Show active tasks",
            callback: () => {
                new ActiveTasksModal(this.app, this).open();
            },
        });

        // cancel-all
        this.addCommand({
            id: "cancel-all",
            name: "Cancel all tasks",
            callback: async () => {
                const count = this.taskManager!.getActiveTaskCount();
                if (count === 0) {
                    new Notice("No active tasks to cancel.");
                    return;
                }
                await this.taskManager!.cancelAll();
                new Notice(`Cancelled ${count} task(s).`);
            },
        });
    }

    private async readVaultFile(path: string): Promise<string | null> {
        try {
            return await this.app.vault.adapter.read(path);
        } catch {
            return null;
        }
    }

    private findActiveTaskForLine(parsed: { logNotePath: string; taskText: string }): TaskRecord | undefined {
        const tasks = this.taskManager!.getActiveTasks();
        // Match by logNotePath first (most reliable)
        if (parsed.logNotePath) {
            const found = tasks.find(t => t.logNote === parsed.logNotePath);
            if (found) return found;
        }
        // Fallback: match by task text
        return tasks.find(t => t.taskText === parsed.taskText);
    }
}

// Export helpers for testing
export { PeekModal, ActiveTasksModal };
export function extractRetryTaskText(
    lineText: string,
    failedMarker: string
): string | null {
    const parsed = parseTaskLine(lineText);
    if (!parsed) return null;
    if (parsed.marker !== failedMarker) return null;
    return parsed.taskText;
}

export function extractLogNotePath(lineText: string): string | null {
    const parsed = parseTaskLine(lineText);
    if (!parsed || !parsed.logNotePath) return null;
    return parsed.logNotePath;
}

export function findActiveTaskForParsedLine(
    parsed: { logNotePath: string; taskText: string },
    activeTasks: TaskRecord[]
): TaskRecord | undefined {
    if (parsed.logNotePath) {
        const found = activeTasks.find(t => t.logNote === parsed.logNotePath);
        if (found) return found;
    }
    return activeTasks.find(t => t.taskText === parsed.taskText);
}
