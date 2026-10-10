# pi-wt-extensions

Custom extension packages for the [Pi coding agent](https://pi.dev).

This repository is a pnpm workspace: each directory under `packages/` is an independent, self-contained Pi package with its own version. Pi loads the TypeScript sources directly (jiti), so nothing needs to be built.

## Packages

| Package | Description |
| --- | --- |
| [`pi-wt-ui`](./packages/pi-wt-ui/README.md) | Interactive UI overhaul for the terminal: compact status bar, flat tool cards with diff preview, turn separators, welcome header, prompt editor label, user message marker, a live plan panel (`wt-ui-todo`) and a question dialog (`wt-ui-ask`), plus four dark themes: Catppuccin Mocha, Tokyo Night, Gruvbox Dark and Nord. |
| [`pi-wt-mode`](./packages/pi-wt-mode) | Placeholder for the `wt` mode. Registers a `/wt-mode` command that confirms the extension is loaded. |

## Install

Install a package permanently:

```sh
pi install ./packages/pi-wt-ui
```

Or try it for a single run without installing:

```sh
pi -e ./packages/pi-wt-ui
```

## Layout

```
.
├─ AGENTS.md              # repository guide and conventions for coding agents
├─ package.json           # private root, packageManager: pnpm
├─ pnpm-workspace.yaml    # packages: ["packages/*"]
└─ packages/
   ├─ pi-wt-ui/           # UI customization package (extensions + themes)
   └─ pi-wt-mode/         # wt mode package (placeholder)
```

## Development

- Pi is a peer dependency and is not installed in this workspace, so there is no type check or build step.
- Check the syntax of one file with `node --experimental-strip-types --check <file>.ts`.
- One extension per package. Packages never import each other; cross-package communication goes through `pi.events`.
- Command, tool and flag names are prefixed per package (`wt-ui-*`, `wt-mode-*`).

See [AGENTS.md](./AGENTS.md) for the full conventions.
