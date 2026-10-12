# pi-wt-extensions

Custom extension packages for the [Pi coding agent](https://pi.dev).

This repository is a pnpm workspace containing `pi-wt`, one package combining the Work Together UI, themes, BTW conversations and advisor. Pi loads TypeScript directly (jiti), so nothing needs to be built.

## Packages

| Package | Description |
| --- | --- |
| [`pi-wt`](./packages/pi-wt/README.md) | Terminal UI, compact tool cards/diffs, plan and question tools, four dark themes, context-aware BTW conversations and a model advisor with searchable model selectors. |

## Install

### From a local checkout

Install a package permanently:

```sh
pi install ./packages/pi-wt
```

Or try it for a single run without installing:

```sh
pi -e ./packages/pi-wt
```

### From GitHub

Install this repository as a package directly from GitHub:

```sh
pi install git:github.com/khoafullstack/pi-wt-extensions
# the HTTPS URL also works as a git source
pi install https://github.com/khoafullstack/pi-wt-extensions
```

Or try it for a single run:

```sh
pi -e git:github.com/khoafullstack/pi-wt-extensions
```

The root manifest declares one combined extension and all four `wt-*` themes. Existing resource filters in `~/.pi/agent/settings.json` or `.pi/settings.json` must use the merged entry point. Omitting `themes` keeps all themes:

```json
{
  "packages": [
    {
      "source": "git:github.com/khoafullstack/pi-wt-extensions",
      "extensions": ["packages/pi-wt/extensions/index.ts"]
    }
  ]
}
```

Git sources are pinned to the ref you installed; update the checkout later with `pi update git:github.com/khoafullstack/pi-wt-extensions`.

> Do not enable a local path and the `git:` source at the same time. Pi does not dedupe them and every extension registers twice.

When migrating from `pi-wt-ui` and `pi-wt-mode`, replace their local package paths with `packages/pi-wt` and remove old registrations. Commands are preserved. All features use `pi-wt-settings.json`; old `wt-mode.json` settings migrate automatically at session start, with the old file archived as a backup. See the [migration guide](./packages/pi-wt/README.md#migrating-from-the-separate-packages).

## Layout

```
.
├─ AGENTS.md              # repository guide and conventions for coding agents
├─ package.json           # private root, packageManager: pnpm
├─ pnpm-workspace.yaml    # packages: ["packages/*"]
└─ packages/
   └─ pi-wt/
      ├─ extensions/index.ts  # one entry point
      ├─ extensions/ui/       # terminal UI and tools
      ├─ extensions/mode/     # BTW and advisor
      ├─ themes/              # four dark themes
      ├─ tests/
      └─ docs/
```

## Development

- Pi SDK packages are peer dependencies. There is no build step.
- Check the syntax of one file with `node --experimental-strip-types --check <file>.ts`.
- One extension per package. Packages never import each other; cross-package communication goes through `pi.events`.
- Existing names remain `wt-ui-*`, `wt-btw-*` and `wt-advisor*`, with `/wt-ui` and `/wt-mode` status commands.
- Run `pnpm --filter pi-wt test` after installing peers.

See [AGENTS.md](./AGENTS.md) for the full conventions.
