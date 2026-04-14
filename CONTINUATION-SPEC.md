# Conversation Continuation Spec

## Overview

Allow users to continue an agent conversation by dispatching follow-up prompts underneath a completed task. The follow-ups resume the original agent session, carrying full context from the previous run.

## Note Format

### Initial dispatch

User writes a line, dispatches:

```
- ⏳ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
```

### After completion

```
- ✅ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
```

### User writes a continuation (indented below the parent)

```
- ✅ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
  - Now add tests for it
```

User places cursor on the indented line and dispatches. Result:

```
- ⏳ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
  - Now add tests for it <!-- llm:2026-04-14_153000_now-add-tests-for-it session:a1b2c3d4 -->
```

- The **parent task marker** changes back to ⏳ (it reflects the latest run's status).
- The continuation line gets its own `llm:` and `session:` tags but is not given a marker emoji — it's just a sub-item.

### Second continuation

User adds another line at the same indent level:

```
- ⏳ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
  - Now add tests for it <!-- llm:2026-04-14_153000_now-add-tests-for-it session:a1b2c3d4 -->
  - Fix the failing test in auth.test.ts
```

Dispatch from the third line. The plugin finds the nearest sibling above with a `session:` tag (`a1b2c3d4`) and resumes *that* session. Parent marker goes back to ⏳.

### After all complete

```
- ✅ Refactor the auth module <!-- llm:2026-04-14_143022_refactor-the-auth-module session:43f72127 -->
  - Now add tests for it <!-- llm:2026-04-14_153000_now-add-tests-for-it session:a1b2c3d4 -->
  - Fix the failing test in auth.test.ts <!-- llm:2026-04-14_160000_fix-the-failing-test session:e5f6g7h8 -->
```

## Session ID Storage

### In the HTML comment

The `session:` field stores the **agent session UUID** (not the tmux session name). This is the ID needed to resume the conversation.

Format: `<!-- llm:<task-id> session:<agent-session-uuid> -->`

### How to get the session UUID

**Claude**: Run with `-p --output-format json`. The final line of JSON output contains `"session_id": "..."`. Parse it after the process exits.

**Pi**: Run with `-p --mode json`. The first line of JSON output contains `"id": "..."` in the `session` event. Parse it from the output.

### In TaskRecord

Add `agentSessionId: string` to `TaskRecord`. Populated after the agent process exits (claude) or starts (pi) by parsing the JSON output.

## Dispatch Logic Changes

### Detecting a continuation

When the user dispatches from a line:

1. Check if the line is indented (starts with whitespace before `- `).
2. If indented, scan **upward** through sibling lines at the same indent level for the nearest line with a `session:` tag.
3. If no sibling found, scan upward for the **parent line** (one indent level less) with a `session:` tag.
4. If a session ID is found → this is a **continuation**. Resume that session.
5. If no session ID found → this is a **fresh dispatch** (normal flow).

### Building the resume command

**Claude**: `claude -p --output-format json --resume <session-uuid> "follow-up prompt"`

**Pi**: `pi -p --mode json --session <session-path> "follow-up prompt"` (pi uses file paths for sessions, resolve from session ID)

The resume flag is agent-specific. Add to agent command configuration:
- New setting: `agentResumeArgs` — template string like `--resume {sessionId}` that gets interpolated and inserted into the command when continuing.
- Or: detect from `agentCommand` whether it's claude or pi and hardcode the resume args for known agents.

**Recommended**: Keep it simple. Add a setting `resumeTemplate` with default empty. When set, e.g. `--resume {sessionId}`, the plugin interpolates and appends it to the agent command for continuations. When empty, continuations start fresh sessions (no resume capability).

### Updating the parent marker

When dispatching a continuation:

1. Find the top-level parent task (the non-indented line that heads the chain).
2. Update its marker to `pendingMarker` (⏳).

When a continuation completes:

1. Find the top-level parent.
2. Update its marker to `doneMarker` (✅) or `failedMarker` (❌) based on exit code.

### Finding the parent

Walk upward from the dispatched line. At each line, check indent level:
- Same indent → skip (sibling)
- Less indent and has `<!-- llm:... -->` → that's the parent
- Less indent without `<!-- llm:... -->` → not a task chain, stop

## Agent Command Changes

Currently the agent command is run inside tmux as:
```
<agentCommand> <rendered-prompt>
```

For continuations, it becomes:
```
<agentCommand> <resumeArgs> <rendered-prompt>
```

Where `resumeArgs` is built from the `resumeTemplate` setting with `{sessionId}` replaced.

### Output format change

To capture the session UUID, the agent must output structured data. Change the tmux command to:

**Claude**: Append `--output-format json` to the agent command. Parse the final JSON line from tmux scrollback after the pane dies.

**Pi**: Append `--mode json` to the agent command. Parse the first JSON line (session event) from tmux scrollback.

This is an internal detail — the user's `agentCommand` setting stays as-is (e.g. `claude -p`). The plugin appends the output format flags automatically.

### Extracting session UUID from the log file

After the process exits (detected by poll), read the log file at `record.logFile`:

```typescript
const output = fs.readFileSync(record.logFile, 'utf-8');
```

Parse for the session UUID:
- **Claude**: Find the last line that's valid JSON with `"session_id"` field.
- **Pi**: Find the first line that's valid JSON with `"type": "session"` and extract `"id"`.

Store in `record.agentSessionId`.

## Updated Interfaces

### TaskRecord

```typescript
interface TaskRecord {
    id: string;
    tmuxSession: string;
    sourceFile: string;
    sourceLine: number;
    taskText: string;
    started: string;
    agentSessionId?: string;      // NEW: agent's session UUID for resume
    parentTaskLine?: number;       // NEW: line number of the top-level parent (if continuation)
    resumedFromSession?: string;   // NEW: session UUID this was continued from
}
```

### HTML comment format

```
<!-- llm:<task-id> -->                          ← current (no session UUID yet, process running)
<!-- llm:<task-id> session:<uuid> -->            ← after completion (session UUID captured)
```

### note-writer changes

- `formatTaskLine()`: no change initially (session UUID not known at dispatch time)
- New: `updateTaskSession(line, sessionId)`: appends `session:<uuid>` to the HTML comment
- `parseTaskLine()`: also extract `session:` if present
- New: `findParentTask(lines, lineIndex)`: walk up to find the top-level parent
- New: `findResumeSession(lines, lineIndex)`: walk up through siblings then parent to find nearest `session:` tag

## Settings Changes

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `resumeTemplate` | string | `""` | Args to append for continuation. Use `{sessionId}` placeholder. E.g. `--resume {sessionId}` for claude. Empty = continuations start fresh. |

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Continue from a task with no `session:` tag | Start fresh (no resume). Session ID wasn't captured (old task or agent doesn't support it). |
| Continue from a still-running task (parent is ⏳) | Reject with notice: "Parent task is still running." |
| Continue from a failed task (parent is ❌) | Allowed. Resume the failed session to retry/fix. |
| Agent doesn't support resume (resumeTemplate empty) | Continuation dispatches a fresh session. The prompt still carries context from the note. |
| Indented line under a non-task line | Treated as a fresh dispatch (no parent found). |
| Multiple indent levels deep | Only one level of indentation is used for continuations. Deeper indent treated as fresh. |
| Session UUID extraction fails (malformed output) | Log warning, leave `agentSessionId` empty. Task still completes normally, just can't be resumed. |
