# pi-wt BTW and advisor

Context-aware side conversations and a model advisor in [pi-wt](../README.md) for the [Pi coding agent](https://pi.dev).

```sh
pi -e ./packages/pi-wt
# or install permanently
pi install ./packages/pi-wt
```

Tested with Pi 1.1.0. Sources load directly through Pi; no build step.

## Advisor

Choose a model with `/wt-advisor` (selector in TUI/RPC) or `/wt-advisor provider/model-id`. `/wt-advisor clear` disables it.

In TUI, model selectors show a search input and a bounded list that scrolls with the selection and adapts to terminal resizing. Type to filter by provider or model (case-insensitive substrings; space-separated terms must all match), use arrows to select, Enter to confirm and Esc to cancel. Backspace edits the query; Ctrl+U clears it with default keybindings. This also applies to the model step of `/wt-btw-config`. RPC uses the host's standard selection dialog.

Set advisor thinking with `/wt-advisor-thinking high` or open the selector with `/wt-advisor-thinking`. Levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `/wt-advisor-thinking clear` inherits the main agent's thinking level, also the default for older config files without this field. `/wt-mode` shows the setting; tool results show the requested level for each call. Supported reasoning behavior depends on the selected model/provider.

The main agent can call `wt-advisor({ question, focus? })` for a second opinion or review. Each call sends the full active branch transcript, including history before compaction, plus the question. Read relevant files before calling: the advisor has no tools. Large transcripts first cap tool results, then drop older messages while keeping the first user message and latest message. Images are represented by MIME placeholders rather than binary content.

Defaults: three calls per agent run, 120-second timeout, 4096 output tokens. Failed requests count toward the cap. The result includes nested usage; expand the tool result to read the full advice. Until a model is configured, the tool reports that it is unavailable.

## BTW

| Command | Action |
| --- | --- |
| `/wt-btw [question]` | Open or continue the side conversation with a snapshot of main-session context. |
| `/wt-btw-clear` | Clear the side conversation; the next question takes a fresh main-context snapshot. |
| `/wt-btw-config` | Choose a model in the searchable selector, then choose thinking. Cancelling either step leaves both settings unchanged. |
| `/wt-mode` | Show effective BTW/advisor model and thinking settings. |

`/wt-btw-config [provider/model-id\|clear] [level\|clear]` also accepts inline configuration. Without dialog UI both values are required, for example `/wt-btw-config clear high`. `clear` inherits the main model or thinking level respectively. Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Changes are saved together to the shared settings file; trusted project overrides still take precedence.

The side thread always uses main-session background when its child session is created. It continues across questions, and `/wt-btw-clear` starts a new thread with a fresh snapshot. The child has only `read`, `grep`, `find` and `ls`; it loads no extensions, skills, prompt templates or AGENTS files. It inherits the parent's system instructions with an explicit capability block.

Prompts are queued and can run while the main agent is working. The overlay is a fully bordered box at 90% of the terminal height. In it, Enter submits, Page Up/Down scroll long conversations (the bottom border shows how many lines are hidden above and below), and Esc aborts a running side prompt (including its queue); another Esc closes the overlay. By default `Alt+B` conflicts with Pi's word-left binding, so `Ctrl+Alt+B` moves focus between BTW and the main editor. Remap candidates in settings; if both conflict, reopen/focus with `/wt-btw`.

Completed exchanges are saved as hidden session entries and restored on session/branch changes. `/wt-btw --save <question>` writes a visible note, excluded from main context, compaction and branch summaries. In RPC/JSON/print mode, an inline question is required and replies appear as visible notes. BTW has no inject or summarize commands and does not send side content to the main agent.

A missing or unauthenticated BTW model override falls back to the main model. Model/thinking settings are resolved for each queued question. Completing the configuration flow cancels pending side work and preserves completed exchanges; the next question rebuilds the child with the current main context. Legacy contextless threads restore into context mode while retaining completed exchanges. Transient tool output and thinking are not persisted.

## Configuration

All UI and mode features use `~/.pi/agent/pi-wt-settings.json`. The extension creates it with complete defaults if absent. Commands save mode changes while preserving UI flags and other fields. Project overrides use `.pi/pi-wt-settings.json`; the `btw` and `advisor` sections apply only to trusted projects. Global command changes do not remove project overrides. Invalid JSON is ignored when loading, but migration/saves refuse to overwrite it. Writes are atomic.

Legacy `wt-mode.json` is imported at session start, with existing unified fields taking precedence. After a successful write it is renamed to `wt-mode.json.<id>.migrated.bak`, which is never loaded. Trusted project files migrate the same way.

```json
{
  "statusBar": true,
  "toolCards": true,
  "diffPreview": true,
  "turnSeparator": true,
  "editor": true,
  "todos": true,
  "ask": true,
  "welcome": true,
  "userMessage": true,
  "btw": {
    "model": null,
    "thinkingLevel": null,
    "focusShortcut": "alt+b",
    "fallbackShortcut": "ctrl+alt+b"
  },
  "advisor": {
    "model": { "provider": "your-provider", "id": "your-model-id" },
    "thinkingLevel": null,
    "maxCallsPerRun": 3,
    "timeoutMs": 120000,
    "maxOutputTokens": 4096
  }
}
```

Shortcut values support `ctrl`, `alt`, `shift` modifiers with a letter or digit. Reload Pi after changing shortcut settings. The package uses `wt-btw-*` entry/message names and `wt-advisor`, so its commands and state can coexist with `pi-btw` using their default shortcuts.

BTW shares the parent provider/auth runtime through the registry bridge present in Pi 1.1.0, preserving custom providers and virtual models. This bridge is internal; incompatible Pi versions produce an explicit error. Cleanup aborts and disposes the child on session shutdown, reload or replacement.

## Validation

After installing workspace peers:

```sh
pnpm --filter pi-wt test
```

Tests cover advisor limits/usage, prompt serialization, reset races, restoration, auth fallback, context/summary isolation, overlay input/rendering and a real SDK sub-session using a mock provider. Combined package tests verify one entry point, command/tool registration, advisor renderer delegation and bundled themes. The merged package was also loaded through Pi CLI RPC with all 8 commands registered once. Model/provider tests use mocks; live provider responses and manual terminal interaction remain to be checked in your setup.
