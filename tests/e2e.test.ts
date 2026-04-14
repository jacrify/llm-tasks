import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { formatTaskLine, parseTaskLine } from '../src/note-writer';

/**
 * End-to-end tests that exercise the full flow:
 *   dispatch → child process created → agent runs → poll detects completion
 *   → source note updated → log file contains output
 */

let testDir: string;
let vaultDir: string;
let savedData: any;
let vaultFiles: Map<string, string>;
let notifications: string[];
let taskCountHistory: number[];
let createdPids: number[];

function createDeps(): TaskManagerDeps {
    return {
        async readFile(p: string) { return vaultFiles.get(p) ?? null; },
        async writeFile(p: string, c: string) { vaultFiles.set(p, c); },
        getVaultPath() { return vaultDir; },
        async loadData() { return savedData; },
        async saveData(d: any) { savedData = d; },
        notify(msg: string) { notifications.push(msg); },
        onTaskCountChanged(n: number) { taskCountHistory.push(n); },
    };
}

function settings(overrides?: Partial<LlmTasksSettings>): LlmTasksSettings {
    return {
        ...DEFAULT_SETTINGS,
        agentCommand: '/bin/sh -c', promptTemplate: '{{task}}', sessionTemplate: '', resumeTemplate: '',
        ...overrides,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch { return false; }
}

function killProcess(pid: number): void {
    try { process.kill(pid, 'SIGTERM'); } catch { /* */ }
}

function readLogFile(logFile: string): string {
    try {
        return fs.readFileSync(logFile, 'utf-8').trim();
    } catch { return ''; }
}

describe('End-to-end', () => {
    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-e2e-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        notifications = [];
        taskCountHistory = [];
        createdPids = [];
    });

    afterEach(() => {
        for (const pid of createdPids) killProcess(pid);
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
    });

    it('dispatch → run → poll → done: full success path with output verification', async () => {
        const deps = createDeps();
        const s = settings({ notifyOnCompletion: true });

        const task = 'echo SUCCESS_MARKER_' + Date.now();
        const sourceContent = `Some context\n${task}\nMore content`;
        vaultFiles.set('note.md', sourceContent);

        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 1, sourceContent);
        createdPids.push(rec.pid);

        // Rewrite source line like the plugin does
        const taskLine = formatTaskLine(rec.taskText, rec.id, s.pendingMarker);
        const lines = sourceContent.split('\n');
        lines[1] = taskLine;
        vaultFiles.set('note.md', lines.join('\n'));

        // Verify process exists
        expect(isProcessAlive(rec.pid)).toBe(true);

        // Poll until done
        mgr.startPollingMs(200);
        await sleep(3000);
        mgr.stopPolling();

        // Task completed
        expect(mgr.getActiveTaskCount()).toBe(0);

        // Source note has ✅
        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.doneMarker);
        expect(finalSource).not.toContain(s.pendingMarker);

        // Notification fired
        expect(notifications.some(n => n.includes('completed'))).toBe(true);

        // Log file contains the actual output
        const output = readLogFile(rec.logFile);
        expect(output).toContain('SUCCESS_MARKER');

        await mgr.cleanup();
    });

    it('dispatch → run → poll → failed: non-zero exit', async () => {
        const deps = createDeps();
        const s = settings({ notifyOnCompletion: true });

        const marker = `FAIL_${Date.now()}`;
        const task = `echo ${marker}; exit 42`;
        vaultFiles.set('note.md', task);

        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, task);
        createdPids.push(rec.pid);

        vaultFiles.set('note.md', formatTaskLine(rec.taskText, rec.id, s.pendingMarker));

        mgr.startPollingMs(200);
        await sleep(3000);
        mgr.stopPolling();

        expect(mgr.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.failedMarker);

        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        // Log file still has the output
        const output = readLogFile(rec.logFile);
        expect(output).toContain(marker);

        await mgr.cleanup();
    });

    it('cancel kills the process and marks line as failed', async () => {
        const deps = createDeps();
        const s = settings();

        const task = 'sleep 300';
        vaultFiles.set('note.md', task);

        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, task);
        createdPids.push(rec.pid);

        vaultFiles.set('note.md', formatTaskLine(rec.taskText, rec.id, s.pendingMarker));

        // Verify running
        expect(isProcessAlive(rec.pid)).toBe(true);
        expect(mgr.getActiveTaskCount()).toBe(1);

        // Cancel
        await mgr.cancel(rec.id);

        expect(mgr.getActiveTaskCount()).toBe(0);
        await sleep(500);
        expect(isProcessAlive(rec.pid)).toBe(false);

        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.failedMarker);

        await mgr.cleanup();
    });

    it('multiple concurrent tasks dispatch and complete independently', async () => {
        const deps = createDeps();
        const s = settings({ maxConcurrent: 5, notifyOnCompletion: true });

        const mgr = new TaskManager(deps, s);

        const ts = Date.now();
        const tasks = [
            `echo TASK_A_${ts}`,
            `echo TASK_B_${ts}`,
            `echo TASK_C_${ts}`,
        ];

        const records = [];
        const sourceLines = tasks.join('\n');
        vaultFiles.set('note.md', sourceLines);

        for (let i = 0; i < tasks.length; i++) {
            const rec = await mgr.dispatch(tasks[i], 'note.md', i, sourceLines);
            createdPids.push(rec.pid);
            records.push(rec);
        }

        // Rewrite source with task lines
        const newLines = records.map(r =>
            formatTaskLine(r.taskText, r.id, s.pendingMarker)
        );
        vaultFiles.set('note.md', newLines.join('\n'));

        expect(mgr.getActiveTaskCount()).toBe(3);

        mgr.startPollingMs(200);
        await sleep(4000);
        mgr.stopPolling();

        expect(mgr.getActiveTaskCount()).toBe(0);

        // All should be done
        const finalSource = vaultFiles.get('note.md')!;
        const doneCount = (finalSource.match(new RegExp(s.doneMarker, 'g')) || []).length;
        expect(doneCount).toBe(3);

        // Each log file has its output
        expect(readLogFile(records[0].logFile)).toContain(`TASK_A_${ts}`);
        expect(readLogFile(records[1].logFile)).toContain(`TASK_B_${ts}`);
        expect(readLogFile(records[2].logFile)).toContain(`TASK_C_${ts}`);

        await mgr.cleanup();
    });

    it('parseTaskLine round-trips correctly with formatTaskLine', async () => {
        const deps = createDeps();
        const s = settings();

        const task = 'echo roundtrip_' + Date.now();
        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, 'content');
        createdPids.push(rec.pid);

        const line = formatTaskLine(rec.taskText, rec.id, s.pendingMarker);
        const parsed = parseTaskLine(line);

        expect(parsed).not.toBeNull();
        expect(parsed!.marker).toBe(s.pendingMarker);
        expect(parsed!.taskText).toBe(rec.taskText);
        expect(parsed!.sessionId).toBe(rec.id);

        // findTaskById works
        const found = mgr.findTaskById(parsed!.sessionId);
        expect(found).toBeDefined();
        expect(found!.id).toBe(rec.id);

        await mgr.cleanup();
    });

    it('stale task detection on restart marks dead processes as failed', async () => {
        const deps = createDeps();
        const s = settings();

        const fakeId = `fake-stale-${Date.now()}`;
        const taskLine = formatTaskLine('stale task', fakeId, s.pendingMarker);
        vaultFiles.set('note.md', taskLine);

        savedData = {
            activeTasks: [{
                id: fakeId,
                pid: 999999999,  // non-existent PID
                logFile: '/tmp/llm-tasks/fake.log',
                sourceFile: 'note.md',
                sourceLine: 0,
                taskText: 'stale task',
                started: '2026-04-14T10:00:00',
            }],
        };

        const mgr = new TaskManager(deps, s);
        await mgr.detectStaleTasks();

        expect(mgr.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.failedMarker);
        expect(notifications.some(n => n.includes('Stale task'))).toBe(true);

        await mgr.cleanup();
    });

    it('task count changes are reported correctly through lifecycle', async () => {
        const deps = createDeps();
        const s = settings();

        const mgr = new TaskManager(deps, s);

        const t1 = 'echo count1_' + Date.now();
        const t2 = 'echo count2_' + Date.now();

        const r1 = await mgr.dispatch(t1, 'note.md', 0, 'c');
        createdPids.push(r1.pid);
        expect(taskCountHistory).toContain(1);

        const r2 = await mgr.dispatch(t2, 'note.md', 1, 'c');
        createdPids.push(r2.pid);
        expect(taskCountHistory).toContain(2);

        // Set up source so poll can update it
        const sourceLines = [
            formatTaskLine(r1.taskText, r1.id, s.pendingMarker),
            formatTaskLine(r2.taskText, r2.id, s.pendingMarker),
        ].join('\n');
        vaultFiles.set('note.md', sourceLines);

        mgr.startPollingMs(200);
        await sleep(4000);
        mgr.stopPolling();

        expect(taskCountHistory[taskCountHistory.length - 1]).toBe(0);

        await mgr.cleanup();
    });
});
