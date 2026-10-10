# pi-wt-ui

A UI customization package for the [Pi coding agent](https://pi.dev). It replaces the default terminal look with a compact, flat style and adds two agent tools: a live plan panel and an interactive question dialog.

Every feature can be switched off with a `/wt-ui-*` command, and everything that draws to the terminal only runs in interactive (TUI) mode.

## Features

| Feature | What you get |
| --- | --- |
| Status bar | A footer with model, thinking level, context usage bar, session cost, git branch (with a dirty marker) and active tool count. Statuses set by other extensions stay visible on the right. |
| Compact tool cards | Each built-in tool call is one flat row: status icon, tool name, target, result summary and duration. Expand it to see the output. |
| Diffs | `edit` and `write` show a colored diff with a separate line-number gutter. `write` snapshots the previous file so overwrites show only what changed. |
| Turn separator | A short line after each agent run: turn number, time, duration, tool count, tokens and cost. |
| Welcome header | A banner (`Work Together by Eztek`) and a session line (folder, session tag, start time) in place of Pi's default logo. |
| Prompt editor | The input box gets a `wt ❯` label on its top border and a hint line underneath. All Pi key bindings keep working. |
| User message marker | User messages start with `❯` and continuation lines are aligned under the text. Display only, the model never sees it. |
| Plan panel | The `wt-ui-todo` tool lets the agent keep a step-by-step plan that is shown live above the editor. |
| Ask dialog | The `wt-ui-ask` tool lets the agent ask one to four multiple-choice questions, with optional examples shown in a side note. |
| Themes | Four dark themes built from official palettes: Catppuccin Mocha, Tokyo Night, Gruvbox Dark and Nord. |

## Install

From this repository:

```sh
pi install ./packages/pi-wt-ui
```

Or try it for a single run without installing:

```sh
pi -e ./packages/pi-wt-ui
```

Pi loads the TypeScript sources directly, so there is no build step.

## Themes

Open `/settings`, choose **Theme**, and pick one of:

- `wt-catppuccin-mocha`
- `wt-tokyo-night`
- `wt-gruvbox-dark`
- `wt-nord`

You can also start Pi with a theme for one run: `pi --use-theme wt-nord`.

The `wt-*` themes use the terminal's default background for user messages, so they appear flat like the tool cards. Other themes keep their own user message background.

## Commands

All toggles accept `on` or `off`. Without an argument they flip the current state.

| Command | Effect |
| --- | --- |
| `/wt-ui` | Show which features are on. |
| `/wt-ui-statusbar [on\|off]` | Custom footer. Off restores Pi's default footer. |
| `/wt-ui-tools [on\|off]` | Compact tool cards. Applies to new tool calls. |
| `/wt-ui-diff [on\|off]` | Diff preview on collapsed `edit` and `write` cards. Expanding still shows the diff. |
| `/wt-ui-turns [on\|off]` | Turn separator lines. |
| `/wt-ui-welcome [on\|off]` | Welcome header. Off restores Pi's default header. |
| `/wt-ui-editor [on\|off]` | Prompt editor label and hint line. |
| `/wt-ui-user [on\|off]` | `❯` marker on user messages. Run `/reload` to redraw old messages. |
| `/wt-ui-todos [on\|off\|clear]` | Plan panel. `clear` only hides the current plan, it does not write to the session. |
| `/wt-ui-ask [on\|off\|demo]` | Enables or disables the `wt-ui-ask` tool. `demo` opens a sample dialog without a model. |

## Agent tools

### `wt-ui-todo`

Keeps a plan that follows the active session branch.

| Action | Parameters | Effect |
| --- | --- | --- |
| `set` | `items: [{ text, status? }]` | Replace the whole plan. |
| `update` | `id`, `status` | Change one step. Status is `pending`, `in_progress` or `done`. |
| `clear` | none | Remove the plan. |

### `wt-ui-ask`

Asks the user one to four questions in an interactive dialog.

- Each question has a `prompt`, a list of `options` and optional `multiple` and `allowOther` flags.
- Each option has a `label` and may have a one-line `description` and an `example`. Examples keep line breaks and indentation (for file trees or snippets) and are cut at 400 characters or 12 lines.
- With the terminal at least 84 columns wide, the example of the highlighted option appears in a right-hand column. On narrower terminals it appears under the list.
- The user can always type their own answer unless `allowOther` is `false`.
- In RPC mode the tool falls back to simple select and input dialogs (single choice only). Without any UI it fails and the agent should ask in plain text.

## Limitations

- The `❯` marker and the turn separator cannot be colored on their own. The marker uses the theme's user message text color.
- The welcome header scrolls away with the transcript, because Pi attaches headers to the top of it.
- Pi allows one markdown transformer per extension, which this package uses for the `❯` marker.
- Tool cards cover Pi's built-in tools and this package's own tools. Other custom and MCP tools keep their own renderers.

## Development

Pi is a peer dependency and is not installed in this workspace, so there is no type check. To check syntax:

```sh
node --experimental-strip-types --check extensions/<file>.ts
```

Run `/reload` inside Pi after changing a file. See [AGENTS.md](./AGENTS.md) for the code layout and conventions.

## License

Theme colors come from the official Catppuccin, Tokyo Night, Gruvbox and Nord palettes, which are MIT licensed.
