import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
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
    return { ...DEFAULT_SETTINGS, agentCommand: '/bin/sh -c', promptTemplate: '{{task}}', sessionTemplate: '', resumeTemplate: '', ...overrides };
}

describe('TaskManager - Continuation Dispatch', () => {
    let deps: TaskManagerDeps;
    let createdPids: number[] = [];

    beforeEach(() => {
        deps = createMockDeps();
        createdPids = [];
    });

    afterEach(() => {
        for (const pid of createdPids) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* */ }
        }
    });

    it('rejects continuation when parent task is still running', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const parentRecord = await manager.dispatch('echo parent running && sleep 60', 'note.md', 0, '- echo parent running && sleep 60');
        createdPids.push(parentRecord.pid);

        const noteContent = [
            `- ⏳ echo parent running && sleep 60 <!-- llm:${parentRecord.id} -->`,
            '  - Now add tests',
        ].join('\n');

        await expect(
            manager.dispatch('  - Now add tests', 'note.md', 1, noteContent)
        ).rejects.toThrow('Parent task is still running');

        await manager.cleanup();
    });

    it('allows continuation from completed (done) parent', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ✅ Refactor auth <!-- llm:2026-04-14_143022_refactor-auth session:abc123 -->',
            '  - Now add tests for it',
        ].join('\n');

        const record = await manager.dispatch('  - Now add tests for it', 'note.md', 1, noteContent);
        createdPids.push(record.pid);

        expect(record.parentTaskLine).toBe(0);
        expect(record.resumedFromSession).toBe('abc123');

        await manager.cleanup();
    });

    it('allows continuation from failed parent', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ❌ Refactor auth <!-- llm:2026-04-14_143022_refactor-auth session:abc123 -->',
            '  - Fix the error',
        ].join('\n');

        const record = await manager.dispatch('  - Fix the error', 'note.md', 1, noteContent);
        createdPids.push(record.pid);

        expect(record.parentTaskLine).toBe(0);
        expect(record.resumedFromSession).toBe('abc123');

        await manager.cleanup();
    });

    it('dispatches fresh when parent has no session tag', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ✅ Old task <!-- llm:old-task -->',
            '  - Follow up',
        ].join('\n');

        const record = await manager.dispatch('  - Follow up', 'note.md', 1, noteContent);
        createdPids.push(record.pid);

        expect(record.parentTaskLine).toBe(0);
        expect(record.resumedFromSession).toBeUndefined();

        await manager.cleanup();
    });

    it('finds resume session from sibling above', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ✅ Parent <!-- llm:parent session:parent-sess -->',
            '  - First follow <!-- llm:f1 session:f1-sess -->',
            '  - Second follow',
        ].join('\n');

        const record = await manager.dispatch('  - Second follow', 'note.md', 2, noteContent);
        createdPids.push(record.pid);

        expect(record.resumedFromSession).toBe('f1-sess');

        await manager.cleanup();
    });

    it('treats non-indented lines as fresh dispatch', async () => {
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ✅ Old task <!-- llm:old session:old-sess -->',
            '- New task',
        ].join('\n');

        const record = await manager.dispatch('- New task', 'note.md', 1, noteContent);
        createdPids.push(record.pid);

        expect(record.parentTaskLine).toBeUndefined();
        expect(record.resumedFromSession).toBeUndefined();

        await manager.cleanup();
    });

    it('includes session template args when configured', async () => {
        const settings = createSettings({ sessionTemplate: '--session-id {sessionId}' });
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo hello', 'note.md', 0, '- echo hello');
        createdPids.push(record.pid);

        // The agentSessionId should be set (UUID was generated)
        expect(record.agentSessionId).toBeDefined();
        expect(record.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);

        await manager.cleanup();
    });
});

describe('TaskManager - Completion with session update', () => {
    let vaultFiles: Map<string, string>;
    let savedData: any;

    function createRealDeps(): TaskManagerDeps {
        return {
            async readFile(filePath: string): Promise<string | null> {
                return vaultFiles.get(filePath) ?? null;
            },
            async writeFile(filePath: string, content: string): Promise<void> {
                vaultFiles.set(filePath, content);
            },
            getVaultPath: () => '/tmp',
            async loadData() { return savedData; },
            async saveData(data: any) { savedData = data; },
            notify: vi.fn(),
            onTaskCountChanged: vi.fn(),
        };
    }

    beforeEach(() => {
        vaultFiles = new Map();
        savedData = {};
    });

    it('updates parent marker on continuation completion', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ notifyOnCompletion: true });
        const manager = new TaskManager(deps, settings);

        const noteContent = [
            '- ✅ Parent task <!-- llm:parent-id session:parent-sess -->',
            '  - echo done',
        ].join('\n');

        const record = await manager.dispatch('  - echo done', 'note.md', 1, noteContent);

        const noteAfterDispatch = [
            '- ⏳ Parent task <!-- llm:parent-id session:parent-sess -->',
            `  - echo done <!-- llm:${record.id} -->`,
        ].join('\n');
        vaultFiles.set('note.md', noteAfterDispatch);

        manager.startPollingMs(200);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const finalContent = vaultFiles.get('note.md');
        expect(finalContent).toContain('- ✅ Parent task');
        expect(finalContent).toContain(`<!-- llm:${record.id}`);

        manager.stopPolling();
        await manager.cleanup();
    });

    it('stores agentSessionId on record when sessionTemplate is set', async () => {
        const deps = createRealDeps();
        const settings = createSettings({ sessionTemplate: '--session-id {sessionId}' });
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo done', 'note.md', 0, '- echo done');

        // The session ID should be set immediately at dispatch time
        expect(record.agentSessionId).toBeDefined();
        expect(record.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);

        await manager.cleanup();
    });

    it('writes session tag on completion', async () => {
        const deps = createRealDeps();
        const settings = createSettings();
        const manager = new TaskManager(deps, settings);

        const record = await manager.dispatch('echo done', 'note.md', 0, '- echo done');

        vaultFiles.set('note.md', `- ⏳ echo done <!-- llm:${record.id} -->`);

        manager.startPollingMs(200);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const finalContent = vaultFiles.get('note.md');
        expect(finalContent).toContain('- ✅ echo done');
        // Session tag should be written with the pre-generated UUID
        expect(finalContent).toContain(`session:${record.agentSessionId}`);

        manager.stopPolling();
        await manager.cleanup();
    });
});
