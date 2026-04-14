import * as os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { TaskRecord } from './agents/types';
import { getAgent } from './agents/registry';
import { renderPrompt } from './prompt';
import { generateTaskId, updateTaskMarker } from './note-writer';
import { LlmTasksSettings } from './settings';

export interface TaskManagerDeps {
    readFile(path: string): Promise<string | null>;
    writeFile(path: string, content: string): Promise<void>;
    getVaultPath(): string;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
    notify(message: string): void;
    onTaskCountChanged(count: number): void;
}

interface PersistedData {
    activeTasks?: TaskRecord[];
}

export class TaskManager {
    private deps: TaskManagerDeps;
    private settings: LlmTasksSettings;
    private activeTasks: Map<string, TaskRecord> = new Map();
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(deps: TaskManagerDeps, settings: LlmTasksSettings) {
        this.deps = deps;
        this.settings = settings;
    }

    updateSettings(settings: LlmTasksSettings): void {
        this.settings = settings;
    }

    async dispatch(
        taskText: string,
        sourceFile: string,
        sourceLine: number,
        noteContent: string
    ): Promise<TaskRecord> {
        const trimmed = taskText.trim();
        if (!trimmed) {
            throw new Error('Cannot dispatch an empty task');
        }
        if (trimmed.startsWith('#')) {
            throw new Error('Cannot dispatch a heading line');
        }
        if (trimmed.startsWith(`- ${this.settings.pendingMarker} `) ||
            trimmed.startsWith(`- ${this.settings.doneMarker} `) ||
            trimmed.startsWith(`- ${this.settings.failedMarker} `)) {
            throw new Error('Line is already a task');
        }
        if (this.isInFrontmatter(taskText, noteContent, sourceLine)) {
            throw new Error('Cannot dispatch frontmatter');
        }
        if (this.settings.maxConcurrent > 0 && this.activeTasks.size >= this.settings.maxConcurrent) {
            throw new Error(`Max concurrent tasks reached (${this.settings.maxConcurrent}). Cancel or wait for a task to finish.`);
        }

        // Strip leading list marker ("- ") if present
        const taskBody = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed;

        const now = new Date();
        const id = generateTaskId(taskBody, now);
        const started = now.toISOString();
        const tmuxSession = `llm-${id}`;

        // Render prompt
        const sourceNoteName = sourceFile.replace(/\.md$/, '').split('/').pop() || sourceFile;
        const promptTemplate = await this.deps.readFile(this.settings.promptFile);
        const renderedPrompt = renderPrompt(promptTemplate, {
            task: taskBody,
            sourceNoteName,
            noteContext: this.settings.includeNoteContext ? noteContent : '',
            vaultPath: this.deps.getVaultPath(),
            timestamp: started,
            agentId: this.settings.agentType,
            contextLimit: this.settings.contextLimit,
        });

        // Get agent adapter
        const agent = getAgent(this.settings.agentType);
        if (!agent) {
            throw new Error(`Agent "${this.settings.agentType}" not found`);
        }

        // Resolve working directory
        const workingDirectory = this.resolveWorkingDirectory();

        // Build agent command
        const command = this.settings.agentCommand || agent.defaultCommand;
        const extraArgs = this.settings.extraArgs
            ? this.settings.extraArgs.split(/\s+/).filter(Boolean)
            : [];
        const args = agent.buildArgs({ renderedPrompt, task: taskBody, extraArgs });

        // Build the full shell command to run inside tmux
        const escapedArgs = args.map(a => this.shellEscape(a));
        const agentCmd = `${this.shellEscape(command)} ${escapedArgs.join(' ')}`;

        // Source shell profiles so agent gets PATH, API keys, etc.
        const home = os.homedir();
        const sourceProfiles = [
            `[ -f /etc/zprofile ] && . /etc/zprofile`,
            `[ -f '${home}/.zprofile' ] && . '${home}/.zprofile'`,
            `[ -f '${home}/.zshrc' ] && . '${home}/.zshrc'`,
        ].join('; ');

        const tmux = this.settings.tmuxCommand || 'tmux';

        // Create tmux session with remain-on-exit so scrollback survives
        // Use -d to run detached, -x/-y for reasonable default size
        const tmuxCmd = [
            this.shellEscape(tmux),
            'new-session', '-d',
            '-s', this.shellEscape(tmuxSession),
            '-x', '200', '-y', '50',
            this.shellEscape(`${sourceProfiles}; cd ${this.shellEscape(workingDirectory)}; ${agentCmd}`),
        ].join(' ');

        // Set remain-on-exit before creating the session won't work;
        // we set it after creation
        const setupCmd = `${tmuxCmd} && ${this.shellEscape(tmux)} set-option -t ${this.shellEscape(tmuxSession)} remain-on-exit on`;

        try {
            this.execLogin(setupCmd, { timeout: 10000 });
        } catch (err: any) {
            const msg = err.stderr?.toString() || err.message;
            throw new Error(`Failed to create tmux session: ${msg}`);
        }

        // Create task record
        const record: TaskRecord = {
            id,
            tmuxSession,
            sourceFile,
            sourceLine,
            taskText: taskBody,
            agentId: agent.id,
            started,
        };

        this.activeTasks.set(id, record);

        // Persist
        await this.persistTasks();
        this.deps.onTaskCountChanged(this.activeTasks.size);

        return record;
    }

    /**
     * Attach to a tmux session — opens a terminal window.
     * Works whether the agent is running (live view) or finished (scrollback).
     */
    attach(tmuxSession: string): void {
        const tmux = this.settings.tmuxCommand || 'tmux';
        // Session names are generated by us (alphanumeric + dashes + underscores)
        // so no shell escaping needed. Escaping would break quoting in the
        // osascript template.
        const attachCmd = `${tmux} attach -t ${tmuxSession}`;
        const terminalTemplate = this.settings.openTerminalCommand || DEFAULT_OPEN_TERMINAL;
        const fullCmd = terminalTemplate.replace('{cmd}', attachCmd);

        spawn(this.settings.shellPath || '/bin/zsh', ['-c', fullCmd], {
            detached: true,
            stdio: 'ignore',
            env: this.buildEnv(),
        }).unref();
    }

    startPolling(): void {
        if (this.pollTimer) return;
        const intervalMs = (this.settings.pollInterval || 5) * 1000;
        this.pollTimer = setInterval(() => this.poll(), intervalMs);
    }

    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Start polling with a custom interval in ms (for testing) */
    startPollingMs(intervalMs: number): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this.poll(), intervalMs);
    }

    private async poll(): Promise<void> {
        const completedTasks: string[] = [];

        for (const [id, record] of this.activeTasks) {
            const status = this.getTmuxPaneStatus(record.tmuxSession);
            if (status !== null) {
                // Pane is dead — agent exited
                completedTasks.push(id);
            }
        }

        for (const id of completedTasks) {
            await this.handleTaskCompletion(id);
        }
    }

    /**
     * Check if a tmux session's pane has exited.
     * Returns the exit code if dead, or null if still running.
     */
    private getTmuxPaneStatus(tmuxSession: string): number | null {
        const tmux = this.settings.tmuxCommand || 'tmux';
        try {
            const output = this.execLogin(
                `${this.shellEscape(tmux)} list-panes -t ${this.shellEscape(tmuxSession)} -F '#{pane_dead} #{pane_dead_status}'`,
                { timeout: 5000 }
            ).trim();

            // Output is like "1 0" (dead, exit code 0) or "0 " (alive)
            const parts = output.split(' ');
            if (parts[0] === '1') {
                return parseInt(parts[1] || '1', 10);
            }
            return null;
        } catch {
            // Session doesn't exist — treat as dead with failure
            return 1;
        }
    }

    /**
     * Check if a tmux session exists at all.
     */
    private tmuxSessionExists(tmuxSession: string): boolean {
        const tmux = this.settings.tmuxCommand || 'tmux';
        try {
            this.execLogin(
                `${this.shellEscape(tmux)} has-session -t ${this.shellEscape(tmuxSession)}`,
                { timeout: 5000 }
            );
            return true;
        } catch {
            return false;
        }
    }

    private async handleTaskCompletion(taskId: string): Promise<void> {
        const record = this.activeTasks.get(taskId);
        if (!record) return;

        const agent = getAgent(record.agentId);
        const exitCode = this.getTmuxPaneStatus(record.tmuxSession);
        const success = agent ? agent.isSuccess(exitCode ?? 1) : exitCode === 0;

        // Update source note line
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            const newMarker = success ? this.settings.doneMarker : this.settings.failedMarker;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`<!-- llm:${record.tmuxSession} -->`)) {
                    lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, newMarker);
                    break;
                }
            }
            await this.deps.writeFile(record.sourceFile, lines.join('\n'));
        }

        // Notify
        if (this.settings.notifyOnCompletion) {
            const statusText = success ? 'completed' : 'failed';
            const preview = record.taskText.slice(0, 50);
            this.deps.notify(`Task ${statusText}: ${preview}`);
        }

        // Remove from active
        this.activeTasks.delete(taskId);
        await this.persistTasks();
        this.deps.onTaskCountChanged(this.activeTasks.size);
    }

    async cancel(taskId: string): Promise<void> {
        const record = this.activeTasks.get(taskId);
        if (!record) {
            throw new Error(`No active task with ID "${taskId}"`);
        }

        // Kill the tmux session
        const tmux = this.settings.tmuxCommand || 'tmux';
        try {
            this.execLogin(
                `${this.shellEscape(tmux)} kill-session -t ${this.shellEscape(record.tmuxSession)}`,
                { timeout: 5000 }
            );
        } catch {
            // Session may already be dead
        }

        // Update source note
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`<!-- llm:${record.tmuxSession} -->`)) {
                    lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, this.settings.failedMarker);
                    break;
                }
            }
            await this.deps.writeFile(record.sourceFile, lines.join('\n'));
        }

        // Remove from active
        this.activeTasks.delete(taskId);
        await this.persistTasks();
        this.deps.onTaskCountChanged(this.activeTasks.size);
    }

    async cancelAll(): Promise<void> {
        const ids = Array.from(this.activeTasks.keys());
        for (const id of ids) {
            await this.cancel(id);
        }
    }

    getActiveTasks(): TaskRecord[] {
        return Array.from(this.activeTasks.values());
    }

    getActiveTaskCount(): number {
        return this.activeTasks.size;
    }

    async cleanup(): Promise<void> {
        this.stopPolling();
        const tmux = this.settings.tmuxCommand || 'tmux';
        for (const [_id, record] of this.activeTasks) {
            try {
                this.execLogin(
                    `${this.shellEscape(tmux)} kill-session -t ${this.shellEscape(record.tmuxSession)}`,
                    { timeout: 5000 }
                );
            } catch {
                // already dead
            }
        }
        this.activeTasks.clear();
        await this.persistTasks();
    }

    async detectStaleTasks(): Promise<void> {
        const data: PersistedData = await this.deps.loadData() || {};
        const tasks = data.activeTasks || [];
        let changed = false;

        for (const record of tasks) {
            if (this.tmuxSessionExists(record.tmuxSession)) {
                // Session still exists — keep tracking it
                this.activeTasks.set(record.id, record);
            } else {
                // Session gone — mark as failed
                changed = true;

                const sourceContent = await this.deps.readFile(record.sourceFile);
                if (sourceContent) {
                    const lines = sourceContent.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(`<!-- llm:${record.tmuxSession} -->`)) {
                            lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, this.settings.failedMarker);
                            break;
                        }
                    }
                    await this.deps.writeFile(record.sourceFile, lines.join('\n'));
                }

                this.deps.notify(`Stale task detected: ${record.taskText.slice(0, 50)}`);
            }
        }

        if (changed) {
            await this.persistTasks();
        }
        this.deps.onTaskCountChanged(this.activeTasks.size);
    }

    findTaskBySession(tmuxSession: string): TaskRecord | undefined {
        for (const record of this.activeTasks.values()) {
            if (record.tmuxSession === tmuxSession) return record;
        }
        return undefined;
    }

    private buildEnv(): Record<string, string> {
        const extraPath = this.settings.extraPath || '';
        const currentPath = process.env.PATH || '';
        return {
            ...process.env as Record<string, string>,
            HOME: os.homedir(),
            PATH: extraPath ? `${extraPath}:${currentPath}` : currentPath,
        };
    }

    /**
     * Run a command through the configured shell so PATH includes
     * user-configured extra paths (Homebrew, nix, etc.).
     */
    private execLogin(cmd: string, opts?: { timeout?: number }): string {
        const shell = this.settings.shellPath || '/bin/zsh';
        return execSync(cmd, {
            encoding: 'utf-8',
            shell,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: opts?.timeout ?? 10000,
            env: this.buildEnv(),
        });
    }

    private shellEscape(arg: string): string {
        return "'" + arg.replace(/'/g, "'\\''") + "'";
    }

    private isInFrontmatter(_taskText: string, noteContent: string, sourceLine: number): boolean {
        const lines = noteContent.split('\n');
        if (lines.length === 0 || lines[0] !== '---') return false;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') {
                return sourceLine <= i;
            }
        }
        return false;
    }

    private resolveWorkingDirectory(): string {
        switch (this.settings.workingDirectory) {
            case 'home':
                return os.homedir();
            case 'custom':
                return this.settings.customWorkingDirectory || this.deps.getVaultPath();
            case 'vault':
            default:
                return this.deps.getVaultPath();
        }
    }

    private async persistTasks(): Promise<void> {
        const data: PersistedData = {
            activeTasks: Array.from(this.activeTasks.values()),
        };
        await this.deps.saveData(data);
    }
}

const DEFAULT_OPEN_TERMINAL = `osascript -e 'tell application "Terminal"' -e 'do script "{cmd}"' -e 'activate' -e 'end tell'`;
