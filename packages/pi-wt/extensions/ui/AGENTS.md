# pi-wt UI modules

UI modules within the merged `pi-wt` package. Follow package `../../AGENTS.md` and repository `../../../../AGENTS.md`. User documentation is in `../../docs/ui.md`.

## Layout

```
extensions/ui/
   ├─ AGENTS.md          # this guide; themes live at ../../themes/
   ├─ index.ts           # registerUi(): modules and /wt-ui, called by ../index.ts
   ├─ status-bar.ts      # footer
   ├─ tool-cards.ts      # compact tool renderer and diff preview
   ├─ write-diff.ts      # snapshot and line diff for the write tool
   ├─ turn-separator.ts  # per-run separator entry and its renderer
   ├─ welcome.ts         # startup header
   ├─ prompt-editor.ts   # editor subclass and hint widget
   ├─ user-message.ts    # markdown transformer for user messages
   ├─ todo-panel.ts      # wt-ui-todo tool and panel widget
   ├─ ask-user.ts        # wt-ui-ask tool and dialog
   ├─ settings.ts        # compatibility re-exports from ../settings.ts for initial UI flags
   └─ session-info.ts    # shared helpers (turn count, time, token and duration formatting)
```

## Module responsibilities

Each module exports one `registerX(pi)` function that returns a small handle (for example `{ isEnabled() }`). `registerUi()` calls them all and reports their state from `/wt-ui`. A module owns its own enabled flag (read from the settings file) and its own cleanup.

| Module | Pi API used | Notes |
| --- | --- | --- |
| `status-bar.ts` | `ctx.ui.setFooter`, `footerData` | Reads `footerData.getExtensionStatuses()` and renders other extensions' statuses at the right end. Without that, replacing the footer would hide them. |
| `tool-cards.ts` | `pi.registerToolRenderer`, `tool_call` | `renderShell: "self"` removes the boxed background. The set of carded tools is the built-ins plus `wt-ui-todo`, `wt-ui-ask` and `wt-advisor`. Everything else goes through `next()`. |
| `write-diff.ts` | `tool_call` | Captures the old file content before `write` runs, keyed by tool call id. Diffs are line based with 2 lines of context. CRLF and LF are treated as equal. |
| `turn-separator.ts` | `agent_end`, `pi.appendEntry`, `pi.registerEntryRenderer` | One entry per agent run, not per model turn. The entry is stored in the session but never sent to the model. |
| `welcome.ts` | `ctx.ui.setHeader` | Banner and session line. Reads `pi.getSessionName()` at render time and redraws on `session_info_changed`. |
| `prompt-editor.ts` | `ctx.ui.setEditorComponent`, `ctx.ui.setWidget` | `WtEditor` extends `CustomEditor`. Only a plain `─` top border is replaced, so borders that carry scroll indicators stay intact. The hint is a `belowEditor` widget. |
| `user-message.ts` | `pi.registerMarkdownTransformer` | Display only. Lines that start Markdown blocks are left alone. |
| `todo-panel.ts` | `pi.registerTool`, `ctx.ui.setWidget` | State lives in tool result `details` and is rebuilt from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`. |
| `ask-user.ts` | `pi.registerTool`, `ctx.ui.custom` | Full dialog in TUI mode, `select`/`input` fallback in other UI modes. `runQuestionnaire` is shared by the tool and the `demo` command. |

## Conventions

- Names are prefixed with `wt-ui-`: commands, tools and widget keys.
- Features are switched on or off through the shared `../settings.ts` (`~/.pi/agent/pi-wt-settings.json`, then `<cwd>/.pi/pi-wt-settings.json`). Each module sets its flag from `loadSettings(ctx.cwd)` in its own `session_start` handler. The package entry point initializes/migrates settings before module handlers. UI flags are top-level alongside the `btw`/`advisor` sections. A new UI feature needs a key in `WtSettings` and `DEFAULT_SETTINGS`.
- Anything that draws to the terminal runs only when `ctx.mode === "tui"`. Dialogs use `ctx.hasUI`. Tool and event logic stays independent of rendering.
- Do not start timers, processes or listeners in the factory. Start them in `session_start` or in the command that needs them, and clean up in an idempotent `session_shutdown`.
- Host packages (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are `peerDependencies` with `"*"`, never `dependencies`.
- Confirm API signatures against installed SDK types or `packages/coding-agent/src/core/extensions/types.ts` in https://github.com/earendil-works/pi before using them. A global Pi installation can be used for verification when peers are not installed locally.
- Comments explain a hidden constraint, never what the code does.
- Everything in the repository is in English: documentation, comments, command descriptions and `ctx.ui.notify` messages.

## Rendering rules and pitfalls

- Every rendered line must fit the width. Use `truncateToWidth`, `visibleWidth` and `wrapTextWithAnsi` from `@earendil-works/pi-tui`. Never measure with `string.length`.
- Do not call `context.invalidate()` synchronously inside `renderResult`. It re-enters Pi's `updateDisplay` and appends the result component twice (the diff appeared duplicated). `tool-cards.ts` defers it with `queueMicrotask`.
- The tool card header and body are separate components. The header learns the outcome through shared per-call `state`.
- Never keep ANSI-colored strings in long-lived state. Compute colors at render time from the `theme` passed in, or rebuild them in `invalidate()`.
- `ctx.ui.setHeader` content is the top of the transcript and scrolls away. Use a widget for anything that must stay on screen.
- Pi allows one markdown transformer per extension. Do not add a second `registerMarkdownTransformer` call in this package.
- Markdown strips leading ordinary spaces on continuation lines. `user-message.ts` uses non-breaking spaces for the hanging indent.
- Session entries added with `pi.appendEntry` are stored but not sent to the model. Use `pi.sendMessage` only when the model should see the content.
- Tool state that must follow the active branch belongs in tool result `details`, not in module variables alone.

## Themes

- Theme files follow Pi's `theme.schema.json`. Objects are strict: only documented tokens are accepted, and custom keys belong in `vars`.
- Colors are named in `vars` and referenced from `colors`, so each palette is easy to compare with its upstream definition.
- `userMessageBg` is an empty string (terminal default background) in all four themes. This keeps user messages flat like the tool cards.
- Tool pending, success and error backgrounds are the page background mixed with blue, green and red at 10 to 14 percent.
- A theme must define every required token in the schema. Optional tokens fall back as documented.

## Editing and verifying

- Syntax check one file from the package directory: `node --experimental-strip-types --check extensions/ui/<file>.ts`.
- Validate a theme: parse it as JSON and confirm all required `colors` keys exist and every reference resolves in `vars`.
- Real behavior needs Pi itself: run `pi -e ./packages/pi-wt`, then `/reload` after each change.
- Write files as UTF-8 without a byte order mark. PowerShell 5.1 `Set-Content -Encoding utf8` adds a BOM, which can break JSON parsers. Use the editor tools or `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`.

## Adding a feature

1. Create `extensions/ui/<feature>.ts` that exports `register<Feature>(pi)` and returns `{ isEnabled() }`.
2. Add a key to `WtSettings` and `DEFAULT_SETTINGS`, and read it in the module's `session_start` handler. Guard drawing with `ctx.mode === "tui"`.
3. Call it from `extensions/ui/index.ts` and add its state to the `/wt-ui` report.
4. If it adds a tool, add the tool name to `CARD_TOOLS` and `LABELS` in `tool-cards.ts`, and handle it in `target()` and `summarize()`. Keep the tool's own `renderCall` and `renderResult` as the fallback when `toolCards` is `false`.
5. Add any new peer dependency to `package.json`.
6. Update `README.md` (features, commands) and the layout and module tables in this file.
