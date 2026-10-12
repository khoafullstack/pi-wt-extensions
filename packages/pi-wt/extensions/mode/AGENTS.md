# pi-wt mode modules: Guide, Plan and Checklist

Module guide for coding agents. Package-wide rules live in `../../AGENTS.md` and repository rules in `../../../../AGENTS.md`. These modules now belong to the merged `pi-wt` package; historical phase notes below describe their implementation before the merge.

The user chose names `wt-btw*` and `wt-advisor*`, preserved by the merge. Keep mode feature names under those prefixes, with `/wt-mode` as the status command.

## Goal

Add two features to this package:

1. `btw`: a side conversation in an overlay, backed by a real Pi sub-session. It never enters the main session context.
2. `advisor`: a model-callable tool that asks a stronger model for advice or review in a single call.

## Decisions

All decisions below are final unless the user changes them. Items marked (agent) were decided by the agent on the user's behalf and can be revisited.

### `btw`

| Topic | Decision |
| --- | --- |
| Implementation | Real sub-session via `createAgentSession()` + `SessionManager.inMemory()`, same approach as `pi-btw` (npm `pi-btw@0.7.1`, https://github.com/dbachelder/pi-btw). |
| Entry commands | `/wt-btw` always uses main-session context. `/wt-btw-clear` resets the thread and refreshes the context snapshot on the next question. |
| Tools | Read-only for both: `read`, `grep`, `find`, `ls`. Enforced structurally with a `tools` allowlist. |
| Thread | Continuous, like `pi-btw`: hidden entries via `pi.appendEntry`, restored on `session_start` / `session_tree`, filtered out of the main context. |
| While agent is busy | Allowed. Side prompts are queued so they never overlap. |
| Model | Chosen first in `/wt-btw-config`, followed by thinking selection. Both settings save together after both steps; cancellation saves neither. Falls back to main if unavailable. |
| Thinking level | Chosen second in `/wt-btw-config`; `clear` inherits the main level. |
| Handoff to main agent | Removed by user request. No inject, summarize or `sendUserMessage` path in BTW. |
| Focus shortcut | `Alt+B`, with `Ctrl+Alt+B` as fallback. Remappable in config. No width-toggle shortcut at first. |
| Extra extensions in sub-session | Out of scope. The sub-session loads no extensions. |
| Non-TUI hosts | Question must be inline. The answer is shown as a visible note via `pi.sendMessage`. (agent) |
| Save to session | Optional `--save` flag writes one visible note, like `pi-btw`. (agent) |

### `advisor`

| Topic | Decision |
| --- | --- |
| Form | Model-callable tool named `wt-advisor`. A single completion call with no tools. |
| Model | Set by `/wt-advisor` command, stored in config. |
| Thinking level | Set by `/wt-advisor-thinking`, stored as `advisor.thinkingLevel`. Missing/null inherits main thinking; `clear` restores inheritance. Show the setting in `/wt-mode` and requested level in tool results. |
| Context sent | Full session transcript from `ctx.sessionManager`, plus the question. |
| Arguments | `question` (required string), `focus` (optional string, what to concentrate on). No `files` argument; the transcript already holds file contents the agent read. (agent) |
| Guardrails | Max 3 calls per agent run (reset on `agent_start`), 120 s timeout, 4096 max output tokens. No per-call confirmation, because the user opted in by configuring a model. Limits live in config. (agent) |
| No model configured | The tool stays registered and throws a clear error telling the agent the advisor is unavailable and not to retry. (agent) |
| Long transcripts | Estimate size (about 4 chars per token). If over about 80% of the advisor model's context window, truncate each tool result to 2000 chars first, then drop the oldest messages, always keeping the first user message and the latest messages. Add a note that the transcript was shortened. (agent) |
| Display | Custom `renderCall` / `renderResult` with a compact view; full text in expanded mode. (agent) |

### Shared

| Topic | Decision |
| --- | --- |
| Config location | Shared `~/.pi/agent/pi-wt-settings.json`, overridden by project `.pi/pi-wt-settings.json` only when `ctx.isProjectTrusted()` for mode sections. `config.ts` re-exports the shared settings module. Old `wt-mode.json` migrates once and is archived. Atomic writes preserve UI fields and reject corrupt destinations. |
| Existing `/wt-mode` command | Keep as a status command: shows the configured btw/advisor models and thinking level. (agent) |
| Command list | `/wt-mode`, `/wt-btw`, `/wt-btw-clear`, `/wt-btw-config`, `/wt-advisor`, `/wt-advisor-thinking`. |

## Reference: how `pi-btw` works (to reuse the ideas, not the code)

- Sub-session: `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), model, thinkingLevel, tools, resourceLoader })`. Ask with `session.prompt(q, { source: "extension" })`, stop with `session.abort()`, observe with `session.subscribe(event => ...)`, free with `session.dispose()`.
- Seeding context: `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages`, minus visible BTW notes, appended with `sessionManager.appendMessage()` before creating the `AgentSession`. Earlier side exchanges are appended as user/assistant pairs after a marker pair.
- System prompt: custom `ResourceLoader` returning the parent's `ctx.getSystemPrompt()` (date/cwd footer stripped) plus a BTW prompt and an authoritative `<btw_capabilities>` block listing the child's real tools. Skills, prompts, themes and AGENTS files are empty.
- Tool boundary is structural (`tools: [...]` allowlist), not prompt-based.
- Model: inherit the main model, or a BTW-only override (and thinking override). Fall back to the main model when the override has no credentials.
- Persistence: `pi.appendEntry("btw-thread-entry" | "btw-thread-reset" | override types, details)`. Not in LLM context. `--save` writes a visible `pi.sendMessage` note (`deliverAs: "followUp"` when busy). A `pi.on("context")` handler filters visible BTW messages.
- UI: `ctx.ui.custom(factory, { overlay: true, overlayOptions, onHandle })`; component extends `Container implements Focusable`; `handle.focus()`; shortcuts move focus between overlay and editor; Esc aborts first, second Esc dismisses.
- Handoff: `pi.sendUserMessage(content)` (idle) or `{ deliverAs: "followUp" }` (busy).
- Lifecycle: generation counter to ignore stale async work; `session_shutdown` disposes the sub-session and overlay.
- Prompt queue: a promise chain (`promptQueue`) serializes turns.

## Proposed architecture

Keep `extensions/mode/index.ts` as a thin `registerMode()` module, called by the package's only entry point `extensions/index.ts`.

```
extensions/mode/
├─ index.ts            # factory: registers commands, tool, shortcuts, event handlers only
├─ config.ts           # compatibility re-exports from ../settings.ts (shared UI/mode config)
├─ transcript.ts       # main-session branch -> model messages (filter BTW entries, truncate)
├─ llm.ts              # single nested model call (ctx.modelRegistry.streamSimple)
├─ btw/
│  ├─ session.ts       # create/reuse/dispose sub-session, seed, prompt queue, generation guard
│  ├─ state.ts         # hidden thread entries, restore on session_start/session_tree
│  ├─ overlay.ts       # overlay component, focus and key handling
│  ├─ commands.ts      # /wt-btw* handlers, arg parsing
│  └─ handoff.ts       # inject / summarize with user confirmation
└─ advisor.ts          # wt-advisor tool + /wt-advisor command
```

Key rules from the Pi extension guide:

- No processes, watchers or timers in the factory. Create sessions and overlays inside commands.
- Clean up in an idempotent `session_shutdown`: abort and dispose the sub-session, dismiss the overlay.
- Nested single model calls use `ctx.modelRegistry.streamSimple()` with `ctx.signal`; include `usage` in tool results.
- Tool `execute()` throws on failure. Result needs `content` and `details` (`details: undefined` if none).
- Truncate large output and say where the rest can be read.
- BTW thread data uses `pi.appendEntry` only. Visible notes (`pi.sendMessage`) only on explicit save, handoff or non-TUI fallback.
- Guard UI with `ctx.mode === "tui"`; use `ctx.hasUI` for dialogs.
- `ctx` from a command becomes invalid after session replacement; capture plain data first.
- `createAgentSession` and related APIs are internal-ish. Verify against `packages/coding-agent/src/core/extensions/types.ts` and the SDK exports of the installed Pi version before coding.
- Must not clash if `pi-btw` is also installed: different command names, shortcuts, message and entry types (use `wt-btw-*` types).

## Plan

### Phase 0: Foundation

- Check the installed Pi version exports `createAgentSession`, `SessionManager`, `buildSessionContext`, `ModelRuntime` and the `ResourceLoader` type; check built-in keybindings for `Alt+B` / `Ctrl+Alt+B` conflicts.
- Add `config.ts` (schema, defaults, global + trusted-project merge, atomic save).
- Add `transcript.ts` (branch to messages, BTW filtering, truncation).
- Add `llm.ts` (single call returning text + usage, abort and timeout).

### Phase 1: `advisor` (smaller, validates config/transcript/llm first)

- Register tool `wt-advisor` (TypeBox schema, description explaining when to call it).
- `execute()`: check model and call cap, build transcript, call model, return advice as `content` with `usage`.
- Register `/wt-advisor` to pick the model (from `ctx.modelRegistry`) and save it.
- `renderCall` / `renderResult`.

### Phase 2: `btw`

1. Sub-session core (`btw/session.ts`): resolve model (override or inherited, with auth fallback), build seed messages for context mode, custom `ResourceLoader` with capabilities block, create session with read-only allowlist, prompt queue, abort, dispose, generation guard.
2. State (`btw/state.ts`): hidden entries for thread, reset, mode, model/thinking; restore on `session_start` and `session_tree`; `context` handler filtering visible BTW messages.
3. Overlay (`btw/overlay.ts`): transcript with streaming text, thinking and tool activity from `session.subscribe`; composer; Esc abort then dismiss; `Alt+B` / `Ctrl+Alt+B` focus toggle; reopen with the current thread.
4. Commands: `/wt-btw`, `/wt-btw-context`, new, clear, model, thinking. Work while the main agent is busy.
5. Non-TUI fallback: inline question required; answer shown as a visible note.
6. Handoff (`btw/handoff.ts`): inject and summarize ask for confirmation, then `pi.sendUserMessage` (`followUp` when busy). Cancel keeps the thread. Summarize uses the BTW model with thinking off.

### Phase 3: Wrap-up

- Update `/wt-mode` into a status command.
- Add `packages/pi-wt/README.md`; update the root `README.md` package table (it still calls this package a placeholder).
- Bump `version` in `package.json`.

## Checklist

### Setup
- [x] Design decisions made and recorded here
- [x] Pi SDK exports and keybindings verified
- [x] Module layout created (foundation modules; feature modules follow in phases 1–2)
- [x] `config.ts` load/save/merge/validate
- [x] `transcript.ts`
- [x] `llm.ts` single call with abort, timeout and usage

### `advisor`
- [x] Tool `wt-advisor` registered with schema and description
- [x] Reads full transcript and calls the configured model once
- [x] Transcript truncation for long sessions
- [x] Returns `content`, `details` and `usage`; throws on failure
- [x] Guardrails: 3 calls per run, 120 s timeout, 4096 output tokens
- [x] Clear error when no model is configured
- [x] `/wt-advisor` persists the model to config
- [x] `/wt-advisor-thinking` persists thinking, inherits main when cleared, and exposes it in status/results
- [x] Custom `renderCall` / `renderResult`

### `btw`
- [x] Sub-session created with `SessionManager.inMemory`
- [x] `/wt-btw` contextless and `/wt-btw-context` seeded from the main branch
- [x] Custom `ResourceLoader` with capabilities block
- [x] Read-only tool allowlist (`read/grep/find/ls`) enforced structurally
- [x] Mode switch clears the previous thread
- [x] Prompt queue prevents overlapping turns; generation guard drops stale work
- [x] Works while the main agent is busy
- [x] Hidden thread entries persisted and restored (`session_start`, `session_tree`)
- [x] `context` handler filters visible BTW messages
- [x] Main session context verified unchanged
- [x] Overlay: streaming, tool activity, Esc abort then dismiss
- [x] `Alt+B` / `Ctrl+Alt+B` focus toggle, remappable in config
- [x] `/wt-btw-new`, `/wt-btw-clear`
- [x] `/wt-btw-model` and `/wt-btw-thinking` (with `clear`), persisted in config
- [x] Model override falls back to the main model without credentials
- [x] Inject / summarize ask for confirmation before sending
- [x] `--save` visible note
- [x] Non-TUI fallback
- [x] `session_shutdown` aborts and disposes everything idempotently
- [x] Error paths (no model, no auth, abort, empty question)

### Quality
- [x] Syntax check all files: `node --experimental-strip-types --check <file>.ts`
- [ ] Manual test in Pi: `pi -e ./packages/pi-wt`
- [x] No imports from other packages
- [x] Names/entry types/default shortcuts differ from `pi-btw` (custom user remaps can still collide)
- [x] `/wt-mode` status command updated
- [x] README and root package table updated
- [x] Version bumped

## Notes for agents

- Pi is a peer dependency and is not installed locally here. A global Pi installation can be used for verification without adding host packages to `dependencies`.
- A copy of `pi-btw` for reference can be fetched with `npm pack pi-btw`. Main logic is in `extensions/btw.ts`. Do not copy it wholesale; reuse the design.
- Update the checklist as work progresses.

### Phase 0 verification (2026-10-10)

- Installed global `@earendil-works/pi-coding-agent`: **1.1.0**. Verified runtime exports `createAgentSession`, `SessionManager`, `buildSessionContext`, `ModelRuntime`; `ResourceLoader` is a type-only export in `dist/index.d.ts`.
- SDK `CreateAgentSessionOptions.tools` is a **string name allowlist** in this version, e.g. `["read", "grep", "find", "ls"]`, not an array of tool objects. `modelRuntime` is supported for sharing the parent's provider/auth runtime.
- `Alt+B` conflicts with `tui.editor.cursorWordLeft` (default keys: `alt+left`, `ctrl+left`, `alt+b`). `Ctrl+Alt+B` has no built-in default conflict. Config retains the chosen primary/fallback; phase 2 should select the fallback when the primary conflicts with active keybindings.
- `config.ts`: nested schema validation; `null` clears a model/thinking override; global config plus trusted project overrides; atomic rename inside `withFileMutationQueue`. Save patches update only the selected scope, preserving concurrent changes. Missing/invalid JSON is ignored; filesystem errors remain actionable.
- `transcript.ts`: `branchMessages(..., "context")` is compaction-aware for BTW seeds. `"full"` includes pre-compaction history on the active branch for advisor while honoring context edits. `wt-btw-*` custom messages are removed; hidden custom entries never become model context. Advisor history is serialized as quoted text to avoid dangling tool calls after truncation. Images are represented by MIME placeholders; binary image data is omitted. If the first user message, newest message and question cannot fit, fail explicitly rather than silently drop them.
- `llm.ts`: one `ctx.modelRegistry.streamSimple()` request, no tools, returns text and usage. Context and caller signals both cancel; timeout also settles the caller if a provider ignores cancellation. Defaults: 120 s and 4096 output tokens.
- Validation: 10 foundation tests passed using Pi's bundled jiti and actual global SDK; strict TypeScript check passed against installed SDK declarations; syntax checks passed. After installing peers locally, run `pnpm --filter pi-wt test`.
- TUI/manual Pi testing remains pending for the feature phases; phase 0 does not register advisor or BTW commands yet.

### Phases 1–3 verification (2026-10-10)

- Implemented `advisor.ts`, `models.ts` and the five `btw/` modules; thin entry point registers 10 commands and `wt-advisor`. Package version is **0.2.0**.
- 29 automated tests pass: foundation, advisor concurrent cap/usage/configuration, BTW queue/restore/reset races, unavailable auth, non-TUI notes, confirmation and stale handoff protection, compaction/branch-summary filtering, overlay Esc/rendering and a real SDK sub-session with a mock provider.
- Strict TypeScript checking against installed Pi 1.1.0 declarations and syntax checks for every `.ts` file pass. No cross-package imports.
- CLI RPC smoke test passed using the actual bundled Pi CLI, isolated temporary configuration and a mock provider: discovered all 10 commands, invoked `/wt-btw`, and verified the visible answer note.
- BTW accesses Pi 1.1.0's private `ModelRegistry.runtime` bridge to share custom providers, virtual models and runtime credentials. It validates the bridge and throws clearly on incompatible hosts. Both unbundled SDK and bundled CLI paths were exercised.
- Completed exchanges persist as sanitized question/assistant-text pairs. Tool output and thinking remain transient; child reconstruction replays completed pairs. Config is resolved for every queued question, including inherited model/thinking changes.
- Saved/non-TUI notes are removed from both normal context and the compaction/tree-summary preparation arrays, preventing later summaries from pulling side content into main context.
- Terminal remaps are applied by a session-scoped input listener after checking effective built-in bindings; defaults select `Ctrl+Alt+B`. Listener and overlay cleanup are guarded against stale session setup. Model selection dialogs cannot save after shutdown.
- Manual TUI testing with a live provider remains pending. Automated rendering covered 25/60/100-column overlay widths; no paid model requests were used in verification.

### Global config bootstrap fix (2026-10-10)

- `session_start` now calls `ensureGlobalConfig()` before feature initialization, creating `~/.pi/agent/wt-mode.json` with all defaults when absent.
- Existing files, including invalid JSON, are preserved. Creation publishes a fully written temporary sibling with a no-replace hard link inside the shared file mutation queue; concurrent startup/save operations keep user settings.
- 31 tests pass, including bootstrap concurrency and preservation of existing/corrupt files. Strict TypeScript and syntax checks pass.

### Advisor thinking (2026-10-10)

- Added `advisor.thinkingLevel` and `/wt-advisor-thinking`; missing/null inherits the main level, and `clear` restores inheritance. Existing global files stay preserved; the command persists the new field.
- Nested advisor calls forward the requested reasoning level, with `off` handled by the single-call helper. `/wt-mode` shows the configuration and tool result headers show the requested level. Actual reasoning support depends on the model/provider.
- 34 tests pass, including thinking forwarding/inheritance/off, validation and trusted overrides, command save/clear/cancel and stale dialog protection. Strict TypeScript, syntax and diff whitespace checks pass. Live-provider/manual TUI verification remains pending.

### Model selector scrolling (2026-10-10)

- Pi 1.1.0's generic `ui.select()` renders all options without a scroll window, allowing model selection to leave the visible terminal area. TUI model commands now use a bounded `SelectList` component, retaining selection after terminal resize; RPC still uses `ui.select()`.
- Shared by `/wt-advisor` and `/wt-btw-model`. Regression checks cover navigating 80 models to the final item, shrinking the terminal, confirm/cancel and TUI command routing/save. Manual terminal verification remains pending.

### Model selector search (2026-10-10)

- Both TUI model selectors now include a focused single-line search input. Filter provider/model labels by case-insensitive substrings; all space-separated terms must match. Query changes reset selection, while terminal resize preserves the current filtered selection.
- Navigation/confirm/cancel use Pi selection keybindings; other input is routed to the search editor, including paste, Backspace and Ctrl+U. Empty results show a model-specific message and cannot confirm a model. RPC retains its standard host dialog.
- 37 tests and strict TypeScript checks pass, including query editing, multi-term filtering, empty results and resizing while filtered. Manual terminal verification remains pending.

### BTW command simplification (2026-10-11)

- Supersedes the historical plans/checklists above: BTW exposes only `/wt-btw`, `/wt-btw-clear`, `/wt-btw-config`. It always seeds from main context. Legacy reset entries restore into context mode.
- Config is a model-then-thinking flow; cancellation and stale dialogs save neither setting. Inline model+thinking arguments support non-UI hosts. Completed exchanges are retained when changing config.
- Removed handoff implementation and inject/summarize registrations. Existing `--save` visible notes remain excluded from main model context.
