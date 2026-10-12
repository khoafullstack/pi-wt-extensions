# pi-wt plan mode

A read-only investigation mode in [pi-wt](../README.md). The agent explores the codebase and writes a plan, then stops at a review gate. Nothing is implemented until you confirm.

## Use

| Action | How |
| --- | --- |
| Toggle | `/wt-plan` or `Alt+M` |
| Turn on or off explicitly | `/wt-plan on`, `/wt-plan off` |
| Show state and shortcut | `/wt-plan status` |

While plan mode is on and the `editor` UI flag is on, the prompt editor's top border reads `─ wt ❯ PLAN ───`. The status bar shows nothing for plan mode. The editor learns the state from the `wt-plan:changed` event on `pi.events`.

## What it does

- **Prompt:** adds guidelines that forbid changing files and bash commands that change files or repository state, and tell the agent to end its turn with the plan.
- **Code guard:** blocks the `write` and `edit` tools, including calls made from codemode scripts. Bash is restrained only through the prompt.
- **Review gate:** after a plan turn ends normally, a notice appears under the plan. The notice is a session entry and never reaches the model. Aborted or failed runs do not open the gate.
- **Leaving plan mode:**
  1. Turn it off yourself with `/wt-plan` or `Alt+M`, then send a message to start implementing. The next run is told to create a checklist first.
  2. Or reply with a confirmation while plan mode is still on. The agent then calls `wt-plan-off` and creates the checklist itself.
- **Checklist:** before changing any file, the agent calls `wt-ui-todo` (action `set`) with one item per plan step. This is a prompt instruction, not a hard guard.

## `wt-plan-off`

Model-callable tool that leaves plan mode. It is declared to the model only while plan mode is on. The call is refused (by the tool and by a `tool_call` guard) unless a plan turn ended and you then typed a message of your own. Slash commands and messages sent by extensions do not count as confirmation. A later plan turn resets the confirmation, so a request for changes cannot be mistaken for approval.

## State

Plan mode state (on or off, and whether the gate was shown) is stored as hidden session entries and restored on session start and tree navigation, so it follows the active branch. A restored session keeps its gate.

## Configuration

```json
{ "plan": { "shortcut": "alt+m" } }
```

The shortcut accepts `ctrl`, `alt` and `shift` modifiers plus one letter or digit. If it conflicts with a Pi binding, a warning appears and `/wt-plan` still works. The `plan` section follows the same project trust rules as `btw` and `advisor`. Reload Pi after changing the shortcut.
