import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';

// Test agent adapter
const testAdapter: AgentAdapter = {
    id: 'test',
    name: 'Test',
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

// Register (idempotent since registry uses Map)
registerAgent(testAdapter);

let testDir: string;
let vaultDir: string;
let savedData: any = {};
let vaultFiles: Map<string, string>;

function createRealDeps(): TaskManagerDeps {
    return {
        async readFile(filePath: string): Promise<string | null> {
            const content = vaultFiles.get(filePath);
            return content ?? null;
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            vaultFiles.set(filePath, content);
        },
        async ensureFolder(_path: string): Promise<void> {
            // no-op for tests
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

describe('TaskManager Integration', () => {
    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-tasks-test-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
    });

    afterEach(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // best effort
        }
    });

    it('dispatch spawns "echo hello" and log file contains hello', async () => {
        const deps = createRealDeps();
        // Provide a minimal prompt template so the rendered prompt is just the task
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('echo hello', 'note.md', 0, 'content');

        expect(record.pid).toBeGreaterThan(0);
        expect(record.logFile).toBeTruthy();

        // Wait for the echo to finish and log file to be written
        await sleep(1000);

        const logContent = fs.readFileSync(record.logFile, 'utf-8');
        expect(logContent).toContain('hello');

        await manager.cleanup();
    });

    it('poll loop detects process exit', async () => {
        const deps = createRealDeps();
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo done', 'note.md', 0, 'content');
        expect(manager.getActiveTaskCount()).toBe(1);

        // Start polling with short interval
        manager.startPollingMs(200);

        // Wait for echo to finish and poll to detect it
        await sleep(2000);

        expect(manager.getActiveTaskCount()).toBe(0);

        // Check that log note was updated
        const logNoteContent = vaultFiles.get(`${record.logNote}.md`);
        expect(logNoteContent).toBeDefined();
        expect(logNoteContent).toContain('done');

        manager.stopPolling();
        await manager.cleanup();
    });

    it('cancel sends SIGTERM to a "sleep 60" process', async () => {
        const deps = createRealDeps();
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const manager = new TaskManager(deps, createSettings());

        const record = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        expect(manager.getActiveTaskCount()).toBe(1);

        // Verify process is alive
        expect(() => process.kill(record.pid, 0)).not.toThrow();

        // Cancel
        await manager.cancel(record.id);
        expect(manager.getActiveTaskCount()).toBe(0);

        // Give a moment for the process to die
        await sleep(500);

        // Process should be dead
        expect(() => process.kill(record.pid, 0)).toThrow();

        await manager.cleanup();
    });

    it('cancelAll kills multiple running processes', async () => {
        const deps = createRealDeps();
        vaultFiles.set('llm-tasks-prompt.md', '{{task}}');
        const settings = createSettings({ maxConcurrent: 5 });
        const manager = new TaskManager(deps, settings);

        const r1 = await manager.dispatch('sleep 60', 'note.md', 0, 'content');
        const r2 = await manager.dispatch('sleep 61', 'note.md', 1, 'content');
        const r3 = await manager.dispatch('sleep 62', 'note.md', 2, 'content');

        expect(manager.getActiveTaskCount()).toBe(3);

        await manager.cancelAll();
        expect(manager.getActiveTaskCount()).toBe(0);

        await sleep(500);

        // All processes should be dead
        for (const pid of [r1.pid, r2.pid, r3.pid]) {
            expect(() => process.kill(pid, 0)).toThrow();
        }

        await manager.cleanup();
    });

    it('detectStaleTasks marks a non-existent PID as failed', async () => {
        const deps = createRealDeps();
        const manager = new TaskManager(deps, createSettings());

        // Create a fake log note in vault files
        const fakeLogNote = 'llmlogs/fake-task';
        vaultFiles.set(`${fakeLogNote}.md`, `---
type: llm-task
status: running
source: "[[note]]"
task: 'fake task'
agent: test
started: 2026-04-14T10:00:00
pid: 999999
---

# ⏳ fake task

**Source:** [[note]]
**Status:** ⏳ Running
**Agent:** test
**Started:** 2026-04-14 10:00:00

## Resume

\`\`\`bash
echo resume
\`\`\`

## Output

_Waiting for completion..._
`);

        // Put a stale task record in saved data with a PID that doesn't exist
        savedData = {
            activeTasks: [{
                id: 'fake-task',
                pid: 999999, // non-existent PID
                sourceFile: 'note.md',
                sourceLine: 0,
                taskText: 'fake task',
                logNote: fakeLogNote,
                logFile: '/tmp/llm-tasks/fake.log',
                sessionFile: '/tmp/llm-tasks/sessions/fake',
                agentId: 'test',
                started: '2026-04-14T10:00:00',
            }],
        };

        await manager.detectStaleTasks();

        // Should be marked as failed (no active tasks)
        expect(manager.getActiveTaskCount()).toBe(0);

        // Log note should be updated
        const updatedLog = vaultFiles.get(`${fakeLogNote}.md`);
        expect(updatedLog).toContain('failed');
        expect(updatedLog).toContain('stale PID');

        // Notification should have been sent
        expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('Stale task'));

        await manager.cleanup();
    });
});
