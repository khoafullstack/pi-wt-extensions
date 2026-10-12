# pi-wt

One Pi package combining Work Together's UI, BTW side conversations and advisor. Follow repository `../../AGENTS.md` and the module guides in `extensions/ui/AGENTS.md` and `extensions/mode/AGENTS.md`.

## Layout

- `extensions/index.ts`: the only manifest entry point, registering UI before mode features.
- `extensions/settings.ts`: shared settings schema, paths, atomic writes and legacy migration; initialization runs before module session handlers.
- `extensions/ui/`: UI modules and `registerUi()`; existing UI settings and names are preserved.
- `extensions/mode/`: BTW/advisor modules and `registerMode()`; existing mode config and names are preserved.
- `extensions/plan/`: plan mode and `registerPlan()`. `state.ts` (state, persistence, review-gate flags), `prompt.ts` (guidelines), `gate.ts` (gate entry renderer), `off-tool.ts` (`wt-plan-off`), `index.ts` (`/wt-plan`, shortcut, `tool_call` guard, events). See `docs/plan.md`.
- `themes/`: four bundled dark themes.
- `tests/`: foundation, mode features and combined package integration tests.
- `docs/ui.md`, `docs/mode.md`: detailed user documentation.

## Compatibility

- Keep commands/tools named `wt-ui-*`, `wt-btw-*`, `wt-advisor*`, plus `/wt-ui` and `/wt-mode`. The user authorized merging packages without renaming these interfaces.
- All features use `~/.pi/agent/pi-wt-settings.json` and optional project `.pi/pi-wt-settings.json`. UI flags stay top-level; mode sections are `btw` and `advisor`. Project mode sections and legacy project migration require trust. Legacy `wt-mode.json` migrates once and is archived as a backup.
- BTW commands are `/wt-btw` (always main context), `/wt-btw-clear` and `/wt-btw-config` (model then thinking, saved together). Older context/new/model/thinking/inject/summarize commands have been removed by user request; no compatibility aliases.
- Plan mode adds `/wt-plan`, the `wt-plan-off` tool (declared to the model only while plan mode is on) and a `plan.shortcut` setting (default `alt+m`). It blocks `write` and `edit` in code and restrains bash through the prompt only, by user decision. `wt-plan-off` is refused until a plan turn ended and the user typed a non-command message afterwards. The checklist step uses `wt-ui-todo` and is a prompt instruction, not a guard. `wt-plan-off` has a UI card (label `mode`).
- Both the root and package manifests load only `extensions/index.ts`. Module entry points export named registration functions; they are not separate extensions.
- UI tool cards also render every `mcp__*` tool and the MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`).
- UI tool cards also render Pi's `codemode` tool (nested calls live, output preview, expandable script).
- UI tool cards also render `wt-advisor` (label `advice`, model/thinking in the header, wrapped advice preview). The advisor's own `renderCall`/`renderResult` remain the fallback when `toolCards` is off. Only UI registers a markdown transformer.
- Host SDK dependencies remain peers with `"*"`; TypeScript loads through jiti without a build.
- Run `pnpm --filter pi-wt test` after installing peers. Validate syntax with `node --experimental-strip-types --check` and exercise the combined entry point when changing registration or lifecycle behavior.

## Merge verification (2026-10-11)

- Merged `pi-wt-ui` and `pi-wt-mode` into `pi-wt` version 0.3.0. Module imports stay within this package; root and leaf manifests each declare one combined extension and four themes.
- 39 tests pass through the installed Pi 1.1.0 SDK and jiti, including combined registration, UI renderer delegation, manifest paths and theme presence. Strict TypeScript and syntax checks pass across all modules and tests.
- Bundled Pi CLI RPC smoke test with isolated temporary configuration discovers all 13 commands exactly once. `npm pack --dry-run` includes the full module tree, themes, documentation and tests.
- Existing command names and JSON config paths are retained. Old local package registrations and Git resource filters must be updated to the new path. No global installation settings were changed during the merge.
- Live provider requests and manual terminal interaction remain untested for the merged package.

## Unified settings verification (2026-10-11)

- Version 0.4.0 uses one `pi-wt-settings.json` per scope, with top-level UI flags plus `btw` and `advisor`. `ui/settings.ts` and `mode/config.ts` re-export the shared `extensions/settings.ts` API.
- The first session-start handler initializes global defaults and migrates legacy mode settings before UI/mode handlers run. Canonical fields win over imported fields; successful migration archives the exact legacy source to a unique `.migrated.bak` file. Trusted project migration stays sparse, preserving inheritance.
- Mode writes preserve unrelated fields and UI flags. Loading tolerates corrupt JSON; migration and saves reject corrupt destinations to avoid erasing UI settings. Invalid legacy JSON is preserved and reported.
- 44 tests pass, covering migration/idempotence/backup, project trust/inheritance, concurrent writes and corrupt-file preservation. Strict TypeScript, syntax and whitespace checks pass. Bundled CLI RPC verifies startup migration and saving advisor thinking without losing disabled UI flags.
- The user's global files were migrated using the shared API and all existing UI/model/thinking values were verified. `wt-mode.json` is now an archived backup; only `pi-wt-settings.json` is active.

## BTW simplification verification (2026-10-11)

- Version 0.5.0 exposes only `/wt-btw`, `/wt-btw-clear`, `/wt-btw-config` for BTW. The side session always seeds from main context. Old contextless resets restore as context mode while retaining completed exchanges.
- Configuration selects model then thinking and commits once after both steps. Cancellation/stale dialogs do not save. Inline model+thinking arguments support non-UI hosts; successful changes cancel pending work and retain completed exchanges.
- Removed inject/summarize code and commands. Optional saved/non-TUI notes remain excluded from main context and summaries.
- 45 tests pass, including configuration order/cancellation, stale dialog protection, context restoration and fresh context after clear. Strict TypeScript and syntax checks pass. Bundled CLI RPC discovers exactly 8 package commands and verifies combined BTW config saves preserve UI/advisor settings. Manual TUI verification remains pending.

## Plan mode (2026-10-12)

- Version 0.6.0 adds `extensions/plan/`. Plan mode state is stored as hidden `wt-plan-state` entries and rebuilt on `session_start` and `session_tree`; the review gate is a `wt-plan-gate` entry that never reaches the model.
- Node strip-only mode rejects TypeScript parameter properties, so classes declare fields explicitly.
- 9 plan tests pass (gate, confirmation rules, restore, guards, settings) and the combined registration test lists `/wt-plan` and `wt-plan-off`. Strict type check of all extensions and tests passes (`tsc --noEmit --strict --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck`) after annotating `BodyLine[]` in `summarizeMcpOutput` and typing two test callbacks.
- Manual TUI verification of the `Alt+M` listener, status badge and live-provider behavior remains pending. `Alt+M` has no match in the installed Pi 1.1.0 or pi-tui default bindings.
- Plan mode feedback: the prompt editor border shows `PLAN` after `wt ❯` (no status-bar badge). Plan emits `wt-plan:changed` on `pi.events`; `ui/prompt-editor.ts` subscribes in `session_start` and unsubscribes on shutdown. 68 tests pass.
