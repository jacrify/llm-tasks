import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { TaskRecord } from './agents/types';
import { renderPrompt } from './prompt';
import { generateTaskId, updateTaskMarker, updateTaskSession, findResumeSession, findParentTaskLine, isIndentedLine, parseTaskLine } from './note-writer';
import { LlmTasksSettings } from './settings';

export interface TaskManagerDeps {
    readFile(path: string): Promise<string | null>;
    writeFile(path: string, content: string): Promise<void>;
    getVaultPath(): string;
    loadData(): Promise<Record<string, unknown>>;
    saveData(data: Record<string, unknown>): Promise<void>;
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
    private exitCodes: Map<string, number> = new Map();
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

        // Detect continuation context
        const lines = noteContent.split('\n');
        const isIndented = isIndentedLine(taskText);
        let resumeSessionId: string | null = null;
        let parentLine: number | null = null;

        if (isIndented) {
            parentLine = findParentTaskLine(lines, sourceLine);

            if (parentLine !== null) {
                // Check if parent is still running
                const parentParsed = parseTaskLine(lines[parentLine]);
                if (parentParsed && parentParsed.marker === this.settings.pendingMarker) {
                    // Check if parent is actually an active task
                    const parentTask = this.findTaskById(parentParsed.sessionId);
                    if (parentTask) {
                        throw new Error('Parent task is still running.');
                    }
                }

                // Find session to resume from
                resumeSessionId = findResumeSession(lines, sourceLine);
            }
            // If no parent task line, treat as standalone (parentLine stays null, no resume)
        }

        // Strip leading whitespace and list marker ("- ") if present
        const taskBody = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed;

        const now = new Date();
        const id = generateTaskId(taskBody, now);
        const started = now.toISOString();

        // Render prompt
        const sourceNoteName = sourceFile.replace(/\.md$/, '').split('/').pop() || sourceFile;
        const promptTemplate = this.settings.promptTemplate || null;
        const renderedPrompt = renderPrompt(promptTemplate, {
            task: taskBody,
            sourceNoteName,
            noteContext: this.settings.includeNoteContext ? noteContent : '',
            vaultPath: this.deps.getVaultPath(),
            timestamp: started,
            contextLimit: this.settings.contextLimit,
        });

        // Generate session UUID for this task
        const agentSessionId = crypto.randomUUID();

        // Build agent command
        const baseCmd = this.settings.agentCommand || 'claude -p';
        const cmdParts = baseCmd.split(/\s+/).filter(Boolean);

        // Append session/resume args
        if (resumeSessionId && this.settings.resumeTemplate) {
            // Resuming an existing session — use resume template only
            const resumeArgs = this.settings.resumeTemplate.replace(/\{sessionId\}/g, resumeSessionId);
            cmdParts.push(...resumeArgs.split(/\s+/).filter(Boolean));
            // The agentSessionId for this continuation is the one we're resuming
            // (we still generate a new UUID for the task record, but the agent session is the same)
        } else if (resumeSessionId && this.isPiCommand()) {
            // Pi resume with no explicit resume template — find session file in pi's default dir
            const sessionFile = this.findPiSessionFile(resumeSessionId);
            if (sessionFile) {
                cmdParts.push('--session', sessionFile);
            }
        } else if (this.settings.sessionTemplate) {
            // Fresh session — use explicit session template
            const sessionArgs = this.settings.sessionTemplate.replace(/\{sessionId\}/g, agentSessionId);
            cmdParts.push(...sessionArgs.split(/\s+/).filter(Boolean));
        } else if (this.isPiCommand()) {
            // Pi preset with no explicit session template — use pi's default session dir
            const sessionPath = this.buildPiSessionPath(agentSessionId, now);
            cmdParts.push('--session', sessionPath);
        }

        const agentCmd = cmdParts.map(a => this.shellEscape(a)).join(' ') + ' ' + this.shellEscape(renderedPrompt);

        // Set up log file
        const logDir = path.join(os.tmpdir(), 'llm-tasks');
        fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, `${id}.log`);
        const logFd = fs.openSync(logFile, 'w');

        const shellPath = this.settings.shellPath || process.env.SHELL || '/bin/sh';

        try {
            const child = spawn(shellPath, ['-l', '-i', '-c', agentCmd], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
                env: this.buildEnv(),
                cwd: this.deps.getVaultPath(),
            });

            const pid = child.pid;
            if (!pid) {
                fs.closeSync(logFd);
                throw new Error('Failed to spawn child process: no PID returned');
            }

            child.on('exit', (code) => {
                this.exitCodes.set(id, code ?? 1);
            });
            child.unref();
            fs.closeSync(logFd);

            // Create task record
            const record: TaskRecord = {
                id,
                pid,
                logFile,
                sourceFile,
                sourceLine,
                taskText: taskBody,
                started,
                agentSessionId,
                parentTaskLine: parentLine ?? undefined,
                resumedFromSession: resumeSessionId ?? undefined,
            };

            this.activeTasks.set(id, record);

            // Persist
            await this.persistTasks();
            this.deps.onTaskCountChanged(this.activeTasks.size);

            return record;
        } catch (err: unknown) {
            try { fs.closeSync(logFd); } catch { /* already closed */ }
            throw new Error(`Failed to spawn agent process: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    startPolling(): void {
        if (this.pollTimer) return;
        const intervalMs = (this.settings.pollInterval || 5) * 1000;
        this.pollTimer = setInterval(() => { void this.poll(); }, intervalMs);
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
        this.pollTimer = setInterval(() => { void this.poll(); }, intervalMs);
    }

    private async poll(): Promise<void> {
        const completedTasks: string[] = [];

        for (const [id, record] of this.activeTasks) {
            if (!this.isProcessAlive(record.pid)) {
                completedTasks.push(id);
            }
        }

        for (const id of completedTasks) {
            await this.handleTaskCompletion(id);
        }
    }

    /**
     * Check if a process is still alive by sending signal 0.
     */
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

        // Check exit code if we captured it (same process lifetime)
        const exitCode = this.exitCodes.get(taskId);
        let success: boolean;
        if (exitCode !== undefined) {
            success = exitCode === 0;
            this.exitCodes.delete(taskId);
        } else {
            // Process was from a previous Obsidian session (restored from persisted data).
            // We can't know exit code, so check log file heuristic.
            try {
                const logContent = fs.readFileSync(record.logFile, 'utf-8');
                success = logContent.trim().length > 0;
            } catch {
                success = false;
            }
        }

        // Session ID is already set at dispatch time (pre-generated UUID)
        const agentSessionId = record.agentSessionId;

        // Update source note
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            const newMarker = success ? this.settings.doneMarker : this.settings.failedMarker;

            // Find the task's line and update session tag
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`<!-- llm:${record.id} -->`)) {
                    // Update session tag on the task line
                    if (agentSessionId) {
                        lines[i] = updateTaskSession(lines[i], agentSessionId);
                    }
                    break;
                }
                // Also match lines that already have a session tag
                if (lines[i].includes(`<!-- llm:${record.id} session:`)) {
                    if (agentSessionId) {
                        lines[i] = updateTaskSession(lines[i], agentSessionId);
                    }
                    break;
                }
            }

            if (record.parentTaskLine !== undefined) {
                // This is a continuation — update the parent's marker
                const parentLine = record.parentTaskLine;
                if (parentLine >= 0 && parentLine < lines.length) {
                    const parentParsed = parseTaskLine(lines[parentLine]);
                    if (parentParsed) {
                        lines[parentLine] = updateTaskMarker(lines[parentLine], this.settings.pendingMarker, newMarker);
                    }
                }
            } else {
                // Normal task — update its own marker
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(`<!-- llm:${record.id}`)) {
                        lines[i] = updateTaskMarker(lines[i], this.settings.pendingMarker, newMarker);
                        break;
                    }
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

        // Kill the process
        try {
            process.kill(record.pid, 'SIGTERM');
        } catch {
            // Process may already be dead
        }

        // Update source note
        const sourceContent = await this.deps.readFile(record.sourceFile);
        if (sourceContent) {
            const lines = sourceContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`<!-- llm:${record.id} -->`)) {
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
        for (const [, record] of this.activeTasks) {
            try {
                process.kill(record.pid, 'SIGTERM');
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
            if (this.isProcessAlive(record.pid)) {
                // Process still running — keep tracking it
                this.activeTasks.set(record.id, record);
            } else {
                // Process gone — mark as failed
                changed = true;

                const sourceContent = await this.deps.readFile(record.sourceFile);
                if (sourceContent) {
                    const lines = sourceContent.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(`<!-- llm:${record.id} -->`)) {
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

    findTaskById(id: string): TaskRecord | undefined {
        return this.activeTasks.get(id);
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
     * Find a pi session file by UUID in pi's default session directory.
     * Searches the cwd-specific session dir for a file containing the UUID.
     */
    private findPiSessionFile(uuid: string): string | null {
        const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
        const cwd = this.deps.getVaultPath();
        const encodedCwd = '--' + cwd.replace(/\//g, '-').replace(/^-/, '') + '--';
        const sessionDir = path.join(piDir, 'sessions', encodedCwd);
        try {
            const files = fs.readdirSync(sessionDir);
            const match = files.find(f => f.includes(uuid) && f.endsWith('.jsonl'));
            if (match) {
                return path.join(sessionDir, match);
            }
        } catch { /* dir doesn't exist */ }
        return null;
    }

    private isPiCommand(): boolean {
        const cmd = (this.settings.agentCommand || '').trim();
        return cmd === 'pi -p' || cmd.startsWith('pi -p ') || cmd.startsWith('pi --print');
    }

    /**
     * Build a session file path in pi's native format:
     * ~/.pi/agent/sessions/{encoded-cwd}/{timestamp}_{uuid}.jsonl
     */
    private buildPiSessionPath(uuid: string, now: Date): string {
        const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
        const cwd = this.deps.getVaultPath();
        const encodedCwd = '--' + cwd.replace(/\//g, '-').replace(/^-/, '') + '--';
        const ts = now.toISOString()
            .replace(/:/g, '-')
            .replace(/\./g, '-');
        const sessionDir = path.join(piDir, 'sessions', encodedCwd);
        fs.mkdirSync(sessionDir, { recursive: true });
        return path.join(sessionDir, `${ts}_${uuid}.jsonl`);
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

    private async persistTasks(): Promise<void> {
        const data: PersistedData = {
            activeTasks: Array.from(this.activeTasks.values()),
        };
        await this.deps.saveData(data as unknown as Record<string, unknown>);
    }
}
