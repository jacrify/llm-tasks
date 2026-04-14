import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { TaskManager, TaskManagerDeps } from '../src/task-manager';
import { DEFAULT_SETTINGS, LlmTasksSettings } from '../src/settings';
import { registerAgent } from '../src/agents/registry';
import { AgentAdapter } from '../src/agents/types';
import { formatTaskLine, parseTaskLine } from '../src/note-writer';

/**
 * End-to-end tests that exercise the full flow:
 *   dispatch → tmux session created → agent runs → poll detects completion
 *   → source note updated → tmux scrollback contains output
 *
 * Also tests attach (with a no-op terminal command) and cancel.
 */

const e2eAdapter: AgentAdapter = {
    id: 'test-e2e',
    name: 'Test E2E',
    defaultCommand: '/bin/sh',
    buildArgs({ task }) {
        return ['-c', task];
    },
    isSuccess: (code) => code === 0,
};

registerAgent(e2eAdapter);

let testDir: string;
let vaultDir: string;
let savedData: any;
let vaultFiles: Map<string, string>;
let notifications: string[];
let taskCountHistory: number[];
let createdSessions: string[];

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
        agentType: 'test-e2e',
        // Use a no-op terminal command so attach doesn't pop Terminal.app
        openTerminalCommand: 'echo "{cmd}" > /dev/null',
        ...overrides,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function tmuxCapture(session: string): string {
    try {
        return execSync(`tmux capture-pane -t '${session}' -p -S -`, {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
        }).trim();
    } catch { return ''; }
}

function tmuxExists(session: string): boolean {
    try {
        execSync(`tmux has-session -t '${session}'`, { stdio: 'pipe' });
        return true;
    } catch { return false; }
}

function killSession(session: string): void {
    try { execSync(`tmux kill-session -t '${session}'`, { stdio: 'pipe' }); } catch { /* */ }
}

let counter = 0;
function unique(base: string): string { return `${base}_e2e_${++counter}_${Date.now()}`; }

describe('End-to-end', () => {
    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `llm-e2e-${Date.now()}`);
        vaultDir = path.join(testDir, 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        savedData = {};
        vaultFiles = new Map();
        notifications = [];
        taskCountHistory = [];
        createdSessions = [];
    });

    afterEach(() => {
        for (const s of createdSessions) killSession(s);
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
        createdSessions.push(rec.tmuxSession);

        // Rewrite source line like the plugin does
        const taskLine = formatTaskLine(rec.taskText, rec.tmuxSession, s.pendingMarker);
        const lines = sourceContent.split('\n');
        lines[1] = taskLine;
        vaultFiles.set('note.md', lines.join('\n'));

        // Verify tmux session exists
        expect(tmuxExists(rec.tmuxSession)).toBe(true);

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

        // tmux scrollback contains the actual output
        const output = tmuxCapture(rec.tmuxSession);
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
        createdSessions.push(rec.tmuxSession);

        vaultFiles.set('note.md', formatTaskLine(rec.taskText, rec.tmuxSession, s.pendingMarker));

        mgr.startPollingMs(200);
        await sleep(3000);
        mgr.stopPolling();

        expect(mgr.getActiveTaskCount()).toBe(0);

        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.failedMarker);

        // Scrollback still has the output even though it failed
        const output = tmuxCapture(rec.tmuxSession);
        expect(output).toContain(marker);

        expect(notifications.some(n => n.includes('failed'))).toBe(true);

        await mgr.cleanup();
    });

    it('cancel kills the session and marks line as failed', async () => {
        const deps = createDeps();
        const s = settings();

        const task = unique('sleep 300');
        vaultFiles.set('note.md', task);

        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, task);
        createdSessions.push(rec.tmuxSession);

        vaultFiles.set('note.md', formatTaskLine(rec.taskText, rec.tmuxSession, s.pendingMarker));

        // Verify running
        expect(tmuxExists(rec.tmuxSession)).toBe(true);
        expect(mgr.getActiveTaskCount()).toBe(1);

        // Cancel
        await mgr.cancel(rec.id);

        expect(mgr.getActiveTaskCount()).toBe(0);
        await sleep(500);
        expect(tmuxExists(rec.tmuxSession)).toBe(false);

        const finalSource = vaultFiles.get('note.md')!;
        expect(finalSource).toContain(s.failedMarker);

        await mgr.cleanup();
    });

    it('attach opens terminal (no-op) without error', async () => {
        const deps = createDeps();
        const s = settings();

        const task = unique('sleep 10');
        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, 'content');
        createdSessions.push(rec.tmuxSession);

        // Should not throw
        expect(() => mgr.attach(rec.tmuxSession)).not.toThrow();

        await mgr.cleanup();
    });

    it('attach works on completed session (scrollback still available)', async () => {
        const deps = createDeps();
        const s = settings();

        const task = 'echo SCROLLBACK_' + Date.now();
        vaultFiles.set('note.md', task);

        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, task);
        createdSessions.push(rec.tmuxSession);

        vaultFiles.set('note.md', formatTaskLine(rec.taskText, rec.tmuxSession, s.pendingMarker));

        mgr.startPollingMs(200);
        await sleep(3000);
        mgr.stopPolling();

        // Task is done but tmux session persists (remain-on-exit)
        expect(mgr.getActiveTaskCount()).toBe(0);
        expect(tmuxExists(rec.tmuxSession)).toBe(true);

        // Attach still works
        expect(() => mgr.attach(rec.tmuxSession)).not.toThrow();

        // Scrollback is readable
        const output = tmuxCapture(rec.tmuxSession);
        expect(output).toContain(task.replace('echo ', ''));

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
            createdSessions.push(rec.tmuxSession);
            records.push(rec);
        }

        // Rewrite source with task lines
        const newLines = records.map(r =>
            formatTaskLine(r.taskText, r.tmuxSession, s.pendingMarker)
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

        // Each tmux session has its output
        expect(tmuxCapture(records[0].tmuxSession)).toContain(`TASK_A_${ts}`);
        expect(tmuxCapture(records[1].tmuxSession)).toContain(`TASK_B_${ts}`);
        expect(tmuxCapture(records[2].tmuxSession)).toContain(`TASK_C_${ts}`);

        await mgr.cleanup();
    });

    it('parseTaskLine round-trips correctly with formatTaskLine', async () => {
        const deps = createDeps();
        const s = settings();

        const task = unique('echo roundtrip');
        const mgr = new TaskManager(deps, s);
        const rec = await mgr.dispatch(task, 'note.md', 0, 'content');
        createdSessions.push(rec.tmuxSession);

        const line = formatTaskLine(rec.taskText, rec.tmuxSession, s.pendingMarker);
        const parsed = parseTaskLine(line);

        expect(parsed).not.toBeNull();
        expect(parsed!.marker).toBe(s.pendingMarker);
        expect(parsed!.taskText).toBe(rec.taskText);
        expect(parsed!.sessionId).toBe(rec.tmuxSession);

        // findTaskBySession works
        const found = mgr.findTaskBySession(parsed!.sessionId);
        expect(found).toBeDefined();
        expect(found!.id).toBe(rec.id);

        await mgr.cleanup();
    });

    it('stale task detection on restart marks dead sessions as failed', async () => {
        const deps = createDeps();
        const s = settings();

        // Simulate persisted state from a previous session with a dead tmux session
        const fakeSession = `llm-fake-stale-${Date.now()}`;
        const taskLine = formatTaskLine('stale task', fakeSession, s.pendingMarker);
        vaultFiles.set('note.md', taskLine);

        savedData = {
            activeTasks: [{
                id: `fake-stale-${Date.now()}`,
                tmuxSession: fakeSession,
                sourceFile: 'note.md',
                sourceLine: 0,
                taskText: 'stale task',
                agentId: 'test-e2e',
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

        const t1 = unique('echo count1');
        const t2 = unique('echo count2');

        const r1 = await mgr.dispatch(t1, 'note.md', 0, 'c');
        createdSessions.push(r1.tmuxSession);
        expect(taskCountHistory).toContain(1);

        const r2 = await mgr.dispatch(t2, 'note.md', 1, 'c');
        createdSessions.push(r2.tmuxSession);
        expect(taskCountHistory).toContain(2);

        // Set up source so poll can update it
        const sourceLines = [
            formatTaskLine(r1.taskText, r1.tmuxSession, s.pendingMarker),
            formatTaskLine(r2.taskText, r2.tmuxSession, s.pendingMarker),
        ].join('\n');
        vaultFiles.set('note.md', sourceLines);

        mgr.startPollingMs(200);
        await sleep(4000);
        mgr.stopPolling();

        // Should have gone through 1, 2, then back down to 0
        expect(taskCountHistory[taskCountHistory.length - 1]).toBe(0);

        await mgr.cleanup();
    });
});
