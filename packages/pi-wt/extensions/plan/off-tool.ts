import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { offToolResult } from "./prompt.ts";
import { PLAN_OFF_TOOL, TODO_TOOL, type PlanState } from "./state.ts";

export const PLAN_OFF_REFUSAL = "Plan mode stays on until the user has replied to the finished plan. Present the plan, stop, and wait.";

/** The gate check lives in `canLeave` so the tool and the `tool_call` guard cannot disagree. */
export function canLeave(state: PlanState): string | undefined {
  if (!state.active) return "Plan mode is not active.";
  if (!state.confirmed) return PLAN_OFF_REFUSAL;
  return undefined;
}

export function registerPlanOffTool(
  pi: ExtensionAPI,
  state: PlanState,
  onChange: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: PLAN_OFF_TOOL,
    label: "Plan mode",
    description:
      "Leave plan mode so the approved plan can be implemented. Only call it after the user replied to a finished plan with a confirmation, and call it alone, not together with other tools.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const refusal = canLeave(state);
      if (refusal) throw new Error(refusal);
      state.disable(true);
      onChange(ctx);
      return {
        content: [{ type: "text", text: offToolResult(pi.getActiveTools().includes(TODO_TOOL)) }],
        details: { active: false },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("plan mode ")) + theme.fg("muted", "off"), 0, 0);
    },

    renderResult(result, _options, theme) {
      const first = result.content[0];
      if (!result.details) return new Text(theme.fg("error", first?.type === "text" ? first.text : "failed"), 0, 0);
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "implementing"), 0, 0);
    },
  });
}
