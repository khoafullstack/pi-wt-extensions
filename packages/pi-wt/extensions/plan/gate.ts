import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PLAN_GATE_ENTRY } from "./state.ts";

export interface GateData { shortcut: string }

export function gateText(shortcut: string): string {
  return "This is the plan. To have the agent implement it, turn off plan mode "
    + `(/wt-plan or ${shortcut}) and send a message confirming, or send the confirmation while plan mode is still on.`;
}

/** The last assistant message decides whether the run produced a plan worth gating. */
export function endedNormally(messages: ReadonlyArray<unknown>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string };
    if (message.role === "assistant") return message.stopReason !== "aborted" && message.stopReason !== "error";
  }
  return false;
}

export function registerGateRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<GateData>(PLAN_GATE_ENTRY, (entry, _options, theme) => {
    const shortcut = typeof entry.data?.shortcut === "string" ? entry.data.shortcut : "the shortcut";
    const component: Component = {
      invalidate() {},
      render(width: number): string[] {
        const text = theme.fg("warning", `PLAN  ${gateText(shortcut)}`);
        return ["", ...wrapTextWithAnsi(text, Math.max(1, width))];
      },
    };
    return component;
  });
}
