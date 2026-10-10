import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { countTurns, formatClock, formatDuration, formatTokens } from "./session-info.ts";

const ENTRY_TYPE = "wt-ui-turn";

interface TurnData {
  turn: number;
  at: number;
  durationMs?: number;
  tools: number;
  input: number;
  output: number;
  cost: number;
  outcome: "completed" | "aborted" | "error";
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

function summarizeRun(messages: ReadonlyArray<unknown>): Pick<TurnData, "tools" | "input" | "output" | "cost" | "outcome"> {
  let tools = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  let outcome: TurnData["outcome"] = "completed";

  for (const raw of messages) {
    const message = raw as { role?: string; usage?: UsageLike; stopReason?: string };
    if (message.role === "toolResult") tools++;
    if (message.role !== "assistant") continue;

    const usage = message.usage;
    // Cached prompt tokens still count as input the model read, so they are included here.
    input += (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    output += usage?.output ?? 0;
    cost += usage?.cost?.total ?? 0;
    outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
  }
  return { tools, input, output, cost, outcome };
}

function describe(data: TurnData): string {
  const parts = [`turn ${data.turn}`, formatClock(data.at, true)];
  if (data.durationMs !== undefined) parts.push(formatDuration(data.durationMs));
  if (data.tools > 0) parts.push(`${data.tools} ${data.tools === 1 ? "tool" : "tools"}`);
  parts.push(`in ${formatTokens(data.input)} / out ${formatTokens(data.output)}`);
  if (data.cost > 0) parts.push(`$${data.cost.toFixed(data.cost < 10 ? 3 : 2)}`);
  if (data.outcome !== "completed") parts.push(data.outcome);
  return parts.join(" · ");
}

export function registerTurnSeparator(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;
  let runStartedAt = 0;

  pi.on("agent_start", () => {
    runStartedAt = Date.now();
  });

  // One separator per agent run, not per model turn: a single prompt often takes many tool-calling turns.
  pi.on("agent_end", (event, ctx) => {
    if (!enabled) return;
    try {
      const data: TurnData = {
        turn: countTurns(ctx),
        at: Date.now(),
        durationMs: runStartedAt ? Date.now() - runStartedAt : undefined,
        ...summarizeRun(event.messages),
      };
      runStartedAt = 0;
      pi.appendEntry<TurnData>(ENTRY_TYPE, data);
    } catch {
      // A separator is cosmetic and must never break the run.
    }
  });

  pi.registerEntryRenderer<TurnData>(ENTRY_TYPE, (entry, _options, theme) => {
    if (!enabled || !entry.data) return undefined;
    const label = describe(entry.data);

    const component: Component = {
      invalidate() {},
      render(width: number): string[] {
        const head = "─── ";
        const text = truncateToWidth(label, Math.max(0, width - visibleWidth(head)));
        return ["", theme.fg("dim", `${head}${text}`)];
      },
    };
    return component;
  });

  pi.registerCommand("wt-ui-turns", {
    description: "Bật/tắt dải phân cách mỗi lượt chạy (on | off, bỏ trống để đảo trạng thái)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      ctx.ui.notify(`wt-ui turn separator: ${enabled ? "on" : "off"} (dải cũ cũng ẩn/hiện khi vẽ lại)`, "info");
    },
  });

  return { isEnabled: () => enabled };
}
