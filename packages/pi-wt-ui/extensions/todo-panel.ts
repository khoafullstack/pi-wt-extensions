import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "wt-ui-todo";
const WIDGET_KEY = "wt-ui-todo";
const MAX_VISIBLE = 8;
const BAR_WIDTH = 10;

type Status = "pending" | "in_progress" | "done";

interface Todo {
  id: number;
  text: string;
  status: Status;
}

interface TodoDetails {
  action: "set" | "update" | "clear";
  todos: Todo[];
}

const TodoParams = Type.Object({
  action: StringEnum(["set", "update", "clear"] as const, {
    description: "set: replace the whole plan; update: change one item's status; clear: remove the plan",
  }),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "Short description of the step" }),
        status: Type.Optional(StringEnum(["pending", "in_progress", "done"] as const)),
      }),
      { description: "Plan steps in order (for set)" },
    ),
  ),
  id: Type.Optional(Type.Number({ description: "Step id, starting at 1 (for update)" })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "done"] as const, { description: "New status (for update)" })),
});

function summarize(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "done").length;
  return `${done}/${todos.length} done`;
}

function describe(todos: Todo[]): string {
  if (todos.length === 0) return "Plan is empty";
  const mark = { pending: " ", in_progress: "~", done: "x" } as const;
  return todos.map((t) => `[${mark[t.status]}] #${t.id}: ${t.text}`).join("\n");
}

export function registerTodoPanel(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;
  let todos: Todo[] = [];

  function paint(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (!enabled || todos.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        if (width < 20) return [];
        const total = todos.length;
        const done = todos.filter((t) => t.status === "done").length;

        const filled = Math.round((done / total) * BAR_WIDTH);
        const bar = theme.fg("success", "▓".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
        const tail = ` ${done}/${total} ${bar} `;
        const title = " Plan ";
        const rule = "─".repeat(Math.max(1, width - 3 - visibleWidth(title) - visibleWidth(tail)));
        const top = theme.fg("borderMuted", "───") + theme.fg("accent", title) + theme.fg("borderMuted", rule) + theme.fg("muted", tail);

        const active = todos.findIndex((t) => t.status !== "done");
        const focus = active === -1 ? total - 1 : active;
        const start = Math.max(0, Math.min(focus - 2, total - MAX_VISIBLE));
        const shown = todos.slice(start, start + MAX_VISIBLE);

        const lines = [truncateToWidth(top, width)];
        if (start > 0) lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${start} earlier`)}`, width));
        for (const t of shown) {
          const icon =
            t.status === "done" ? theme.fg("success", "✓") : t.status === "in_progress" ? theme.fg("accent", "●") : theme.fg("dim", "○");
          const label =
            t.status === "done"
              ? theme.fg("dim", t.text)
              : t.status === "in_progress"
                ? theme.fg("text", theme.bold(t.text))
                : theme.fg("muted", t.text);
          lines.push(truncateToWidth(`  ${icon} ${label}`, width));
        }
        const hidden = total - start - shown.length;
        if (hidden > 0) lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${hidden} more`)}`, width));
        return lines;
      },
    }));
  }

  function reconstruct(ctx: ExtensionContext): void {
    todos = [];
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
        const details = msg.details as TodoDetails | undefined;
        if (details && Array.isArray(details.todos)) todos = details.todos;
      }
    } catch {
      // Keep whatever state we have; the panel is cosmetic.
    }
    paint(ctx);
  }

  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan",
    description:
      "Track a step-by-step plan shown to the user in a live panel. Use 'set' with ordered items at the start of multi-step work, 'update' to mark a step in_progress or done as you go (keep one step in_progress), and 'clear' when finished.",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "set") {
        if (!params.items || params.items.length === 0) throw new Error("items required for set");
        todos = params.items.map((item, i) => ({ id: i + 1, text: item.text, status: item.status ?? "pending" }));
      } else if (params.action === "update") {
        if (params.id === undefined || !params.status) throw new Error("id and status required for update");
        const todo = todos.find((t) => t.id === params.id);
        if (!todo) throw new Error(`Step #${params.id} not found`);
        todo.status = params.status;
      } else {
        todos = [];
      }

      paint(ctx);
      return {
        content: [{ type: "text", text: params.action === "clear" ? "Plan cleared" : describe(todos) }],
        details: { action: params.action, todos: todos.map((t) => ({ ...t })) } as TodoDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", args.action);
      if (args.action === "set" && args.items) text += ` ${theme.fg("dim", `${args.items.length} steps`)}`;
      if (args.action === "update" && args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)} ${theme.fg("dim", args.status ?? "")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as TodoDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(theme.fg("error", first?.type === "text" ? first.text : "failed"), 0, 0);
      }
      const text = details.action === "clear" ? "cleared" : summarize(details.todos);
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerCommand("wt-ui-todos", {
    description: "Bật/tắt todo panel (on | off | clear, bỏ trống để đảo trạng thái)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "clear") {
        todos = [];
        paint(ctx);
        ctx.ui.notify("wt-ui todos: cleared (chỉ xóa panel, không ghi vào phiên)", "info");
        return;
      }
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      paint(ctx);
      ctx.ui.notify(`wt-ui todos: ${enabled ? "on" : "off"}`, "info");
    },
  });

  return { isEnabled: () => enabled };
}
