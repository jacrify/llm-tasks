import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';

// Test agent adapter that runs shell commands directly
const testAdapter: AgentAdapter = {
    id: 'test',
    name: 'Test',
    defaultCommand: '/bin/sh',
    buildArgs({ task }) {
        return ['-c', task];
    },
    isSuccess: (code) => code === 0,
};

// Register once
registerAgent(testAdapter);

function createMockDeps(overrides?: Partial<TaskManagerDeps>): TaskManagerDeps {
    return {
        readFile: vi.fn().mockResolvedValue(null),
        writeFile: vi.fn().mockResolvedValue(undefined),
        getVaultPath: vi.fn().mockReturnValue('/tmp'),
        loadData: vi.fn().mockResolvedValue({}),
        saveData: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn(),
        onTaskCountChanged: vi.fn(),
        ...overrides,
    };
}

function createSettings(overrides?: Partial<LlmTasksSettings>): LlmTasksSettings {
    return { ...DEFAULT_SETTINGS, agentType: 'test', ...overrides };
}

function killTmuxSession(session: string): void {
    try { execSync(`tmux kill-session -t '${session}'`, { stdio: 'pipe' }); } catch { /* */ }
}

// Use a counter to ensure unique task text across tests (avoids tmux session name collisions)
let testCounter = 0;
function uniqueTask(base: string): string {
    return `${base}_${++testCounter}_${Date.now()}`;
}

describe('TaskManager', () => {
    let deps: TaskManagerDeps;
    let settings: LlmTasksSettings;
    let manager: TaskManager;
    let createdSessions: string[] = [];

    beforeEach(() => {
        deps = createMockDeps();
        settings = createSettings();
        manager = new TaskManager(deps, settings);
        createdSessions = [];
    });

    afterEach(async () => {
        for (const s of createdSessions) {
            killTmuxSession(s);
        }
        await manager.cleanup();
    });

    describe('dispatch validation', () => {
        it('rejects empty string', async () => {
            await expect(manager.dispatch('', 'note.md', 0, 'content')).rejects.toThrow('empty');
        });

        it('rejects whitespace-only string', async () => {
            await expect(manager.dispatch('   ', 'note.md', 0, 'content')).rejects.toThrow('empty');
        });

        it('rejects lines containing ⏳ marker', async () => {
            await expect(manager.dispatch('- ⏳ some task', 'note.md', 0, 'content')).rejects.toThrow('already a task');
        });

        it('rejects lines containing ✅ marker', async () => {
            await expect(manager.dispatch('- ✅ some task', 'note.md', 0, 'content')).rejects.toThrow('already a task');
        });

        it('rejects lines containing ❌ marker', async () => {
            await expect(manager.dispatch('- ❌ some task', 'note.md', 0, 'content')).rejects.toThrow('already a task');
        });

        it('rejects lines starting with # (headings)', async () => {
            await expect(manager.dispatch('# My Heading', 'note.md', 0, 'content')).rejects.toThrow('heading');
        });

        it('rejects ## headings too', async () => {
            await expect(manager.dispatch('## Sub Heading', 'note.md', 0, 'content')).rejects.toThrow('heading');
        });

        it('rejects when max concurrent reached', async () => {
            settings = createSettings({ maxConcurrent: 1 });
            manager = new TaskManager(deps, settings);

            const r = await manager.dispatch(uniqueTask('echo first'), 'note.md', 0, 'content');
            createdSessions.push(r.tmuxSession);

            await expect(manager.dispatch(uniqueTask('echo second'), 'note.md', 1, 'content'))
                .rejects.toThrow('Max concurrent');
        });

        it('rejects frontmatter lines', async () => {
            const noteContent = '---\ntype: note\n---\nActual content';
            await expect(manager.dispatch('type: note', 'note.md', 1, noteContent))
                .rejects.toThrow('frontmatter');
        });
    });

    describe('getActiveTaskCount', () => {
        it('returns 0 initially', () => {
            expect(manager.getActiveTaskCount()).toBe(0);
        });

        it('returns correct count after dispatch', async () => {
            const r = await manager.dispatch(uniqueTask('echo hello'), 'note.md', 0, 'content');
            createdSessions.push(r.tmuxSession);
            expect(manager.getActiveTaskCount()).toBe(1);
        });

        it('returns correct count after multiple dispatches', async () => {
            settings = createSettings({ maxConcurrent: 3 });
            manager = new TaskManager(deps, settings);
            const r1 = await manager.dispatch(uniqueTask('echo one'), 'note.md', 0, 'content');
            const r2 = await manager.dispatch(uniqueTask('echo two'), 'note.md', 1, 'content');
            createdSessions.push(r1.tmuxSession, r2.tmuxSession);
            expect(manager.getActiveTaskCount()).toBe(2);
        });
    });

    describe('cancel', () => {
        it('throws on unknown task ID', async () => {
            await expect(manager.cancel('nonexistent-id')).rejects.toThrow('No active task');
        });
    });

    describe('getActiveTasks', () => {
        it('returns empty array initially', () => {
            expect(manager.getActiveTasks()).toEqual([]);
        });

        it('returns dispatched tasks', async () => {
            const task = uniqueTask('echo hello');
            const r = await manager.dispatch(task, 'note.md', 0, 'content');
            createdSessions.push(r.tmuxSession);
            const tasks = manager.getActiveTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].taskText).toBe(task);
            expect(tasks[0].sourceFile).toBe('note.md');
            expect(tasks[0].agentId).toBe('test');
            expect(tasks[0].tmuxSession).toMatch(/^llm-/);
        });
    });

    describe('updateSettings', () => {
        it('updates settings', () => {
            const newSettings = createSettings({ maxConcurrent: 10 });
            manager.updateSettings(newSettings);
            expect(manager.getActiveTaskCount()).toBe(0);
        });
    });

    describe('dispatch success', () => {
        it('returns a valid TaskRecord', async () => {
            const task = uniqueTask('echo hello');
            const record = await manager.dispatch(task, 'note.md', 5, 'some content');
            createdSessions.push(record.tmuxSession);
            expect(record.taskText).toBe(task);
            expect(record.sourceFile).toBe('note.md');
            expect(record.sourceLine).toBe(5);
            expect(record.agentId).toBe('test');
            expect(record.tmuxSession).toMatch(/^llm-/);
            expect(record.started).toBeTruthy();
        });

        it('strips leading "- " from list items', async () => {
            const record = await manager.dispatch('- say hello in the doc', 'note.md', 0, 'content');
            createdSessions.push(record.tmuxSession);
            expect(record.taskText).toBe('say hello in the doc');
        });

        it('calls saveData to persist tasks', async () => {
            const r = await manager.dispatch(uniqueTask('echo hello'), 'note.md', 0, 'content');
            createdSessions.push(r.tmuxSession);
            expect(deps.saveData).toHaveBeenCalled();
        });

        it('calls onTaskCountChanged', async () => {
            const r = await manager.dispatch(uniqueTask('echo hello'), 'note.md', 0, 'content');
            createdSessions.push(r.tmuxSession);
            expect(deps.onTaskCountChanged).toHaveBeenCalledWith(1);
        });

        it('allows unlimited with maxConcurrent=0', async () => {
            settings = createSettings({ maxConcurrent: 0 });
            manager = new TaskManager(deps, settings);
            const r1 = await manager.dispatch(uniqueTask('echo 1'), 'note.md', 0, 'c');
            const r2 = await manager.dispatch(uniqueTask('echo 2'), 'note.md', 1, 'c');
            const r3 = await manager.dispatch(uniqueTask('echo 3'), 'note.md', 2, 'c');
            createdSessions.push(r1.tmuxSession, r2.tmuxSession, r3.tmuxSession);
            expect(manager.getActiveTaskCount()).toBe(3);
        });
    });
});
