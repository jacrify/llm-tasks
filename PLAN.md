# LLM Tasks — Build Plan

## Testing Strategy

- **vitest** for unit/integration tests
- Mock Obsidian API with a thin shim (`tests/obsidian-mock.ts`)
- Pure logic modules take dependencies as arguments (not global imports) → testable without Obsidian
- Every phase gate: `npm run build` exits 0 AND `npx vitest run` exits 0

---

## Phases

### Phase 1: Project Scaffolding ✅
- [x] `package.json` with obsidian, typescript, esbuild, vitest deps
- [x] `manifest.json` (Obsidian plugin manifest)
- [x] `tsconfig.json`
- [x] `esbuild.config.mjs`
- [x] `vitest.config.ts`
- [x] `src/main.ts` — minimal Plugin subclass with onload/onunload
- [x] `tests/obsidian-mock.ts` — thin mock of Obsidian API surface we use

**Acceptance:**
- `npm install` exits 0
- `npm run build` exits 0, produces `main.js` in repo root
- `npx vitest run` exits 0

---

### Phase 2: Types & Agent Registry ✅
- [x] `src/agents/types.ts` — AgentAdapter, AgentSettingDefinition, CostData, TaskRecord interfaces
- [x] `src/agents/pi.ts` — Pi adapter
- [x] `src/agents/claude-code.ts` — Claude Code adapter
- [x] `src/agents/registry.ts` — agent map, get(), list()
- [x] `tests/agents.test.ts`

**Acceptance:**
- `npm run build` exits 0
- Test: pi buildCommand returns correct command/args for various settings
- Test: pi buildCommand includes --model only when set
- Test: claude-code buildCommand returns correct command/args
- Test: registry.get("pi") returns pi adapter
- Test: registry.list() returns both adapters

---

### Phase 3: Settings ✅
- [x] `src/settings.ts` — settings interface, DEFAULT_SETTINGS, mergeSettings(), PluginSettingTab
- [x] `tests/settings.test.ts`

**Acceptance:**
- `npm run build` exits 0
- Test: DEFAULT_SETTINGS has all expected keys with correct defaults
- Test: mergeSettings() fills missing keys from defaults

---

### Phase 4: Prompt Rendering ✅
- [x] `src/prompt.ts` — renderPrompt(), built-in default template, placeholder substitution
- [x] `tests/prompt.test.ts`

**Acceptance:**
- `npm run build` exits 0
- Test: renderPrompt replaces all known placeholders
- Test: unknown placeholders left as-is
- Test: null template falls back to built-in default
- Test: noteContext truncated to contextLimit

---

### Phase 5: Note Writing ✅
- [x] `src/note-writer.ts` — generateTaskId, formatTaskLine, updateTaskMarker, buildLogNote, updateLogNoteOnComplete, parseTaskLine
- [x] `tests/note-writer.test.ts`

**Acceptance:**
- `npm run build` exits 0
- Test: formatTaskLine produces correct wikilink line
- Test: formatTaskLine with useWikilinks=false produces plain text
- Test: updateTaskMarker swaps ⏳→✅ and ⏳→❌
- Test: buildLogNote produces valid frontmatter
- Test: updateLogNoteOnComplete updates status, appends output, adds cost when present
- Test: updateLogNoteOnComplete omits cost when CostData is null
- Test: parseTaskLine extracts taskId, logNotePath, marker, taskText
- Test: parseTaskLine returns null for non-task lines

---

### Phase 6: Task Manager ✅
- [x] `src/task-manager.ts` — dispatch, poll, cancel, cancelAll, stale PID detection, cleanup
- [x] `tests/task-manager.test.ts` (unit — mocked spawn)
- [x] `tests/task-manager-integration.test.ts` (real processes)

**Acceptance (unit):**
- `npm run build` exits 0
- Test: dispatch rejects empty lines
- Test: dispatch rejects already-task lines
- Test: dispatch rejects heading lines
- Test: dispatch rejects frontmatter lines
- Test: dispatch rejects when max concurrent reached
- Test: getActiveTaskCount returns correct count
- Test: cancel calls process.kill and marks failed

**Acceptance (integration):**
- Test: dispatch spawns real process ("echo hello"), log file created, stdout captured
- Test: poll loop detects exit, calls completion handler
- Test: cancel sends SIGTERM to "sleep 60", process dies
- Test: stale PID detection marks fake PID as failed
- Test: cancelAll kills multiple processes

---

### Phase 7: Commands & Status Bar ✅
- [x] Wire commands in `main.ts`: dispatch, cancel, retry, show-log, peek, show-active, cancel-all
- [x] Status bar item
- [x] `tests/commands.test.ts`

**Acceptance:**
- `npm run build` exits 0
- Test: dispatch handler calls taskManager.dispatch with correct args
- Test: cancel handler parses task ID from line and calls cancel
- Test: retry extracts original text from [❌] line and dispatches
- Test: retry on non-failed line is no-op
- Test: show-log extracts log note path from line
- Test: peek returns last N lines from log file

---

### Phase 8: Polish & Edge Cases ✅
- [x] `styles.css`
- [x] `README.md`
- [x] Handle non-existent agent binary gracefully
- [x] Full lifecycle integration test
- [x] `tests/lifecycle.test.ts`

**Acceptance:**
- `npm run build` exits 0
- styles.css exists and is non-empty
- README.md exists and is non-empty
- Test: dispatch with bad binary returns error, not crash
- Test: full lifecycle — dispatch "echo done", poll, verify ✅ marker and log note output
- All tests pass

---

## Status Log

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | ✅ | Completed 2026-04-14. All acceptance criteria pass: npm install, build, vitest run. |
| 2 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 10 agent tests pass. |
| 3 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 6 settings tests pass. |
| 4 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 11 prompt tests pass. |
| 5 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 17 note-writer tests pass. |
| 6 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 22 unit tests + 5 integration tests pass (73 total). |
| 7 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 90 total tests pass (17 command tests). |
| 8 | ✅ | Completed 2026-04-14. All acceptance criteria pass: build, 94 total tests pass (4 lifecycle tests). styles.css and README.md created. ENOENT handling improved. PROJECT COMPLETE. |
