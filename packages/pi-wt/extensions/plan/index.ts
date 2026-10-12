import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey } from "@earendil-works/pi-tui";
import { loadConfig } from "../settings.ts";
import { endedNormally, registerGateRenderer, type GateData } from "./gate.ts";
import { canLeave, registerPlanOffTool } from "./off-tool.ts";
import { implementGuidelines, planGuidelines } from "./prompt.ts";
import { BLOCKED_TOOLS, PLAN_CHANGED_EVENT, PLAN_GATE_ENTRY, PLAN_OFF_TOOL, PlanState, TODO_TOOL } from "./state.ts";

const DEFAULT_SHORTCUT = "alt+m";

export function registerPlan(pi: ExtensionAPI): { isActive(): boolean; state: PlanState } {
  const state = new PlanState(pi);
  let shortcut = DEFAULT_SHORTCUT;
  let stopInput: (() => void) | undefined;

  const syncTools = () => {
    const tools = pi.getActiveTools();
    const declared = tools.includes(PLAN_OFF_TOOL);
    // The exit tool is only declared while plan mode is on, so it costs no context otherwise.
    if (state.active && !declared) pi.setActiveTools([...tools, PLAN_OFF_TOOL]);
    else if (!state.active && declared) pi.setActiveTools(tools.filter(name => name !== PLAN_OFF_TOOL));
  };
  const refresh = () => {
    syncTools();
    pi.events?.emit(PLAN_CHANGED_EVENT, { active: state.active });
  };
  const setMode = (on: boolean, ctx: ExtensionContext) => {
    if (on) state.enable(); else state.disable(false);
    refresh();
    if (ctx.hasUI) ctx.ui.notify(on ? "Plan mode on: read-only investigation, write and edit are blocked" : "Plan mode off", "info");
  };
  const toggle = (ctx: ExtensionContext) => setMode(!state.active, ctx);
  const clearInput = () => { stopInput?.(); stopInput = undefined; };

  const setup = async (ctx: ExtensionContext) => {
    clearInput();
    state.restore(ctx);
    refresh();
    if (ctx.mode !== "tui") return;
    const config = await loadConfig(ctx);
    const key = config.plan.shortcut;
    const occupied = new Set<unknown>(Object.values(getKeybindings().getResolvedBindings()).flatMap(value => Array.isArray(value) ? value : [value]));
    if (occupied.has(key)) { ctx.ui.notify(`wt-plan: shortcut ${key} conflicts with a Pi binding; use /wt-plan`, "warning"); return; }
    shortcut = key;
    // A raw listener allows remapping without mutating Pi's registered shortcuts.
    stopInput = ctx.ui.onTerminalInput(data => {
      if (!matchesKey(data, key as Parameters<typeof matchesKey>[1])) return;
      toggle(ctx);
      return { consume: true };
    });
  };

  registerPlanOffTool(pi, state, refresh);
  registerGateRenderer(pi);

  pi.registerShortcut(DEFAULT_SHORTCUT, {
    description: "wt-plan: toggle plan mode (configurable)",
    handler: ctx => { if (!stopInput) toggle(ctx); },
  });
  pi.registerCommand("wt-plan", {
    description: "Plan mode: [on|off|status]; no argument toggles",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "status") {
        ctx.ui.notify(`Plan mode: ${state.active ? "on" : "off"} · shortcut: ${shortcut}`, "info");
      } else if (mode === "" || mode === "on" || mode === "off") {
        setMode(mode === "" ? !state.active : mode === "on", ctx);
      } else throw new Error("wt-plan: expected on, off or status");
    },
  });

  pi.on("session_start", async (_event, ctx) => { await setup(ctx); });
  pi.on("session_tree", (_event, ctx) => { state.restore(ctx); refresh(); });
  pi.on("session_shutdown", () => clearInput());

  pi.on("input", event => {
    // Commands and extension-sent messages are not the user's reply to a plan.
    if (event.source !== "extension" && !event.text.trimStart().startsWith("/")) state.noteUserMessage();
    return { action: "continue" };
  });

  pi.on("before_agent_start", event => {
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (state.active) guidelines.push(...planGuidelines());
    else if (state.implementNext) {
      state.implementNext = false;
      guidelines.push(...implementGuidelines(pi.getActiveTools().includes(TODO_TOOL)));
    }
    return undefined;
  });

  pi.on("tool_call", event => {
    if (!state.active) return undefined;
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Plan mode is on: ${event.toolName} is blocked. Describe the change in the plan instead.` };
    }
    if (event.toolName === PLAN_OFF_TOOL) {
      const refusal = canLeave(state);
      if (refusal) return { block: true, reason: refusal };
    }
    return undefined;
  });

  pi.on("agent_end", event => {
    if (!state.active || !endedNormally(event.messages)) return;
    state.openGate();
    pi.appendEntry<GateData>(PLAN_GATE_ENTRY, { shortcut });
  });

  return { isActive: () => state.active, state };
}
