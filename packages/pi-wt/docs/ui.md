# pi-wt UI

The UI modules of [pi-wt](../README.md) for the [Pi coding agent](https://pi.dev). They replace the default terminal look with a compact, flat style and add two agent tools: a live plan panel and an interactive question dialog.

Every feature can be switched off in a JSON settings file, and everything that draws to the terminal only runs in interactive (TUI) mode.

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
pi install ./packages/pi-wt
```

Or try it for a single run without installing:

```sh
pi -e ./packages/pi-wt
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

## Settings

Features are switched on or off with a JSON file. Two locations are read, and the later one wins:

1. `~/.pi/agent/pi-wt-settings.json` (all projects)
2. `<cwd>/.pi/pi-wt-settings.json` (this workspace)

On first run the global file is created with UI flags and BTW/advisor defaults. The same file contains `btw` and `advisor` sections; see the [full settings example](./mode.md#configuration). A project file can be added for overrides, or created by migration from a trusted legacy `.pi/wt-mode.json`.

```json
{
  "statusBar": true,
  "toolCards": true,
  "diffPreview": true,
  "turnSeparator": true,
  "editor": true,
  "todos": true,
  "ask": true,
  "welcome": false,
  "userMessage": true
}
```

| Key | Feature |
| --- | --- |
| `statusBar` | Custom footer. |
| `toolCards` | Compact tool cards. |
| `diffPreview` | Diff preview on collapsed `edit` and `write` cards. Expanding still shows the diff. |
| `turnSeparator` | Separator line after each agent run. |
| `editor` | Prompt editor label and hint line. |
| `todos` | Plan panel. |
| `ask` | The `wt-ui-ask` tool. When `false` it is removed from the active tools. |
| `welcome` | Welcome header. |
| `userMessage` | `❯` marker on user messages. |

Every UI key is optional and defaults to `true`. `btw` and `advisor` are valid mode sections. Other unknown keys and non-boolean UI values are ignored with a warning. UI flags are read at session start, so run `/reload` after editing.

## Commands

| Command | Effect |
| --- | --- |
| `/wt-ui` | Show the settings file paths and which features are on. |
| `/wt-ui-ask-demo` | Open a sample ask dialog without a model. |
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
- Tool cards cover Pi's built-in tools and the UI tools (`wt-ui-todo`, `wt-ui-ask`), `wt-advisor`, Pi's `codemode`, every MCP server tool (names starting with `mcp__`) and the MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`). MCP cards show `server/tool` plus its arguments (Context7 shows the library name, or the library id and query), a 3-line output preview that expands to 30 lines, and resource listings as counts with per-server errors. The `codemode` card lists the nested calls live while the script runs (last 8 collapsed, all expanded), then the script output; expanding also shows the highlighted script and nested call errors. Other custom tools and MCP tools keep their own renderers. With `toolCards` off, the advisor falls back to its own renderer.

## Development

Pi is a peer dependency. To check syntax from the package directory:

```sh
node --experimental-strip-types --check extensions/ui/<file>.ts
```

Run `/reload` inside Pi after changing a file. See the [UI module guide](../extensions/ui/AGENTS.md) for code layout and conventions.

## License

Theme colors come from the official Catppuccin, Tokyo Night, Gruvbox and Nord palettes, which are MIT licensed.
