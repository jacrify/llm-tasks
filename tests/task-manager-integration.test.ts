import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';

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
    return { ...DEFAULT_SETTINGS, agentCommand: '/bin/sh -c', promptTemplate: '{{task}}', sessionTemplate: '', resumeTemplate: '', ...overrides };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killProcess(pid: number): void {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
}

describe('TaskManager Integration', () => {
    let createdPids: number[] = [];

    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-test-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        createdPids = [];
    });

    afterEach(() => {
        for (const pid of createdPids) {
            killProcess(pid);
        }
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch { /* best effort */ }
    });

    it('dispatch creates a child process running the command', async () => {
        const deps = createRealDeps();
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('echo hello && sleep 5', 'note.md', 0, 'content');
        createdPids.push(record.pid);

        expect(record.pid).toBeGreaterThan(0);
        expect(isProcessAlive(record.pid)).toBe(true);

        await manager.cleanup();
    });

    it('poll loop detects process completion', async () => {
        const deps = createRealDeps();
        const sourceContent = 'echo done';
        vaultFiles.set('note.md', sourceContent);
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo done', 'note.md', 0, sourceContent);
        createdPids.push(record.pid);
        expect(manager.getActiveTaskCount()).toBe(1);

        // Rewrite source with actual task ID
        const taskLine = `- ${settings.pendingMarker} echo done <!-- llm:${record.id} -->`;
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

    it('cancel kills the child process', async () => {
        const deps = createRealDeps();
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        createdPids.push(record.pid);
        expect(manager.getActiveTaskCount()).toBe(1);
        expect(isProcessAlive(record.pid)).toBe(true);

        await manager.cancel(record.id);
        expect(manager.getActiveTaskCount()).toBe(0);

        await sleep(500);
        expect(isProcessAlive(record.pid)).toBe(false);

        await manager.cleanup();
    });

    it('cancelAll kills multiple child processes', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ maxConcurrent: 5 });
        const manager = new TaskManager(deps, settings);

        const r1 = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        const r2 = await manager.dispatch('sleep 61', 'note.md', 1, 'content');
        const r3 = await manager.dispatch('sleep 62', 'note.md', 2, 'content');
        createdPids.push(r1.pid, r2.pid, r3.pid);

        expect(manager.getActiveTaskCount()).toBe(3);

        await manager.cancelAll();
        expect(manager.getActiveTaskCount()).toBe(0);

        await sleep(500);
        for (const r of [r1, r2, r3]) {
            expect(isProcessAlive(r.pid)).toBe(false);
        }

        await manager.cleanup();
    });

    it('failed command gets failed marker', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ notifyOnCompletion: true });
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('exit 1', 'note.md', 0, 'content');
        createdPids.push(record.pid);

        const taskLine = `- ${settings.pendingMarker} exit 1 <!-- llm:${record.id} -->`;
        vaultFiles.set('note.md', taskLine);

        manager.startPollingMs(200);
        await sleep(3000);

        expect(manager.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(settings.failedMarker);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('detectStaleTasks marks dead processes as failed', async () => {
        const deps = createRealDeps();
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const fakeId = `fake-stale-${Date.now()}`;
        const taskLine = `- ${settings.pendingMarker} fake task <!-- llm:${fakeId} -->`;
        vaultFiles.set('note.md', taskLine);

        savedData = {
            activeTasks: [{
                id: fakeId,
                pid: 999999999,  // non-existent PID
                logFile: '/tmp/llm-tasks/fake.log',
                sourceFile: 'note.md',
                sourceLine: 0,
                taskText: 'fake task',
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
