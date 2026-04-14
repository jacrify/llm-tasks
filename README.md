# LLM Tasks — Obsidian Plugin

Dispatch lines of text as tasks to LLM agents (pi, Claude Code, etc.) directly from your Obsidian notes. Place your cursor on a line, hit a hotkey, and the plugin spawns an agent in the background, tracks its progress, and updates your note when it's done.

## Features

- **One-line dispatch** — cursor on a line, hotkey, done
- **Background execution** — agents run as child processes, no UI blocking
- **Automatic status tracking** — `⏳` → `✅` or `❌` with wikilinks to log notes
- **Pluggable agents** — ships with Pi and Claude Code adapters; easy to add your own
- **Customizable prompts** — vault-resident markdown template with `{{placeholders}}`
- **Peek at output** — view agent progress without waiting for completion

## Installation

1. Clone or copy this repo into your vault's `.obsidian/plugins/llm-tasks/` directory
2. Run `npm install && npm run build`
3. Enable **LLM Tasks** in Obsidian → Settings → Community Plugins
4. Assign a hotkey for **"LLM Tasks: Dispatch task"** in Settings → Hotkeys

## Usage

### Dispatching a Task

1. Place your cursor on any line in a note
2. Trigger the **Dispatch task** command (via your assigned hotkey)
3. The line is rewritten with a status checkbox and a link to the log note:

**Before:**
```
Refactor the auth module to use JWT tokens
```

**After:**
```
- [⏳] [[llmlogs/2026-04-14_143022_refactor-the-auth-module|⏳ Refactor the auth module to use JWT tokens]]
```

### Cancelling a Task

Place your cursor on an in-progress (`⏳`) task line and run **Cancel task**.

### Retrying a Failed Task

Place your cursor on a failed (`❌`) task line and run **Retry task**. The original task text is extracted and dispatched fresh.

### Peeking at Output

Place your cursor on an in-progress task line and run **Peek at task** to see the last 20 lines of agent output in a modal.

### Viewing the Log

Place your cursor on any task line and run **Show log** to open the full log note.

## Commands

| Command | ID | Description |
|---------|-----|-------------|
| Dispatch task | `llm-tasks:dispatch` | Dispatch current line as a task |
| Cancel task | `llm-tasks:cancel` | Cancel the task on the current line |
| Retry task | `llm-tasks:retry` | Re-dispatch a failed task |
| Show log | `llm-tasks:show-log` | Open the log note for the current line's task |
| Peek at task | `llm-tasks:peek` | Show last N lines of output in a modal |
| Show active tasks | `llm-tasks:show-active` | Modal listing all active tasks with status and actions |
| Cancel all tasks | `llm-tasks:cancel-all` | Cancel every active task |

No default hotkeys are assigned — configure them in Obsidian's Hotkeys settings.

## Settings

### General

| Setting | Default | Description |
|---------|---------|-------------|
| Log folder | `llmlogs` | Vault-relative path for log notes |
| Poll interval | `5` | Seconds between checking for task completion |
| Max concurrent tasks | `5` | Maximum simultaneous agents (0 = unlimited) |
| Notify on completion | `true` | Show Obsidian notice when a task finishes |
| Include note context | `true` | Pass full source note content to the agent |
| Context limit | `10000` | Max characters of note context to include |

### Prompt Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Prompt file | `llm-tasks-prompt.md` | Vault-relative path to prompt template |

### Agent Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Agent type | `pi` | Which agent adapter to use |
| Working directory | `vault` | Where to run agents (`vault`, `home`, or `custom`) |

### Task Line Format

| Setting | Default | Description |
|---------|---------|-------------|
| Pending marker | `⏳` | Marker for in-progress tasks |
| Done marker | `✅` | Marker for completed tasks |
| Failed marker | `❌` | Marker for failed tasks |
| Use wikilinks | `true` | Wrap task lines in `[[wikilinks]]` |

## Prompt Template

Create `llm-tasks-prompt.md` in your vault root (or change the path in settings). This file uses `{{placeholder}}` syntax:

```markdown
You are an AI assistant working inside an Obsidian vault at {{vaultPath}}.

## Rules
- Do NOT modify any checkbox lines in the source note.
- Be concise.

## Task
{{task}}

## Source Note: {{sourceNoteName}}
{{noteContext}}
```

**Available placeholders:**

| Placeholder | Value |
|-------------|-------|
| `{{task}}` | The task instruction text |
| `{{sourceNoteName}}` | Name of the source note |
| `{{noteContext}}` | Source note content (up to context limit) |
| `{{vaultPath}}` | Absolute path to the vault root |
| `{{timestamp}}` | ISO timestamp of dispatch |
| `{{agentId}}` | ID of the agent being used |

If the prompt file is missing, a sensible built-in default is used.

## Agent Adapters

### Pi (built-in)

The default adapter. Runs [pi](https://github.com/mariozechner/pi-coding-agent) with session support.

**Settings:** Binary path, Model, Provider, Additional arguments

### Claude Code (built-in)

Adapter for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Runs `claude -p` with the rendered prompt.

**Settings:** Binary path, Model, Additional arguments

### Adding a Custom Agent

Create a new file in `src/agents/` implementing the `AgentAdapter` interface:

```typescript
import { AgentAdapter } from './types';

export const myAdapter: AgentAdapter = {
    id: "my-agent",
    name: "My Agent",
    settings: [
        { key: "binaryPath", name: "Binary path", description: "Path to executable",
          type: "text", default: "my-agent" },
    ],

    buildCommand({ renderedPrompt, agentSettings }) {
        return {
            command: agentSettings.binaryPath || "my-agent",
            args: ["--prompt", renderedPrompt],
        };
    },

    isSuccess: (code) => code === 0,
    extractCost: async () => null,

    async peek(logFile, lines = 20) {
        const fs = require('fs');
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand() { return 'my-agent --continue'; },
};
```

Then register it in `src/agents/registry.ts`:

```typescript
import { myAdapter } from './my-agent';
registerAgent(myAdapter);
```

Rebuild with `npm run build` and the new agent appears in the settings dropdown.

## Data Storage

- **Active tasks** are persisted in the plugin's `data.json` (via Obsidian's `loadData`/`saveData`)
- **Agent stdout/stderr** is captured to `{tmpdir}/llm-tasks/{id}.log`
- **Agent sessions** are stored in `{tmpdir}/llm-tasks/sessions/{id}`
- **Log notes** are created in the configured log folder within the vault

## License

MIT
