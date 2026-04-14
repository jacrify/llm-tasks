import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { TaskRecord, CostData } from './agents/types';
import { getAgent } from './agents/registry';
import { renderPrompt } from './prompt';
import { generateTaskId, buildLogNote, updateLogNoteOnComplete, updateTaskMarker } from './note-writer';
import { LlmTasksSettings } from './settings';

export interface TaskManagerDeps {
    readFile(path: string): Promise<string | null>;
    writeFile(path: string, content: string): Promise<void>;
    ensureFolder(path: string): Promise<void>;
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
    private processes: Map<string, ChildProcess> = new Map();
    private exitCodes: Map<string, number | null> = new Map();
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
        // Validate
        const trimmed = taskText.trim();
        if (!trimmed) {
            throw new Error('Cannot dispatch an empty task');
        }
        if (trimmed.startsWith('#')) {
            throw new Error('Cannot dispatch a heading line');
        }
        // Check if it's already a task line
        if (trimmed.startsWith(`- ${this.settings.pendingMarker} `) ||
            trimmed.startsWith(`- ${this.settings.doneMarker} `) ||
            trimmed.startsWith(`- ${this.settings.failedMarker} `)) {
            throw new Error('Line is already a task');
        }
        // Check frontmatter (line between --- delimiters)
        if (this.isInFrontmatter(taskText, noteContent, sourceLine)) {
            throw new Error('Cannot dispatch frontmatter');
        }
        // Check max concurrent
        if (this.settings.maxConcurrent > 0 && this.activeTasks.size >= this.settings.maxConcurrent) {
            throw new Error(`Max concurrent tasks reached (${this.settings.maxConcurrent}). Cancel or wait for a task to finish.`);
        }

        const now = new Date();
        const id = generateTaskId(trimmed, now);
        const started = now.toISOString();

        // Build paths
        const tmpBase = path.join(os.tmpdir(), 'llm-tasks');
        const logFile = path.join(tmpBase, `${id}.log`);
        const sessionFile = path.join(tmpBase, 'sessions', id);

        // Ensure tmp directories exist
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

        // Render prompt
        const sourceNoteName = sourceFile.replace(/\.md$/, '').split('/').pop() || sourceFile;
        const promptTemplate = await this.deps.readFile(this.settings.promptFile);
        const renderedPrompt = renderPrompt(promptTemplate, {
            task: trimmed,
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

        // Build command
        const command = this.settings.agentCommand || agent.defaultCommand;
        const extraArgs = this.settings.extraArgs
            ? this.settings.extraArgs.split(/\s+/).filter(Boolean)
            : [];
        const args = agent.buildArgs({
            renderedPrompt,
            sessionFile,
            extraArgs,
        });

        // Build log note path
        const logNotePath = `${this.settings.logFolder}/${id}`;
        const logNoteVaultPath = `${logNotePath}.md`;

        // Build resume command
        const resumeCmd = agent.resumeCommand(sessionFile);

        // Create log note in vault
        await this.deps.ensureFolder(this.settings.logFolder);
        const logNoteContent = buildLogNote({
            taskText: trimmed,
            sourceNoteName,
            agentId: agent.id,
            started,
            pid: 0, // will update after spawn
            resumeCommand: resumeCmd,
        });

        // Spawn process
        const logFd = fs.openSync(logFile, 'w');
        let child: ChildProcess;
        try {
            // Obsidian GUI apps on macOS don't inherit the user's shell environment.
            // Explicitly source shell profile files so the agent gets PATH, API keys, etc.
            const shell = '/bin/zsh';
            const escapedArgs = args.map(a => this.shellEscape(a));
            const fullCmd = `${this.shellEscape(command)} ${escapedArgs.join(' ')}`;
            const home = os.homedir();
            const sourceProfiles = [
                `[ -f /etc/zprofile ] && . /etc/zprofile`,
                `[ -f '${home}/.zprofile' ] && . '${home}/.zprofile'`,
                `[ -f '${home}/.zshrc' ] && . '${home}/.zshrc'`,
            ].join('; ');
            const wrappedCmd = `${sourceProfiles}; ${fullCmd}`;

            child = spawn(shell, ['-c', wrappedCmd], {
                cwd: workingDirectory,
                stdio: ['ignore', logFd, logFd],
                detached: false,
            });
        } catch (err: any) {
            fs.closeSync(logFd);
            throw new Error(`Failed to spawn agent: ${err.message}`);
        }

        // Handle spawn errors (e.g., ENOENT for bad cwd or command)
        const pid = child.pid;
        if (pid == null) {
            // Wait for error event to fire, then throw
            return new Promise<TaskRecord>((_, reject) => {
                child.on('error', (err) => {
                    try { fs.closeSync(logFd); } catch { /* already closed */ }
                    const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
                        ? `Agent binary not found: "${command}". Check that it is installed and the path is correct.`
                        : `Failed to spawn agent: ${err.message}`;
                    reject(new Error(msg));
                });
                // Safety timeout in case error event never fires
                setTimeout(() => {
                    try { fs.closeSync(logFd); } catch { /* already closed */ }
                    reject(new Error(`Failed to spawn agent: process started but no PID assigned`));
                }, 5000);
            });
        }

        // Update log note with actual PID
        const logNoteWithPid = logNoteContent.replace(/^pid: 0$/m, `pid: ${pid}`);
        await this.deps.writeFile(logNoteVaultPath, logNoteWithPid);

        // Create task record
        const record: TaskRecord = {
            id,
            pid,
            sourceFile,
            sourceLine,
            taskText: trimmed,
            logNote: logNotePath,
            logFile,
            sessionFile,
            agentId: agent.id,
            started,
        };

        this.activeTasks.set(id, record);
        this.processes.set(id, child);

        // Track fd close state
        let logFdClosed = false;

        // Listen for exit to capture exit code
        child.on('exit', (code) => {
            this.exitCodes.set(id, code);
            if (!logFdClosed) {
                logFdClosed = true;
                fs.closeSync(logFd);
            }
        });

        child.on('error', (err) => {
            if (!logFdClosed) {
                logFdClosed = true;
                fs.closeSync(logFd);
            }
            // If spawn error occurs after pid was assigned, set a failure exit code
            if (!this.exitCodes.has(id)) {
                this.exitCodes.set(id, 1);
            }
        });

        // Persist
        await this.persistTasks();
        this.deps.onTaskCountChanged(this.activeTasks.size);

        return record;
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
        const deadTasks: string[] = [];

        for (const [id, record] of this.activeTasks) {
            if (!this.isProcessAlive(record.pid)) {
                deadTasks.push(id);
            }
        }

        for (const id of deadTasks) {
            await this.handleTaskCompletion(id);
        }
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private async handleTaskCompletion(taskId: string): Promise<void> {
        const record = this.activeTasks.get(taskId);
        if (!record) return;

        const agent = getAgent(record.agentId);
        const exitCode = this.exitCodes.get(taskId) ?? null;
        const success = agent ? agent.isSuccess(exitCode ?? 1) : exitCode === 0;

        // Extract cost
        let cost: CostData | null = null;
        if (agent) {
            try {
                cost = await agent.extractCost(record.sessionFile);
            } catch {
                // ignore cost extraction errors
            }
        }

        // Read output from log file
        let output = '';
        try {
            if (fs.existsSync(record.logFile)) {
                output = fs.readFileSync(record.logFile, 'utf-8');
            }
        } catch {
            output = '(could not read output)';
        }

        // Trim output to last 200 lines for the log note
        const outputLines = output.split('\n');
        const trimmedOutput = outputLines.length > 200
            ? '...\n' + outputLines.slice(-200).join('\n')
            : output;

        const finished = new Date().toISOString();

        // Update log note
        const logNoteVaultPath = `${record.logNote}.md`;
        const logContent = await this.deps.readFile(logNoteVaultPath);
        if (logContent) {
            const updated = updateLogNoteOnComplete(logContent, {
                success,
                output: trimmedOutput,
                doneMarker: this.settings.doneMarker,
                failedMarker: this.settings.failedMarker,
                cost,
                finished,
            });
            await this.deps.writeFile(logNoteVaultPath, updated);
        }

        // Update source note line
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            const newMarker = success ? this.settings.doneMarker : this.settings.failedMarker;
            // Find the task line (may have shifted, search by logNote path)
            let found = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(record.logNote) || (i === record.sourceLine && lines[i].includes(`- ${this.settings.pendingMarker} `))) {
                    lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, newMarker);
                    found = true;
                    break;
                }
            }
            if (found) {
                await this.deps.writeFile(record.sourceFile, lines.join('\n'));
            }
        }

        // Store cost in record
        if (cost) record.cost = cost;

        // Notify
        if (this.settings.notifyOnCompletion) {
            const statusText = success ? 'completed' : 'failed';
            const preview = record.taskText.slice(0, 50);
            this.deps.notify(`Task ${statusText}: ${preview}`);
        }

        // Remove from active
        this.activeTasks.delete(taskId);
        this.processes.delete(taskId);
        this.exitCodes.delete(taskId);

        await this.persistTasks();
        this.deps.onTaskCountChanged(this.activeTasks.size);
    }

    async cancel(taskId: string): Promise<void> {
        const record = this.activeTasks.get(taskId);
        if (!record) {
            throw new Error(`No active task with ID "${taskId}"`);
        }

        // Kill the process
        try {
            process.kill(record.pid, 'SIGTERM');
        } catch {
            // Process may already be dead
        }

        // Update log note
        const logNoteVaultPath = `${record.logNote}.md`;
        const logContent = await this.deps.readFile(logNoteVaultPath);
        if (logContent) {
            const updated = updateLogNoteOnComplete(logContent, {
                success: false,
                output: '_Task cancelled._',
                doneMarker: this.settings.doneMarker,
                failedMarker: this.settings.failedMarker,
                cost: null,
                finished: new Date().toISOString(),
            });
            await this.deps.writeFile(logNoteVaultPath, updated);
        }

        // Update source note
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(record.logNote) || (i === record.sourceLine && lines[i].includes(`- ${this.settings.pendingMarker} `))) {
                    lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, this.settings.failedMarker);
                    break;
                }
            }
            await this.deps.writeFile(record.sourceFile, lines.join('\n'));
        }

        // Remove from active
        this.activeTasks.delete(taskId);
        this.processes.delete(taskId);
        this.exitCodes.delete(taskId);

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
        // Kill all active processes
        for (const [id, child] of this.processes) {
            try {
                process.kill(child.pid!, 'SIGTERM');
            } catch {
                // already dead
            }
        }
        this.activeTasks.clear();
        this.processes.clear();
        this.exitCodes.clear();
        await this.persistTasks();
    }

    async detectStaleTasks(): Promise<void> {
        const data: PersistedData = await this.deps.loadData() || {};
        const tasks = data.activeTasks || [];
        const stillActive: TaskRecord[] = [];
        let changed = false;

        for (const record of tasks) {
            if (this.isProcessAlive(record.pid)) {
                // Process is still running — add to active tasks
                // Note: we don't have the ChildProcess reference, so we can't manage it
                // but we track it for count purposes
                this.activeTasks.set(record.id, record);
                stillActive.push(record);
            } else {
                // Process is dead — mark as failed
                changed = true;
                const logNoteVaultPath = `${record.logNote}.md`;
                const logContent = await this.deps.readFile(logNoteVaultPath);
                if (logContent) {
                    const updated = updateLogNoteOnComplete(logContent, {
                        success: false,
                        output: '_Task died unexpectedly (stale PID detected on startup)._',
                        doneMarker: this.settings.doneMarker,
                        failedMarker: this.settings.failedMarker,
                        cost: null,
                        finished: new Date().toISOString(),
                    });
                    await this.deps.writeFile(logNoteVaultPath, updated);
                }

                // Update source note
                const sourceContent = await this.deps.readFile(record.sourceFile);
                if (sourceContent) {
                    const lines = sourceContent.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(record.logNote) || (i === record.sourceLine && lines[i].includes(`- ${this.settings.pendingMarker} `))) {
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

    private shellEscape(arg: string): string {
        // Wrap in single quotes, escaping any internal single quotes
        return "'" + arg.replace(/'/g, "'\\''" ) + "'";
    }

    private isInFrontmatter(taskText: string, noteContent: string, sourceLine: number): boolean {
        const lines = noteContent.split('\n');
        if (lines.length === 0 || lines[0] !== '---') return false;
        // Find the closing ---
        for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') {
                // sourceLine is 0-based
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
