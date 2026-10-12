# pi-wt

Work Together for the [Pi coding agent](https://pi.dev): terminal UI, four dark themes, plan/question tools, context-aware BTW conversations and a model advisor in one package.

```sh
pi install ./packages/pi-wt
# or try for one session
pi -e ./packages/pi-wt
```

Pi loads TypeScript directly; no build step. Tested with Pi 1.1.0.

## Features

| Feature | Documentation |
| --- | --- |
| Status bar, tool cards/diffs, editor, welcome header, turn separators, plan and question tools, themes | [UI guide](./docs/ui.md) |
| BTW side threads with main context, read-only tools and saved exchanges | [BTW and advisor guide](./docs/mode.md#btw) |
| Model advisor, separate model/thinking settings and searchable model selectors | [Advisor guide](./docs/mode.md#advisor) |
| Plan mode: read-only investigation with a review gate (`/wt-plan`, `Alt+M`) | [Plan mode guide](./docs/plan.md) |

## Configuration

All features use one settings file: `~/.pi/agent/pi-wt-settings.json`, optionally overridden by project `.pi/pi-wt-settings.json`.

- `/wt-ui` reports the top-level UI flags in that file.
- `/wt-mode` reports its `btw`, `advisor` and `plan` sections. These sections use project overrides only when the project is trusted.
- `/wt-btw` opens the context-aware side thread; `/wt-btw-clear` resets it; `/wt-btw-config` configures model then thinking. Advisor commands remain `/wt-advisor` and `/wt-advisor-thinking`.

Missing global settings are created with UI and mode defaults at session start. Commands save model/thinking changes to this file while preserving UI flags. Reload after changing UI settings. See the [settings example](./docs/mode.md#configuration).

## Migrating from the separate packages

Replace installed local paths for `packages/pi-wt-ui` and `packages/pi-wt-mode` with `packages/pi-wt`. Existing Git resource filters must use `packages/pi-wt/extensions/index.ts`; root Git installs already declare this one entry point and all four themes. Remove old package registrations before loading the merged package to avoid duplicate commands and tools.

On session start, old `wt-mode.json` settings are imported into `pi-wt-settings.json` automatically. Existing fields in the unified file take precedence. The old file is renamed to `wt-mode.json.<id>.migrated.bak` after a successful atomic write and is no longer loaded. Trusted project settings migrate the same way; untrusted project files are left untouched. Invalid source/destination JSON blocks migration with an error and preserves both files.

## Development

```sh
pnpm --filter pi-wt test
```

Pi SDK packages are peer dependencies. Tests cover mode behavior and registration of UI/advisor tools through the combined entry point. See [AGENTS.md](./AGENTS.md) for module conventions.
