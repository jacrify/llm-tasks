# Simplification Spec — Remove Unused Features

## Overview

The current implementation has features from the original spec that aren't needed. This spec covers removing them to simplify the codebase before adding continuation support.

## What to Remove

### 1. tmux entirely

**Why**: tmux was used to run agents detached and to allow attaching to see output. With `-p` (non-interactive) mode and JSON output, there's no TUI to attach to. The agent is a simple CLI process that writes to stdout and exits. Just spawn it as a child process and pipe stdout/stderr to a log file.

**Remove:**
- All tmux session creation, `tmux new-session`, `tmux set-option remain-on-exit`
- All tmux polling: `tmux list-panes`, `tmux has-session`
- All tmux cleanup: `tmux kill-session`
- `attach` command and `TaskManager.attach()` method
- `DEFAULT_OPEN_TERMINAL` constant
- Settings: `tmuxCommand`, `openTerminalCommand`, `attachOnDispatch`

**Replace with:**
- `spawn()` the agent command with `detached: true`, `stdio` piped to a log file
- Store the `pid` in `TaskRecord` (replace `tmuxSession`)
- Store the log file path in `TaskRecord`
- Poll by checking if the PID is still alive (`process.kill(pid, 0)` — sends no signal, just checks existence)
- On completion, read the log file to extract the agent session UUID from JSON output
- On cancel, `process.kill(pid, 'SIGTERM')`
- On cleanup/unload, kill all tracked PIDs
- Stale task detection: check if PID exists on startup

### Log file location

Store agent output in a predictable location:
- `{os.tmpdir()}/llm-tasks/{task-id}.log`
- Create the directory on first use
- Log file contains the raw agent stdout (JSON lines for claude/pi)

### 2. `attach` command and all terminal-opening logic

**Why**: No tmux sessions to attach to. Continuation support (separate spec) replaces the "interact with a finished task" use case.

**Remove:**
- `attach` command registration in `main.ts`
- `TaskManager.attach()` method
- `spawn` import for terminal opening (keep `spawn` for agent process creation)

### 3. Log notes / `llmlogs/` folder (from original spec, not fully implemented)

**Why**: The original spec called for log notes with frontmatter, output, cost data, and resume commands. The current implementation doesn't create log notes — it just updates the source note line. Log notes are out of scope; the note itself is the record.

**Verify**: Confirm no log note creation code exists. If it does, remove it.

### 4. Agent adapter abstraction (from original spec, not implemented)

**Why**: The original spec had a full `AgentAdapter` interface with `buildCommand`, `extractCost`, `peek`, `resumeCommand`, etc. The current implementation just uses a single `agentCommand` string setting. This is simpler and sufficient.

**Verify**: `src/agents/` still has `pi.ts`, `claude-code.ts`, `registry.ts` from the spec. Check if they're actually used by `task-manager.ts`. If not, they can be removed or left as dead code for now.

### 5. `peek` command (from original spec, not fully implemented)

**Why**: Was meant to show last N lines of agent output. With `-p` in tmux, there's nothing to peek at until the agent finishes. The continuation spec replaces this use case.

**Remove**: If the `peek` command exists, remove it.

### 6. `show-log` command (from original spec)

**Why**: Depends on log notes which don't exist.

**Remove**: If the command exists, remove it.

### 7. `retry` command (from original spec)

**Why**: Continuation support subsumes retry. User can write a follow-up like "try again" or "fix the error" indented under the failed task.

**Remove**: If the command exists, remove it.

### 8. `show-active` modal command (from original spec)

**Why**: Status bar already shows active count. A modal listing tasks is nice-to-have but not needed. Can be re-added later.

**Remove**: If the command/modal exists, remove it.

## What to Keep

- **`spawn()` for agent processes** — replaces tmux
- **`shellPath` setting** — still needed for spawning via shell
- **`extraPath` setting** — still needed for PATH
- **`dispatch` command** — core functionality
- **`cancel` / `cancel-all` commands** — still needed
- **Poll loop and completion detection** — reworked to check PID instead of tmux pane status
- **Status bar** — still needed
- **All prompt/note-writer/settings infrastructure** — still needed

## Settings After Cleanup

| Setting | Keep/Remove | Notes |
|---------|-------------|-------|
| `pollInterval` | Keep | |
| `maxConcurrent` | Keep | |
| `notifyOnCompletion` | Keep | |
| `includeNoteContext` | Keep | |
| `contextLimit` | Keep | |
| `promptTemplate` | Keep | |
| `agentCommand` | Keep | |
| `pendingMarker` | Keep | |
| `doneMarker` | Keep | |
| `failedMarker` | Keep | |
| `tmuxCommand` | **Remove** | No tmux |
| `openTerminalCommand` | **Remove** | No attach |
| `shellPath` | Keep | |
| `extraPath` | Keep | |
| `attachOnDispatch` | **Remove** | No attach |

## Commands After Cleanup

| Command | Keep/Remove |
|---------|-------------|
| `dispatch` | Keep |
| `cancel` | Keep |
| `cancel-all` | Keep |
| `attach` | **Remove** |
| `retry` | **Remove** (if exists) |
| `show-log` | **Remove** (if exists) |
| `peek` | **Remove** (if exists) |
| `show-active` | **Remove** (if exists) |

## Updated TaskRecord

```typescript
interface TaskRecord {
    id: string;
    pid: number;              // replaces tmuxSession
    logFile: string;          // path to stdout log
    sourceFile: string;
    sourceLine: number;
    taskText: string;
    started: string;
}
```

## Updated Poll Logic

```typescript
private isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // signal 0 = just check existence
        return true;
    } catch {
        return false;
    }
}
```

Replace `getTmuxPaneStatus()` and `tmuxSessionExists()` with `isProcessAlive()`.

`handleTaskCompletion()` reads the log file to get the exit code (if possible) or just checks if the process is gone.

Note: `spawn()` with `detached: true` means the child survives if Obsidian exits. On next startup, `detectStaleTasks()` checks PIDs — dead PIDs get marked failed.

## Updated Dispatch

Replace the tmux command construction with:

```typescript
const logFile = path.join(os.tmpdir(), 'llm-tasks', `${id}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logFd = fs.openSync(logFile, 'w');

const child = spawn(shellPath, ['-c', agentCmd], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: this.buildEnv(),
    cwd: vaultPath,
});
child.unref();
fs.closeSync(logFd);
```

## Verification

After cleanup:
- `npm run build` exits 0
- `npx vitest run` exits 0 (update/remove tests for removed features)
- Only `dispatch`, `cancel`, `cancel-all` commands registered
- Settings tab has no tmux or terminal section, just `shellPath` and `extraPath` under a "Shell" heading
- `TaskManager` has no tmux-related methods
- No `execSync` calls to tmux
- Agent runs as a detached child process with output logged to a file
