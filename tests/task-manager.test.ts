import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';

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
    return { ...DEFAULT_SETTINGS, agentCommand: '/bin/sh -c', promptTemplate: '{{task}}', ...overrides };
}

function killProcess(pid: number): void {
    try { process.kill(pid, 'SIGTERM'); } catch { /* */ }
}

let testCounter = 0;
function uniqueTask(base: string): string {
    return `${base}_${++testCounter}_${Date.now()}`;
}

describe('TaskManager', () => {
    let deps: TaskManagerDeps;
    let settings: LlmTasksSettings;
    let manager: TaskManager;
    let createdPids: number[] = [];

    beforeEach(() => {
        deps = createMockDeps();
        settings = createSettings();
        manager = new TaskManager(deps, settings);
        createdPids = [];
    });

    afterEach(async () => {
        for (const pid of createdPids) {
            killProcess(pid);
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
            createdPids.push(r.pid);

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
            createdPids.push(r.pid);
            expect(manager.getActiveTaskCount()).toBe(1);
        });

        it('returns correct count after multiple dispatches', async () => {
            settings = createSettings({ maxConcurrent: 3 });
            manager = new TaskManager(deps, settings);
            const r1 = await manager.dispatch(uniqueTask('echo one'), 'note.md', 0, 'content');
            const r2 = await manager.dispatch(uniqueTask('echo two'), 'note.md', 1, 'content');
            createdPids.push(r1.pid, r2.pid);
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
            createdPids.push(r.pid);
            const tasks = manager.getActiveTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].taskText).toBe(task);
            expect(tasks[0].sourceFile).toBe('note.md');
            expect(tasks[0].pid).toBeGreaterThan(0);
            expect(tasks[0].logFile).toContain('llm-tasks');
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
            createdPids.push(record.pid);
            expect(record.taskText).toBe(task);
            expect(record.sourceFile).toBe('note.md');
            expect(record.sourceLine).toBe(5);
            expect(record.pid).toBeGreaterThan(0);
            expect(record.logFile).toContain('llm-tasks');
            expect(record.started).toBeTruthy();
        });

        it('strips leading "- " from list items', async () => {
            const record = await manager.dispatch('- say hello in the doc', 'note.md', 0, 'content');
            createdPids.push(record.pid);
            expect(record.taskText).toBe('say hello in the doc');
        });

        it('calls saveData to persist tasks', async () => {
            const r = await manager.dispatch(uniqueTask('echo hello'), 'note.md', 0, 'content');
            createdPids.push(r.pid);
            expect(deps.saveData).toHaveBeenCalled();
        });

        it('calls onTaskCountChanged', async () => {
            const r = await manager.dispatch(uniqueTask('echo hello'), 'note.md', 0, 'content');
            createdPids.push(r.pid);
            expect(deps.onTaskCountChanged).toHaveBeenCalledWith(1);
        });

        it('allows unlimited with maxConcurrent=0', async () => {
            settings = createSettings({ maxConcurrent: 0 });
            manager = new TaskManager(deps, settings);
            const r1 = await manager.dispatch(uniqueTask('echo 1'), 'note.md', 0, 'c');
            const r2 = await manager.dispatch(uniqueTask('echo 2'), 'note.md', 1, 'c');
            const r3 = await manager.dispatch(uniqueTask('echo 3'), 'note.md', 2, 'c');
            createdPids.push(r1.pid, r2.pid, r3.pid);
            expect(manager.getActiveTaskCount()).toBe(3);
        });
    });
});
