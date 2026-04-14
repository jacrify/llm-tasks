import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
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
    buildArgs({ renderedPrompt }) {
        return ['-c', renderedPrompt];
    },
    isSuccess: (code) => code === 0,
    extractCost: async () => null,
    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },
    resumeCommand: () => 'echo resume',
};

// Non-existent binary adapter
const badBinaryAdapter: AgentAdapter = {
    id: 'test-bad-binary',
    name: 'Bad Binary',
    defaultCommand: '/nonexistent/binary/that/does/not/exist',
    buildArgs({ renderedPrompt }) {
        return [renderedPrompt];
    },
    isSuccess: (code) => code === 0,
    extractCost: async () => null,
    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },
    resumeCommand: () => 'echo resume',
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
        async ensureFolder(_path: string): Promise<void> {},
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

describe('Full Lifecycle Integration', () => {
    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-lifecycle-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        notifications = [];
        taskCountChanges = [];
    });

    afterEach(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch { /* best effort */ }
    });

    it('full end-to-end: dispatch "echo done", poll, verify completion', async () => {
        const deps = createDeps();
        const settings = createSettings({ notifyOnCompletion: true });

        // Set up source note in vault
        const sourceContent = 'Some context\necho done\nMore content';
        vaultFiles.set('note.md', sourceContent);
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');

        const manager = new TaskManager(deps, settings);

        // 1. Dispatch
        const record = await manager.dispatch('echo done', 'note.md', 1, sourceContent);
        expect(record.pid).toBeGreaterThan(0);
        expect(record.taskText).toBe('echo done');
        expect(record.agentId).toBe('test-lifecycle');
        expect(manager.getActiveTaskCount()).toBe(1);

        // Simulate what main.ts does: rewrite source line
        const taskLine = formatTaskLine(
            record.taskText,
            record.logNote,
            settings.pendingMarker,
            settings.useWikilinks
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

        // 5. Verify: log file contains "done"
        const logContent = fs.readFileSync(record.logFile, 'utf-8');
        expect(logContent).toContain('done');

        // 6. Verify: log note was updated with success status and output
        const logNoteContent = vaultFiles.get(`${record.logNote}.md`);
        expect(logNoteContent).toBeDefined();
        expect(logNoteContent).toContain('status: done');
        expect(logNoteContent).toContain('done');
        expect(logNoteContent).not.toContain('_Waiting for completion..._');

        // 7. Verify: source note line was updated with done marker
        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toBeDefined();
        expect(finalSource).toContain(`- ${settings.doneMarker} `);
        expect(finalSource).not.toContain(`- ${settings.pendingMarker} `);

        // 8. Verify: completion notification was called
        expect(notifications.some(n => n.includes('completed'))).toBe(true);

        // 9. Verify: task count changed (should have gone 1 → 0)
        expect(taskCountChanges).toContain(1);
        expect(taskCountChanges[taskCountChanges.length - 1]).toBe(0);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('dispatch with non-existent binary fails gracefully via poll', async () => {
        const deps = createDeps();
        const settings = createSettings({ agentType: 'test-bad-binary', notifyOnCompletion: true });
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const sourceContent = 'do something';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        // Dispatch succeeds (the login shell spawns), but the command inside will fail
        const record = await manager.dispatch('do something', 'note.md', 0, sourceContent);
        expect(record.pid).toBeGreaterThan(0);

        // Rewrite source line
        const taskLine = formatTaskLine(record.taskText, record.logNote, settings.pendingMarker, settings.useWikilinks);
        vaultFiles.set('note.md', taskLine);

        // Poll to detect failure
        manager.startPollingMs(200);
        await sleep(3000);

        // Task should be gone and marked as failed
        expect(manager.getActiveTaskCount()).toBe(0);
        const logNoteContent = vaultFiles.get(`${record.logNote}.md`);
        expect(logNoteContent).toContain('status: failed');
        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('dispatch with non-existent binary does not leave stale tasks', async () => {
        const deps = createDeps();
        const settings = createSettings({ agentType: 'test-bad-binary' });
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const sourceContent = 'do something';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('do something', 'note.md', 0, sourceContent);
        const taskLine = formatTaskLine(record.taskText, record.logNote, settings.pendingMarker, settings.useWikilinks);
        vaultFiles.set('note.md', taskLine);

        // Poll to detect failure
        manager.startPollingMs(200);
        await sleep(3000);

        // Verify no stale state
        expect(manager.getActiveTaskCount()).toBe(0);
        expect(manager.getActiveTasks()).toEqual([]);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('failed task gets ❌ marker after non-zero exit', async () => {
        const deps = createDeps();
        const settings = createSettings({ notifyOnCompletion: true });
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');

        const sourceContent = 'exit 1';
        vaultFiles.set('note.md', sourceContent);

        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('exit 1', 'note.md', 0, sourceContent);

        // Rewrite source line like main.ts does
        const taskLine = formatTaskLine(
            record.taskText,
            record.logNote,
            settings.pendingMarker,
            settings.useWikilinks
        );
        vaultFiles.set('note.md', taskLine);

        manager.startPollingMs(200);
        await sleep(3000);

        expect(manager.getActiveTaskCount()).toBe(0);

        // Log note should show failed
        const logNoteContent = vaultFiles.get(`${record.logNote}.md`);
        expect(logNoteContent).toContain('status: failed');

        // Source note should have failed marker
        const finalSource = vaultFiles.get('note.md');
        expect(finalSource).toContain(`- ${settings.failedMarker} `);

        // Notification should mention "failed"
        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        manager.stopPolling();
        await manager.cleanup();
    });
});
