# LLM Tasks — Obsidian Plugin Spec

An Obsidian plugin that lets you dispatch lines of text as tasks to an LLM agent (pi, claude code, aider, etc.) directly from your notes. Place your cursor on a line, hit a hotkey, and the plugin spawns an agent in the background, tracks its progress, and updates your note when it's done.

---

## Core Concepts

### Task
A single line in a note that the user explicitly marks for execution. The plugin does NOT auto-scan for tasks — dispatch is always user-initiated via command/hotkey.

### Agent
An external CLI process that executes the task. The plugin ships with a `pi` adapter but the agent system is pluggable. An agent adapter defines how to build the command line, pass context, extract costs, peek at output, and resume sessions.

### Prompt Template
A markdown file living in the vault (`llm-tasks-prompt.md` by default) that defines the base prompt sent to every agent. It uses `{{placeholders}}` for task-specific content. This lets you version-control and tweak your prompt alongside your notes.

### Log Note
A note created in a configurable folder (default: `llmlogs/`) that tracks the session: status, agent output, cost data, resume commands.

---

## User Flow

### Dispatching a Task

1. User places cursor on a line in any note.
2. User triggers the **"Dispatch task"** command via their configured hotkey (set in Obsidian's Hotkeys settings — no default binding).
3. Plugin reads the current line text as the task instruction. Selections are ignored — it's always the full line.
4. Plugin reads the full note content as context (frontmatter, headings, related info).
5. Plugin loads the prompt template from the vault, renders placeholders.
6. The line is rewritten in-place:

**Before:**
```
Refactor the secret redaction extension to support multiple providers
```

**After:**
```
- [⏳] [[llmlogs/2026-04-14_143022_refactor-secret-redaction|⏳ Refactor the secret redaction extension to support multiple providers]]
```

7. A log note is created in the log folder.
8. The configured agent is spawned in the background.
9. Status bar updates to show active task count.

### Task Completion

The plugin polls active task PIDs on a short interval (default: 5s).

When a task's process exits:
1. Log note is updated: status, output tail, cost data (if available).
2. Source note line is updated: `[⏳]` → `[✅]` (exit 0) or `[❌]` (non-zero).
3. An Obsidian notice is shown: "Task completed: <first 50 chars>".

### Cancelling a Task

User places cursor on an in-progress task line and triggers **"Cancel task"** command.
Plugin kills the process, marks the task `[❌]`, updates the log note.

### Re-dispatching a Failed Task

User places cursor on a `[❌]` line and triggers **"Retry task"** command.
Plugin extracts the original task text from the link alias, dispatches fresh.

---

## Commands

| Command | Default Hotkey | Description |
|---------|---------------|-------------|
| `llm-tasks:dispatch` | *(user-assigned)* | Dispatch current line as a task |
| `llm-tasks:cancel` | — | Cancel the task on the current line |
| `llm-tasks:retry` | — | Re-dispatch a failed task |
| `llm-tasks:show-log` | — | Open the log note for the task on the current line |
| `llm-tasks:peek` | — | Show a modal with the last N lines of output for the task on the current line |
| `llm-tasks:show-active` | — | Open a modal listing all active tasks with status, runtime, and peek |
| `llm-tasks:cancel-all` | — | Cancel all active tasks |

---

## Settings

### General

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Log folder | string | `llmlogs` | Vault-relative path for log notes |
| Poll interval | number | 5 | Seconds between checking for task completion |
| Max concurrent tasks | number | 5 | Maximum simultaneous agent processes. 0 = unlimited |
| Notify on completion | toggle | true | Show Obsidian notice when a task finishes |
| Include note context | toggle | true | Pass full source note content to the agent as context |
| Context limit | number | 10000 | Max characters of note context to include |

### Prompt Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Prompt file | string | `llm-tasks-prompt.md` | Vault-relative path to the prompt template |

The plugin looks for this file in the vault. If present, its content is loaded and placeholders are rendered. If missing, the plugin falls back to a sensible built-in default.

The file is plain markdown, version-controlled alongside the vault.

**Example `llm-tasks-prompt.md`:**

```markdown
You are an AI assistant working inside an Obsidian vault at {{vaultPath}}.

## Rules

- Do NOT modify any checkbox lines (lines starting with '- [') in the source note. Task status is managed by the llm-tasks plugin.
- Do NOT create any lines starting with '- [ ]' (checkbox syntax) in ANY file. Checkboxes trigger automated task execution.
- If you need a list, use plain '- ' items, not checkboxes.
- Work within the vault directory unless the task says otherwise.
- Be concise.

## Vault Context

This vault is a personal knowledge base and project management system. Notes use YAML frontmatter with fields like `type`, `areas`, `parent`, `status`.

## Task

{{task}}

## Source Note: {{sourceNoteName}}

{{noteContext}}
```

**Available placeholders:**

| Placeholder | Replaced with |
|-------------|---------------|
| `{{task}}` | The task instruction text |
| `{{sourceNoteName}}` | Name of the note the task was dispatched from |
| `{{noteContext}}` | Full content of the source note (up to context limit) |
| `{{vaultPath}}` | Absolute path to the vault root |
| `{{timestamp}}` | ISO timestamp of dispatch |
| `{{agentId}}` | ID of the agent being used |

### Agent Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Agent type | dropdown | `pi` | Which agent adapter to use |
| Working directory | dropdown | `vault` | `vault` = vault root, `home` = user home, `custom` = specify |
| Custom working directory | string | — | Used when working directory is `custom` |

Agent-specific settings (binary path, model, extra args, etc.) are declared by each adapter via `AgentAdapter.settings` and rendered dynamically in the settings tab when that agent is selected.

### Task Line Format

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Pending marker | string | `⏳` | Emoji/text for in-progress checkbox |
| Done marker | string | `✅` | Emoji/text for completed checkbox |
| Failed marker | string | `❌` | Emoji/text for failed checkbox |
| Use wikilinks | toggle | true | Wrap dispatched tasks in `[[wikilinks]]`. If false, keep plain text |

---

## Agent Adapter Interface

Agents are defined as adapter objects. The plugin ships with `pi` but others can be added.

```typescript
interface AgentAdapter {
    /** Unique identifier */
    id: string;

    /** Display name for settings dropdown */
    name: string;

    /**
     * Agent-specific settings schema.
     * Each entry is rendered in the settings tab when this agent is selected.
     * Values are stored under `agentSettings[agentId]` in plugin data.
     * Auth/API key configuration is out of scope — assumed handled
     * externally (env vars, config files, keychain, etc.).
     */
    settings: AgentSettingDefinition[];

    /**
     * Build the command and arguments to spawn.
     * The rendered prompt (from the vault prompt template) is passed in.
     */
    buildCommand(params: {
        renderedPrompt: string;
        logFile: string;
        sessionFile: string;
        workingDirectory: string;
        agentSettings: Record<string, any>;
    }): { command: string; args: string[] };

    /**
     * Determine if the task succeeded after process exit.
     * Default: exit code === 0.
     * Adapters can override to inspect log output, etc.
     */
    isSuccess(exitCode: number, logFile: string): boolean;

    /**
     * Extract cost/usage metadata from the session after completion.
     * Return null if not supported or data unavailable.
     */
    extractCost(sessionFile: string): Promise<CostData | null>;

    /**
     * Read the last N lines of agent output without waiting for completion.
     * Used by the "Peek at task" command.
     */
    peek(logFile: string, lines?: number): Promise<string>;

    /**
     * Build a shell command string for resuming/attaching to the session.
     * Shown in the log note for the user to copy.
     */
    resumeCommand(sessionFile: string): string;
}

interface AgentSettingDefinition {
    key: string;            // Storage key
    name: string;           // Display label
    description: string;    // Help text
    type: 'text' | 'number' | 'toggle' | 'dropdown';
    default: any;
    options?: string[];     // For dropdown type
}

interface CostData {
    model?: string;
    provider?: string;
    cost?: number;          // Total USD
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
```

### Pi Adapter (built-in)

```typescript
const piAdapter: AgentAdapter = {
    id: "pi",
    name: "Pi",

    settings: [
        { key: "binaryPath", name: "Binary path", description: "Path to pi executable", type: "text", default: "pi" },
        { key: "model", name: "Model", description: "Model pattern (e.g. sonnet, opus). Leave blank for default", type: "text", default: "" },
        { key: "provider", name: "Provider", description: "Provider name (e.g. google, anthropic, amazon-bedrock). Leave blank for default", type: "text", default: "" },
        { key: "additionalArgs", name: "Additional arguments", description: "Extra CLI args (space-separated)", type: "text", default: "" },
    ],

    buildCommand({ renderedPrompt, sessionFile, agentSettings }) {
        const args = ["-p", "--session", sessionFile];

        if (agentSettings.model) args.push("--model", agentSettings.model);
        if (agentSettings.provider) args.push("--provider", agentSettings.provider);
        if (agentSettings.additionalArgs) {
            args.push(...agentSettings.additionalArgs.split(/\s+/).filter(Boolean));
        }

        args.push(renderedPrompt);

        return { command: agentSettings.binaryPath || "pi", args };
    },

    isSuccess(exitCode) {
        return exitCode === 0;
    },

    async extractCost(sessionFile) {
        // Pi stores sessions as JSONL. Parse for usage/cost records.
        // Each line is a JSON object; look for entries with `usage` or `cost` fields.
        return null; // TODO: implement
    },

    async peek(logFile, lines = 20) {
        const fs = require('fs');
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand(sessionFile) {
        return `pi --session ${sessionFile}`;
    },
};
```

### Example: Claude Code Adapter

```typescript
const claudeCodeAdapter: AgentAdapter = {
    id: "claude-code",
    name: "Claude Code",

    settings: [
        { key: "binaryPath", name: "Binary path", description: "Path to claude executable", type: "text", default: "claude" },
        { key: "model", name: "Model", description: "Model to use (e.g. sonnet, opus)", type: "text", default: "" },
        { key: "additionalArgs", name: "Additional arguments", description: "Extra CLI args", type: "text", default: "" },
    ],

    buildCommand({ renderedPrompt, agentSettings }) {
        const args = ["-p"];
        if (agentSettings.model) args.push("--model", agentSettings.model);
        if (agentSettings.additionalArgs) {
            args.push(...agentSettings.additionalArgs.split(/\s+/).filter(Boolean));
        }
        args.push(renderedPrompt);
        return { command: agentSettings.binaryPath || "claude", args };
    },

    isSuccess: (code) => code === 0,
    async extractCost() { return null; },

    async peek(logFile, lines = 20) {
        const fs = require('fs');
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand() { return `claude --continue`; },
};
```

---

## Log Note Format

Created when a task is dispatched. Updated on completion.

```markdown
---
type: llm-task
status: running
source: "[[Source Note Name]]"
task: 'The task instruction text'
agent: pi
started: 2026-04-14T14:30:22
pid: 48291
---

# ⏳ The task instruction text

**Source:** [[Source Note Name]]
**Status:** ⏳ Running
**Agent:** pi
**Started:** 2026-04-14 14:30:22

## Resume

\`\`\`bash
pi --session /path/to/session
\`\`\`

## Output

_Waiting for completion..._
```

On completion, status fields update and output is appended. If the agent adapter returns `CostData` from `extractCost()`, cost fields are added to frontmatter and a cost summary line is added to the body:

```markdown
**Cost:** $0.0534 · us.anthropic.claude-sonnet-4-20250514 · 9,603 in / 217 out
```

---

## Data Storage

### Active Tasks

Stored in the plugin's data file (`data.json` via `this.loadData()`/`this.saveData()`), not a separate JSON file.

```typescript
interface TaskRecord {
    id: string;               // timestamp_slug
    pid: number;
    sourceFile: string;       // vault-relative path
    sourceLine: number;       // line number (for faster lookup)
    taskText: string;
    logNote: string;          // vault-relative path to log note
    logFile: string;          // absolute path to stdout capture
    sessionFile: string;      // absolute path to agent session
    agentId: string;          // which adapter was used
    started: string;          // ISO timestamp
    cost?: CostData;          // populated on completion
}
```

### Temp Files

- Agent stdout/stderr: `{tmpdir}/llm-tasks/{id}.log`
- Agent sessions: `{tmpdir}/llm-tasks/sessions/{id}` (agent-specific)

Where `tmpdir` is `os.tmpdir()` (e.g. `/tmp` on macOS).

---

## File Structure

```
llm_tasks/                          # Plugin source (~/code/llm_tasks)
├── SPEC.md
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── src/
│   ├── main.ts                    # Plugin entry: onload, commands, settings
│   ├── task-manager.ts            # Spawn, poll, complete/cancel tasks
│   ├── note-writer.ts             # Create/update log notes and source note lines
│   ├── prompt.ts                  # Load vault prompt template, render placeholders
│   ├── settings.ts                # Settings tab UI and defaults
│   └── agents/
│       ├── types.ts               # AgentAdapter, AgentSettingDefinition, CostData
│       ├── pi.ts                  # Pi adapter
│       ├── claude-code.ts         # Claude Code adapter (example)
│       └── registry.ts            # Agent registry (map of id → adapter)
├── styles.css
└── README.md

technotes/                          # Vault (user-managed)
├── llm-tasks-prompt.md             # Prompt template (vault-resident, version-controlled)
├── llmlogs/                        # Task session notes (auto-created by plugin)
└── ...
```

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Line is already a task (`[⏳]`, `[✅]`, `[❌]`) | Dispatch command is no-op. Show notice "Line is already a task". |
| Line is empty | No-op. |
| Line is a heading or frontmatter | No-op. Only dispatch plain text or list items. |
| Prompt template file missing | Fall back to built-in default prompt. |
| Prompt template has unknown placeholders | Left as-is (not replaced). |
| Source note deleted while task running | Task still completes. Log note updated. Source note update silently skipped. |
| Plugin unloaded while tasks active | `onunload()` kills all active child processes and marks them cancelled. |
| Obsidian quit while tasks active | OS cleans up child processes. On next load, plugin detects stale PIDs in data.json, marks them as failed. |
| Max concurrent reached | Show notice "Max concurrent tasks reached (N). Cancel or wait for a task to finish." |
| Agent binary not found | Show error notice. Don't rewrite the line. |
| Same task text dispatched twice | Allowed. Each gets its own log note and process. |

---

## Status Bar

Shows in the Obsidian status bar (bottom right):

- No tasks: hidden or `🤖 0`
- Active: `🤖 3 running`
- Click to open the active tasks modal

---

## CSS (optional, `styles.css`)

Custom rendering for the task checkboxes in reading mode:

```css
/* Style custom checkbox states in reading view */
input[data-task="⏳"] + span { opacity: 0.7; font-style: italic; }
input[data-task="✅"] + span { opacity: 0.6; text-decoration: line-through; }
input[data-task="❌"] + span { opacity: 0.6; color: var(--text-error); }
```

---

## Non-Goals (v1)

- **Task queue / scheduling** — all tasks dispatch immediately (up to max concurrent)
- **Agent streaming / live output** — log note shows final output only; use peek for in-progress
- **Multi-turn agent interaction** — tasks are fire-and-forget
- **Vault-wide task scanning** — dispatch is always explicit via command
- **Task dependencies** — tasks are independent
- **Remote agents / API-based execution** — agents are local CLI processes only
- **Auth / API key management** — handled externally (env vars, keychain, config files)
