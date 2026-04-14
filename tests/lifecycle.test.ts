import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';
import { formatTaskLine, updateTaskMarker, parseTaskLine } from '../src/note-writer';

// Test agent adapter that runs shell commands
const testAdapter: AgentAdapter = {
    id: 'test-lifecycle',
    name: 'Test Lifecycle',
    defaultCommand: '/bin/sh',
    buildArgs({ task }) {
        return ['-c', task];
    },
    isSuccess: (code) => code === 0,
};

// Non-existent binary adapter
const badBinaryAdapter: AgentAdapter = {
    id: 'test-bad-binary',
    name: 'Bad Binary',
    defaultCommand: '/nonexistent/binary/that/does/not/exist',
    buildArgs({ task }) {
        return [task];
    },
    isSuccess: (code) => code === 0,
};

registerAgent(testAdapter);
registerAgent(badBinaryAdapter);

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
    return { ...DEFAULT_SETTINGS, agentType: 'test-lifecycle', ...overrides };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function killTmuxSession(session: string): void {
    try {
        execSync(`tmux kill-session -t '${session}'`, { stdio: 'pipe' });
    } catch { /* already dead */ }
}

describe('Full Lifecycle Integration', () => {
    let createdSessions: string[] = [];

    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-lifecycle-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        notifications = [];
        taskCountChanges = [];
        createdSessions = [];
    });

    afterEach(() => {
        for (const s of createdSessions) {
            killTmuxSession(s);
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
        createdSessions.push(record.tmuxSession);
        expect(record.taskText).toBe('echo done');
        expect(record.agentId).toBe('test-lifecycle');
        expect(manager.getActiveTaskCount()).toBe(1);

        // Simulate what main.ts does: rewrite source line
        const taskLine = formatTaskLine(
            record.taskText,
            record.tmuxSession,
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

    it('dispatch with non-existent binary fails via poll (command fails inside tmux)', async () => {
        const deps = createDeps();
        const settings = createSettings({ agentType: 'test-bad-binary', notifyOnCompletion: true });
        const sourceContent = 'do something';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('do something', 'note.md', 0, sourceContent);
        createdSessions.push(record.tmuxSession);

        // Rewrite source line
        const taskLine = formatTaskLine(record.taskText, record.tmuxSession, settings.pendingMarker);
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

    it('failed task gets ❌ marker after non-zero exit', async () => {
        const deps = createDeps();
        const settings = createSettings({ notifyOnCompletion: true });

        const sourceContent = 'exit 1';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('exit 1', 'note.md', 0, sourceContent);
        createdSessions.push(record.tmuxSession);

        const taskLine = formatTaskLine(
            record.taskText,
            record.tmuxSession,
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

    it('attach does not throw for a valid session', async () => {
        const deps = createDeps();
        // Override terminal command to a no-op so we don't actually open Terminal.app
        const settings = createSettings({ openTerminalCommand: 'echo {cmd}' });
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('sleep 10', 'note.md', 0, 'content');
        createdSessions.push(record.tmuxSession);

        // Should not throw
        expect(() => manager.attach(record.tmuxSession)).not.toThrow();

        await manager.cleanup();
    });
});
