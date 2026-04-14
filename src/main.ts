import { Plugin, Notice } from "obsidian";
import { TaskManager, TaskManagerDeps } from "./task-manager";
import { LlmTasksSettings, DEFAULT_SETTINGS, mergeSettings, LlmTasksSettingTab } from "./settings";
import { formatTaskLine, parseTaskLine } from "./note-writer";
import { getAgent } from "./agents/registry";
import { TaskRecord } from "./agents/types";

export default class LlmTasksPlugin extends Plugin {
    settings: LlmTasksSettings = DEFAULT_SETTINGS;
    taskManager: TaskManager | null = null;
    private statusBarEl: HTMLElement | null = null;

    async onload() {
        const loaded = await this.loadData() || {};
        this.settings = mergeSettings(loaded.settings || loaded || {});

        const deps = this.createDeps();
        this.taskManager = new TaskManager(deps, this.settings);

        await this.taskManager.detectStaleTasks();
        this.taskManager.startPolling();

        // Status bar
        this.statusBarEl = this.addStatusBarItem();
        this.updateStatusBar(this.taskManager.getActiveTaskCount());

        this.registerCommands();
        this.addSettingTab(new LlmTasksSettingTab(this.app, this));
    }

    onunload() {
        if (this.taskManager) {
            this.taskManager.stopPolling();
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
            getVaultPath: (): string => {
                return (this.app.vault.adapter as any).getBasePath?.() || "";
            },
            loadData: async (): Promise<any> => {
                return await this.loadData();
            },
            saveData: async (data: any): Promise<void> => {
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
                        record.tmuxSession,
                        this.settings.pendingMarker,
                    );
                    editor.setLine(line, taskLine);
                } catch (e: any) {
                    new Notice(e.message);
                }
            },
        });

        // attach (peek/resume — same command)
        this.addCommand({
            id: "attach",
            name: "Attach to task",
            editorCallback: async (editor: any) => {
                const cursor = editor.getCursor();
                const lineText = editor.getLine(cursor.line);
                const parsed = parseTaskLine(lineText);
                if (!parsed) {
                    new Notice("Current line is not a task.");
                    return;
                }

                this.taskManager!.attach(parsed.sessionId);
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
                const task = this.taskManager!.findTaskBySession(parsed.sessionId);
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
}
