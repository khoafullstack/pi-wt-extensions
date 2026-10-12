# Pi Extensions Guide

Source: https://pi.dev/docs/latest/extensions

Extensions are TypeScript modules that add executable behavior to Pi (tools, commands, event handlers, providers, session state, TUI). They run in the Pi process with full OS permissions, so only load trusted ones.

## Create and load

An extension default-exports a factory receiving `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

- Location: `~/.pi/agent/extensions/hello.ts` (user) or project extensions dir. Pi loads single `.ts`/`.js` files and subdirectories with `index.ts`/`index.js`.
- Dev: `pi --extension ./hello.ts`. Pi uses `jiti`, so no compile step.
- npm deps: put a `package.json` nearby. Distribute via Pi packages.
- Only personal and CLI extensions can take part in the `project_trust` event.
- `await ctx.reload()` replaces the runtime; don't reuse old state afterward.

## Lifecycle rules

- Factory may be sync or async (Pi awaits it).
- Do NOT start processes, sockets, watchers, or timers in the factory. Start them in `session_start` or in the command/tool that needs them.
- Clean up in an idempotent `session_shutdown` handler.
- Flow: input -> `before_agent_start` -> model/message/tool events -> `agent_end`.
- `agent_before_settle`: last actionable boundary (can append entries, request one continuation). `agent_settled`: notification only.

## Integration points

| Need | API |
| --- | --- |
| Lifecycle events | `pi.on()` (returns unsubscribe fn) |
| Model-callable tool | `pi.registerTool()` |
| `/` command | `pi.registerCommand()` |
| Shortcut / CLI flag | `pi.registerShortcut()` / `pi.registerFlag()` |
| Send messages | `pi.sendUserMessage()` / `pi.sendMessage()` |
| Persist non-context data | `pi.appendEntry()` |
| Active tools/model/thinking | session control methods on `pi` (`setActiveTools`, `getActiveTools`, `getAllTools`) |
| Model provider | `pi.registerProvider()` |
| MCP server | `pi.registerMcpServer()` / `pi.unregisterMcpServer()` |
| Route requests to model | `pi.registerVirtualModel()` |
| Terminal UI | renderer registration and `ctx.ui` |
| Inter-extension comms | `pi.events` |

Exact types: `packages/coding-agent/src/core/extensions/types.ts` in https://github.com/earendil-works/pi

## Events

- Handlers run in load/registration order. Some only notify; others transform or cancel. Follow each event's declared result type.
- `before_agent_start`: has prompt and `systemPromptOptions`. Prefer changing sections/tools/guidelines. Returning `systemPrompt` or `forceSystemPrompt` replaces the whole prompt for that run.
- `message_end`: can replace a finalized message (role preserved).
- `tool_call`: can mutate input or block (`return { block: true, reason }`). A handler failure blocks the tool.
- `tool_result`: handlers compose. If redacting `content`, also replace `structuredContent`.
- `context`: transforms messages. `context_with_system` only when you must own the full transcript (keep system message at index 0).
- `turn_end` / `agent_before_settle`: can return proposed `custom`, `custom_message`, `context_edit`, `compaction` entries and `continue: true`. Guard against infinite loops.
- `provider_stream_event`: read-only, notification only, awaited in order (slow handlers delay streaming).
- `cache_warming_decision`: return `{ action: "warm" | "stop" }`; last wins.
- `user_bash`: returning `undefined` passes through; returning `operations` or `result` stops propagation; failure blocks the command.
- Tool calls from one assistant message may run in parallel; don't assume siblings exist. Use `ctx.signal` for nested work.

## Tools

`pi.registerTool()` takes: name, model-facing description, TypeBox parameter schema, `execute()`.

- Result needs `content` (model-facing) and `details` (use `details: undefined` if none).
- Throw from `execute()` to signal failure; returning an object is not an error (unless `isError: true`).
- `terminate: true` skips automatic follow-up only if every tool in the batch agrees.
- Include `usage` for nested model calls.
- Shared mutable state -> sequential execution. File mutations -> wrap read-modify-write in `withFileMutationQueue()`.
- Truncate large output and tell the model where to read the rest.
- `outputSchema` + `structuredContent` for data results (for codemode scripts).
- `ctx.executeTool(name, args, { signal, onUpdate })` runs other tools (goes through validation and `tool_call`/`tool_result` handlers). `ctx.tools` lists callable ones.
- Examples: `hello.ts`, `todo.ts`, `dynamic-tools.ts`, `truncated-tool.ts` in `packages/coding-agent/examples/extensions`.

### Exposure

- `direct` (default): declared to model while active.
- `model-only`: declared, never callable by other tools.
- `codemode`: callable when registered, listed by `codemode`, not declared unless activated.
- `deferred`: like codemode but found/activated via `tool_search`.
- `hidden`: unreachable; re-register with this to withdraw (tools can't be unregistered).
- `namespace: { name, description, instructions }` groups tools.
- `annotations`: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (MCP semantics), usable by permission extensions.
- `prepareLoadout(loadout)` lets an orchestrating tool adjust descriptions / `hiddenDeclarations`.
- Dynamic activation: register all tools, then `pi.setActiveTools([...])` (unknown names ignored).
- Rendering: tool `renderCall`/`renderResult`; global `pi.registerToolRenderer((toolName, next) => renderers)`.

## MCP

```ts
pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira", exposure: "codemode" });
pi.unregisterMcpServer("jira");
```

Config matches `mcp.json` entries (`command/args/env/cwd` or `url/headers/oauth`, plus `exposure`, `toolExposure`, `description`, `enabled`, `timeout`). Registrations are not saved; re-register on every load. `mcp.json` wins on same name.

## Context and sessions

- `ExtensionContext` (`ctx`): cwd, mode, UI, `sessionManager`, `modelRegistry`, signal, context usage, compaction/shutdown controls. Use `ctx.modelRegistry.streamSimple()` for nested model calls.
- `ExtensionCommandContext` (commands only) adds wait-for-idle, reload, tree navigation, session replacement. Don't call these from lifecycle handlers (deadlock risk).
- After session replacement the old ctx is invalid: capture plain data first, use the fresh ctx from `withSession`.

## State storage

| State | Storage |
| --- | --- |
| Follows active branch | tool-result `details` |
| Durable, not in model context | `pi.appendEntry()` |
| Stored and sent to model | `pi.sendMessage()` |
| Outside one session | external storage |

Rebuild branch state from `ctx.sessionManager.getBranch()` in `session_start`. Register entry/message renderers to show custom content in the transcript.

## UI and modes

- `ctx.ui`: dialogs (`confirm`, `notify`), status, widgets, titles, editor, `ctx.ui.custom()` (only for custom rendering/input).
- Modes: interactive (full TUI), RPC (dialogs/notifications only), JSON and print (no UI).
- Guard terminal-only code with `ctx.mode === "tui"`; use `ctx.hasUI` for dialogs. Keep tool/event logic independent of rendering.

## Errors and cleanup

- Handler errors are reported and Pi continues; `tool_call` failure blocks the tool; tool failure becomes an error result.
- Cleanup in `session_shutdown`, idempotent. `ctx.shutdown()` requests orderly exit.

## Related docs

- Examples: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions
- Custom providers: https://pi.dev/docs/latest/custom-provider
- Terminal UI: https://pi.dev/docs/latest/tui
- Packages: https://pi.dev/docs/latest/packages
- Virtual models: https://pi.dev/docs/latest/virtual-models
- MCP: https://pi.dev/docs/latest/mcp

## Multi-package layout (this repo)

pnpm workspace; each extension is an independent Pi package under `packages/`.

```
pi-custom/
├─ package.json            # private, packageManager: pnpm
├─ pnpm-workspace.yaml     # packages: ["packages/*"]
└─ packages/
   └─ pi-wt/               # combined UI, BTW/advisor and themes; one extensions/index.ts
```

Rules:
- One extension per package. No imports between packages; use `pi.events` for runtime communication. If code must be shared, create `libs/<name>` and depend on it with `workspace:^` (include it in the published tarball).
- Each `package.json` has the `pi-package` keyword and `"pi": { "extensions": ["./extensions/index.ts"] }`.
- Host packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) go in `peerDependencies` with `"*"`, never in `dependencies`. Declare only the dependencies each package really uses.
- No build step: Pi loads `.ts` through jiti.
- Prefix command, tool, flag, and skill names per package to avoid collisions. The merged `pi-wt` preserves the user-approved `wt-ui-*`, `wt-btw-*`, `wt-advisor*`, `/wt-ui` and `/wt-mode` names.
- Each package keeps its own version.
- Install/try one package: `pi install ./packages/pi-wt` or `pi -e ./packages/pi-wt`. Git sources can filter with `"extensions": ["packages/pi-wt/extensions/index.ts"]`.
- Never enable a local path and a `git:` package pointing at the same content at once; Pi does not dedupe across them and everything registers twice.
- Run a script in one package: `pnpm --filter pi-wt <script>`.
