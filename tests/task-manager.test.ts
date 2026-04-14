import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';

// Test agent adapter that runs shell commands directly
const testAdapter: AgentAdapter = {
    id: 'test',
    name: 'Test',
    settings: [],
    buildCommand({ renderedPrompt }) {
        return { command: '/bin/sh', args: ['-c', renderedPrompt] };
    },
    isSuccess: (code) => code === 0,
    extractCost: async () => null,
    async peek(logFile, lines = 20) {
        const fs = await import('node:fs');
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },
    resumeCommand: () => 'echo resume',
};

// Register once
registerAgent(testAdapter);

function createMockDeps(overrides?: Partial<TaskManagerDeps>): TaskManagerDeps {
    return {
        readFile: vi.fn().mockResolvedValue(null),
        writeFile: vi.fn().mockResolvedValue(undefined),
        ensureFolder: vi.fn().mockResolvedValue(undefined),
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

describe('TaskManager', () => {
    let deps: TaskManagerDeps;
    let settings: LlmTasksSettings;
    let manager: TaskManager;

    beforeEach(() => {
        deps = createMockDeps();
        settings = createSettings();
        manager = new TaskManager(deps, settings);
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

            // Dispatch first task successfully
            await manager.dispatch('echo first', 'note.md', 0, 'content');

            // Second should fail
            await expect(manager.dispatch('echo second', 'note.md', 1, 'content'))
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
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            expect(manager.getActiveTaskCount()).toBe(1);
        });

        it('returns correct count after multiple dispatches', async () => {
            settings = createSettings({ maxConcurrent: 3 });
            manager = new TaskManager(deps, settings);
            await manager.dispatch('echo one', 'note.md', 0, 'content');
            await manager.dispatch('echo two', 'note.md', 1, 'content');
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
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            const tasks = manager.getActiveTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].taskText).toBe('echo hello');
            expect(tasks[0].sourceFile).toBe('note.md');
            expect(tasks[0].agentId).toBe('test');
        });
    });

    describe('updateSettings', () => {
        it('updates settings', () => {
            const newSettings = createSettings({ maxConcurrent: 10 });
            manager.updateSettings(newSettings);
            // Verify by dispatching up to the new limit (no throw expected)
            expect(manager.getActiveTaskCount()).toBe(0);
        });
    });

    describe('dispatch success', () => {
        it('returns a valid TaskRecord', async () => {
            const record = await manager.dispatch('echo hello', 'note.md', 5, 'some content');
            expect(record.taskText).toBe('echo hello');
            expect(record.sourceFile).toBe('note.md');
            expect(record.sourceLine).toBe(5);
            expect(record.agentId).toBe('test');
            expect(record.pid).toBeGreaterThan(0);
            expect(record.logFile).toContain('llm-tasks');
            expect(record.sessionFile).toContain('sessions');
            expect(record.started).toBeTruthy();
        });

        it('calls ensureFolder with log folder', async () => {
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            expect(deps.ensureFolder).toHaveBeenCalledWith('llmlogs');
        });

        it('calls writeFile to create log note', async () => {
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            expect(deps.writeFile).toHaveBeenCalled();
            const call = (deps.writeFile as any).mock.calls[0];
            expect(call[0]).toMatch(/^llmlogs\/.+\.md$/);
            expect(call[1]).toContain('echo hello');
        });

        it('calls saveData to persist tasks', async () => {
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            expect(deps.saveData).toHaveBeenCalled();
        });

        it('calls onTaskCountChanged', async () => {
            await manager.dispatch('echo hello', 'note.md', 0, 'content');
            expect(deps.onTaskCountChanged).toHaveBeenCalledWith(1);
        });

        it('allows unlimited with maxConcurrent=0', async () => {
            settings = createSettings({ maxConcurrent: 0 });
            manager = new TaskManager(deps, settings);
            // Should not throw for many tasks
            await manager.dispatch('echo 1', 'note.md', 0, 'c');
            await manager.dispatch('echo 2', 'note.md', 1, 'c');
            await manager.dispatch('echo 3', 'note.md', 2, 'c');
            expect(manager.getActiveTaskCount()).toBe(3);
        });
    });
});
