import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';

// Test agent adapter
const testAdapter: AgentAdapter = {
    id: 'test',
    name: 'Test',
    defaultCommand: '/bin/sh',
    buildArgs({ task }) {
        return ['-c', task];
    },
    isSuccess: (code) => code === 0,
};

// Register (idempotent since registry uses Map)
registerAgent(testAdapter);

let testDir: string;
let vaultDir: string;
let savedData: any = {};
let vaultFiles: Map<string, string>;

function createRealDeps(): TaskManagerDeps {
    return {
        async readFile(filePath: string): Promise<string | null> {
            return vaultFiles.get(filePath) ?? null;
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            vaultFiles.set(filePath, content);
        },
        getVaultPath(): string {
            return vaultDir;
        },
        async loadData(): Promise<any> {
            return savedData;
        },
        async saveData(data: any): Promise<void> {
            savedData = data;
        },
        notify: vi.fn(),
        onTaskCountChanged: vi.fn(),
    };
}

function createSettings(overrides?: Partial<LlmTasksSettings>): LlmTasksSettings {
    return { ...DEFAULT_SETTINGS, agentType: 'test', ...overrides };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tmuxSessionExists(session: string): boolean {
    try {
        execSync(`tmux has-session -t '${session}'`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function killTmuxSession(session: string): void {
    try {
        execSync(`tmux kill-session -t '${session}'`, { stdio: 'pipe' });
    } catch { /* already dead */ }
}

describe('TaskManager Integration', () => {
    let createdSessions: string[] = [];

    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-test-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        createdSessions = [];
    });

    afterEach(() => {
        // Clean up tmux sessions
        for (const s of createdSessions) {
            killTmuxSession(s);
        }
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch { /* best effort */ }
    });

    it('dispatch creates a tmux session running the command', async () => {
        const deps = createRealDeps();
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('echo hello && sleep 5', 'note.md', 0, 'content');
        createdSessions.push(record.tmuxSession);

        expect(record.tmuxSession).toMatch(/^llm-/);
        expect(tmuxSessionExists(record.tmuxSession)).toBe(true);

        await manager.cleanup();
    });

    it('poll loop detects tmux session completion', async () => {
        const deps = createRealDeps();
        const sourceContent = 'echo done <!-- llm:placeholder -->';
        vaultFiles.set('note.md', sourceContent);
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo done', 'note.md', 0, sourceContent);
        createdSessions.push(record.tmuxSession);
        expect(manager.getActiveTaskCount()).toBe(1);

        // Rewrite source with actual session ID
        const taskLine = `- ${settings.pendingMarker} echo done <!-- llm:${record.tmuxSession} -->`;
        vaultFiles.set('note.md', taskLine);

        manager.startPollingMs(200);
        await sleep(3000);

        expect(manager.getActiveTaskCount()).toBe(0);

        // Source note should be updated with done marker
        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(settings.doneMarker);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('cancel kills the tmux session', async () => {
        const deps = createRealDeps();
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        createdSessions.push(record.tmuxSession);
        expect(manager.getActiveTaskCount()).toBe(1);
        expect(tmuxSessionExists(record.tmuxSession)).toBe(true);

        await manager.cancel(record.id);
        expect(manager.getActiveTaskCount()).toBe(0);

        await sleep(500);
        expect(tmuxSessionExists(record.tmuxSession)).toBe(false);

        await manager.cleanup();
    });

    it('cancelAll kills multiple tmux sessions', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ maxConcurrent: 5 });
        const manager = new TaskManager(deps, settings);

        const r1 = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        const r2 = await manager.dispatch('sleep 61', 'note.md', 1, 'content');
        const r3 = await manager.dispatch('sleep 62', 'note.md', 2, 'content');
        createdSessions.push(r1.tmuxSession, r2.tmuxSession, r3.tmuxSession);

        expect(manager.getActiveTaskCount()).toBe(3);

        await manager.cancelAll();
        expect(manager.getActiveTaskCount()).toBe(0);

        await sleep(500);
        for (const r of [r1, r2, r3]) {
            expect(tmuxSessionExists(r.tmuxSession)).toBe(false);
        }

        await manager.cleanup();
    });

    it('failed command gets failed marker', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ notifyOnCompletion: true });
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('exit 1', 'note.md', 0, 'content');
        createdSessions.push(record.tmuxSession);

        const taskLine = `- ${settings.pendingMarker} exit 1 <!-- llm:${record.tmuxSession} -->`;
        vaultFiles.set('note.md', taskLine);

        manager.startPollingMs(200);
        await sleep(3000);

        expect(manager.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(settings.failedMarker);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('detectStaleTasks marks missing sessions as failed', async () => {
        const deps = createRealDeps();
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const taskLine = `- ${settings.pendingMarker} fake task <!-- llm:llm-nonexistent-session -->`;
        vaultFiles.set('note.md', taskLine);

        savedData = {
            activeTasks: [{
                id: 'fake-task',
                tmuxSession: 'llm-nonexistent-session',
                sourceFile: 'note.md',
                sourceLine: 0,
                taskText: 'fake task',
                agentId: 'test',
                started: '2026-04-14T10:00:00',
            }],
        };

        await manager.detectStaleTasks();

        expect(manager.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(settings.failedMarker);

        expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('Stale task'));

        await manager.cleanup();
    });
});
