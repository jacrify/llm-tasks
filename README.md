# LLM Tasks

An Obsidian plugin that dispatches lines of text to coding agents. Cursor on a line, hotkey, done. The agent runs in the background. Your note updates when it finishes.

That's it. No streaming UI, no chat panels, no embedded AI. Just a line of text → a background process → a result.

<!-- screenshot: dispatching a task -->

## Philosophy

This plugin does as little as possible. Your coding agent already knows how to code. Your shell already has your API keys and model preferences configured. The plugin's job is just to:

1. Take a line of text
2. Pass it to your agent as a CLI command
3. Track whether it's running, done, or failed
4. Show you the output when you want it

Configuration lives where it belongs — in your shell, your agent's config files, your environment variables. The plugin doesn't try to manage API keys, model selection, or provider configuration. If your agent works from the terminal, it works from here.

## How It Works

You write a task on any line in a note:

```
Refactor the auth module to use JWT tokens
```

Hit your hotkey. The line becomes:

```
- ⏳ [[llmlogs/2026-04-14_143022_refactor-the-auth-module|Refactor the auth module to use JWT tokens]]
```

The link points to a log note that tracks the session. When the agent finishes:

```
- ✅ [[llmlogs/2026-04-14_143022_refactor-the-auth-module|Refactor the auth module to use JWT tokens]]
```

Or if it failed: `- ❌`

<!-- screenshot: completed task with log note open -->

## Installation

### From source

```bash
git clone <repo-url> /path/to/llm-tasks
cd /path/to/llm-tasks
npm install
npm run build
```

Then symlink into your vault:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/llm-tasks
ln -sf /path/to/llm-tasks/main.js /path/to/vault/.obsidian/plugins/llm-tasks/main.js
ln -sf /path/to/llm-tasks/manifest.json /path/to/vault/.obsidian/plugins/llm-tasks/manifest.json
ln -sf /path/to/llm-tasks/styles.css /path/to/vault/.obsidian/plugins/llm-tasks/styles.css
```

Enable **LLM Tasks** in Obsidian → Settings → Community Plugins.

Assign a hotkey for **"LLM Tasks: Dispatch task"** in Settings → Hotkeys.

### Shell Environment

The plugin spawns agents through your login shell (`zsh -c`) so they inherit your full environment — PATH, API keys, everything. This means:

**Your agent must work when run non-interactively from a login shell.**

Test it:

```bash
zsh -l -c 'pi -p "say hello"'
zsh -l -c 'claude -p "say hello"'
```

If that works, the plugin will work. If it doesn't, your shell profile (`.zprofile`, `.zshrc`) needs to set up the right environment variables.

Common things to check:
- API keys must be exported in `.zprofile` or `.zshrc` (not just set in a terminal session)
- The agent binary must be on PATH (or use the full path in plugin settings)
- Any auth tokens fetched from keychain must work non-interactively

## Commands

| Command | Description |
|---------|-------------|
| **Dispatch task** | Send current line to the agent |
| **Cancel task** | Kill the agent process for the current line |
| **Retry task** | Re-dispatch a failed (`❌`) task |
| **Show log** | Open the log note for the current line's task |
| **Peek at task** | Show the last 50 lines of agent output |
| **Show active tasks** | Modal listing all running tasks |
| **Cancel all tasks** | Kill every running agent |

No default hotkeys — assign them in Settings → Hotkeys.

## Settings

### Agent

- **Agent type** — `Pi` or `Claude Code`. Determines how sessions, cost extraction, and resume commands work.
- **Command** — Override the agent binary. Leave blank to use the default (`pi` or `claude`).
- **Extra arguments** — Appended to every agent invocation. Use this for model selection, provider, or any other CLI flags.
  ```
  --model opus --provider amazon-bedrock
  ```
- **Working directory** — Where agent processes run: vault root, home directory, or a custom path.

### General

- **Log folder** — Where log notes are created (default: `llmlogs`)
- **Prompt file** — Vault-relative path to a markdown prompt template (default: `llm-tasks-prompt.md`)
- **Poll interval** — How often to check if tasks are done (default: 5s)
- **Max concurrent tasks** — Limit simultaneous agents (0 = unlimited)
- **Notify on completion** — Show an Obsidian notice when a task finishes
- **Include note context** — Pass the full source note to the agent as context
- **Context limit** — Max characters of note context to include
- **Use wikilinks** — Wrap task lines in `[[wikilinks]]` to log notes

## Prompt Template

Create `llm-tasks-prompt.md` in your vault root to customise what gets sent to the agent. If the file doesn't exist, a built-in default is used.

Available placeholders:

| Placeholder | Value |
|-------------|-------|
| `{{task}}` | The task text |
| `{{sourceNoteName}}` | Name of the source note |
| `{{noteContext}}` | Full content of the source note |
| `{{vaultPath}}` | Absolute path to the vault |
| `{{timestamp}}` | ISO timestamp |
| `{{agentId}}` | Agent type (pi, claude-code) |

Example:

```markdown
You are working in an Obsidian vault at {{vaultPath}}.

## Task

{{task}}

## Source Note: {{sourceNoteName}}

{{noteContext}}
```

## Log Notes

Each dispatched task creates a log note in your log folder with YAML frontmatter:

```yaml
---
type: llm-task
status: done
source: "[[Source Note]]"
task: 'The task instruction'
agent: pi
started: 2026-04-14T14:30:22
pid: 48291
cost: 0.0182
model: 'us.anthropic.claude-opus-4-6-v1'
input_tokens: 3551
output_tokens: 16
---
```

These are regular notes — search them, link to them, query them with Dataview.

<!-- screenshot: log note -->

## Adding a New Agent

Agents are TypeScript adapter objects. To add one, create a file in `src/agents/` and register it in `src/agents/registry.ts`.

Here's the full interface:

```typescript
interface AgentAdapter {
    id: string;           // Unique key, used in settings
    name: string;         // Display name for the dropdown
    defaultCommand: string; // Binary name (user can override in settings)

    // Build CLI arguments. The command itself comes from settings.
    // renderedPrompt is the full prompt text to send.
    // sessionFile is a path in tmpdir for session persistence.
    // extraArgs is what the user put in "Extra arguments" setting, already split.
    buildArgs(params: {
        renderedPrompt: string;
        sessionFile: string;
        extraArgs: string[];
    }): string[];

    // Did the task succeed? Usually just exitCode === 0.
    isSuccess(exitCode: number): boolean;

    // Extract cost/usage after completion. Return null if not supported.
    // sessionFile is the agent's session file, logFile is stdout capture.
    extractCost(sessionFile: string, logFile: string): Promise<CostData | null>;

    // Read the last N lines of output for the peek command.
    peek(logFile: string, lines?: number): Promise<string>;

    // Shell command to resume/attach to the session. Shown in the log note.
    resumeCommand(sessionFile: string): string;
}
```

### Minimal example

```typescript
// src/agents/aider.ts
import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const aiderAdapter: AgentAdapter = {
    id: "aider",
    name: "Aider",
    defaultCommand: "aider",

    buildArgs({ renderedPrompt, extraArgs }) {
        const args = ["--message", renderedPrompt];
        if (extraArgs.length > 0) args.push(...extraArgs);
        return args;
    },

    isSuccess: (code) => code === 0,
    async extractCost() { return null; },

    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand() { return 'aider'; },
};
```

Then register it in `src/agents/registry.ts`:

```typescript
import { aiderAdapter } from './aider';
registerAgent(aiderAdapter);
```

Rebuild (`npm run build`), reload the plugin, and select your agent in settings.

### What you need to implement

- **`buildArgs`** — How your agent takes a prompt from the CLI. Most agents have a `-p` or `--message` flag.
- **`extractCost`** — Optional. Parse your agent's session/log files for usage data. Return `null` if you don't care about cost tracking.
- **`resumeCommand`** — What shell command would resume this session. Shown in the log note for convenience.
- **`peek`** — Usually just tail the log file. Only override if your agent writes structured output (like Claude's JSON mode).

Everything else — environment, auth, model selection — is handled by the user's shell and the "Extra arguments" setting.

## Development

```bash
npm install
npm run build    # build main.js
npm test         # run tests (97 tests across 9 files)
```

Tests use vitest with a mock of the Obsidian API. The core logic (task manager, note writer, prompt renderer, agent adapters) is fully unit-tested without needing Obsidian. Integration tests spawn real processes.
