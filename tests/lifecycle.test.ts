import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { formatTaskLine, updateTaskMarker, parseTaskLine } from '../src/note-writer';

let testDir: string;
let vaultDir: string;
let savedData: any = {};
let vaultFiles: Map<string, string>;
let notifications: string[] = [];
let taskCountChanges: number[] = [];

function createDeps(): TaskManagerDeps {
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
        notify(message: string): void {
            notifications.push(message);
        },
        onTaskCountChanged(count: number): void {
            taskCountChanges.push(count);
        },
    };
}

function createSettings(overrides?: Partial<LlmTasksSettings>): LlmTasksSettings {
    return { ...DEFAULT_SETTINGS, agentCommand: '/bin/sh -c', promptTemplate: '{{task}}', sessionTemplate: '', resumeTemplate: '', ...overrides };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function killProcess(pid: number): void {
    try {
        process.kill(pid, 'SIGTERM');
    } catch { /* already dead */ }
}

describe('Full Lifecycle Integration', () => {
    let createdPids: number[] = [];

    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-lifecycle-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        notifications = [];
        taskCountChanges = [];
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

    it('full end-to-end: dispatch "echo done", poll, verify completion', async () => {
        const deps = createDeps();
        const settings = createSettings({ notifyOnCompletion: true });

        const sourceContent = 'Some context\necho done\nMore content';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        // 1. Dispatch
        const record = await manager.dispatch('echo done', 'note.md', 1, sourceContent);
        createdPids.push(record.pid);
        expect(record.taskText).toBe('echo done');
        expect(manager.getActiveTaskCount()).toBe(1);

        // Simulate what main.ts does: rewrite source line
        const taskLine = formatTaskLine(
            record.taskText,
            record.id,
            settings.pendingMarker,
        );
        const updatedSource = sourceContent.split('\n');
        updatedSource[1] = taskLine;
        vaultFiles.set('note.md', updatedSource.join('\n'));

        // 2. Start polling with short interval
        manager.startPollingMs(200);

        // 3. Wait for echo to finish and poll to detect it
        await sleep(3000);

        // 4. Verify: task is no longer active
        expect(manager.getActiveTaskCount()).toBe(0);

        // 5. Verify: source note line was updated with done marker
        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toBeDefined();
        expect(finalSource).toContain(`- ${settings.doneMarker} `);
        expect(finalSource).not.toContain(`- ${settings.pendingMarker} `);

        // 6. Verify: completion notification was called
        expect(notifications.some(n => n.includes('completed'))).toBe(true);

        // 7. Verify: task count changed (should have gone 1 → 0)
        expect(taskCountChanges).toContain(1);
        expect(taskCountChanges[taskCountChanges.length - 1]).toBe(0);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('dispatch with non-existent binary fails via poll', async () => {
        const deps = createDeps();
        const settings = createSettings({
            agentCommand: '/nonexistent/binary',
            notifyOnCompletion: true,
        });
        const sourceContent = 'do something';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('do something', 'note.md', 0, sourceContent);
        createdPids.push(record.pid);

        // Rewrite source line
        const taskLine = formatTaskLine(record.taskText, record.id, settings.pendingMarker);
        vaultFiles.set('note.md', taskLine);

        // Poll to detect failure
        manager.startPollingMs(200);
        await sleep(3000);

        // Task should be gone and marked as failed
        expect(manager.getActiveTaskCount()).toBe(0);
        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(settings.failedMarker);
        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('failed task gets ❌ marker after non-zero exit with no output', async () => {
        const deps = createDeps();
        const settings = createSettings({ notifyOnCompletion: true });

        // Use a command that produces no output and exits with error
        const sourceContent = 'exit 1';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('exit 1', 'note.md', 0, sourceContent);
        createdPids.push(record.pid);

        const taskLine = formatTaskLine(
            record.taskText,
            record.id,
            settings.pendingMarker,
        );
        vaultFiles.set('note.md', taskLine);

        manager.startPollingMs(200);
        await sleep(3000);

        expect(manager.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(`- ${settings.failedMarker} `);

        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        manager.stopPolling();
        await manager.cleanup();
    });
});
