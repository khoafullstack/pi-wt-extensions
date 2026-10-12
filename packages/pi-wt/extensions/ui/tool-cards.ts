import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadSettings } from "./settings.ts";
import { captureSnapshot, summarizeWrite } from "./write-diff.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Tone = "dim" | "muted" | "error" | "success" | "toolOutput";

interface BodyLine {
  gutter?: string;
  text: string;
  tone: Tone;
}

interface Final {
  error: boolean;
  detail: string;
  ms: number | undefined;
}

interface CardState {
  final?: Final;
  key?: string;
}

interface Summary {
  detail: string;
  body: BodyLine[];
}

const BUILT_IN = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// Tools from this package get the same card, so they look like the built-ins instead of Pi's boxed default.
const CARD_TOOLS = new Set([...BUILT_IN, "wt-ui-todo", "wt-ui-ask"]);
const LABELS: Record<string, string> = { powershell: "pwsh", "wt-ui-todo": "plan", "wt-ui-ask": "ask" };
const TODO_ICONS: Record<string, string> = { done: "✓", in_progress: "●", pending: "○" };
const LABEL_WIDTH = 6;
const EXPANDED_LINES = 30;
const DIFF_PREVIEW_LINES = 12;
const DIFF_EXPANDED_LINES = 80;
const ERROR_LINES = 5;

function clean(text: string): string {
  return text.replace(/\r/g, "").replace(/\t/g, "  ");
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function countLines(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Search tools answer an empty result with a single "No ..." sentence rather than an empty string.
  if (!trimmed.includes("\n") && /^no\s/i.test(trimmed)) return 0;
  return trimmed.split("\n").length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function firstLine(text: string): string {
  return clean(text).split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

function target(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "…";
  switch (toolName) {
    case "read": {
      const path = args.path ?? "…";
      if (args.offset === undefined && args.limit === undefined) return path;
      const start = args.offset ?? 1;
      return `${path}:${start}${args.limit !== undefined ? `-${start + args.limit - 1}` : ""}`;
    }
    case "bash":
    case "powershell":
      return `$ ${firstLine(String(args.command ?? "…"))}`;
    case "grep":
      return `/${args.pattern ?? "…"}/${args.path ? ` in ${args.path}` : ""}${args.glob ? ` (${args.glob})` : ""}`;
    case "find":
      return `${args.pattern ?? "…"}${args.path ? ` in ${args.path}` : ""}`;
    case "wt-ui-todo":
      if (args.action === "set") return plural(Array.isArray(args.items) ? args.items.length : 0, "step");
      if (args.action === "update") return `#${args.id ?? "?"} → ${args.status ?? "?"}`;
      return String(args.action ?? "…");
    case "wt-ui-ask": {
      const qs: any[] = Array.isArray(args.questions) ? args.questions : [];
      if (qs.length === 1) return firstLine(String(qs[0]?.prompt ?? "…"));
      return qs.map((q) => q?.label || q?.id || "?").join(", ") || "…";
    }
    default:
      return args.path ?? ".";
  }
}

function previewBody(text: string, limit: number, from: "head" | "tail", tone: Tone): BodyLine[] {
  const lines = clean(text).replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines.length <= limit) return lines.map((text) => ({ text, tone }));
  const hidden = lines.length - limit;
  if (from === "head") {
    return [...lines.slice(0, limit).map((text) => ({ text, tone })), { text: `… ${hidden} more lines`, tone: "muted" }];
  }
  return [{ text: `… ${hidden} earlier lines`, tone: "muted" }, ...lines.slice(-limit).map((text) => ({ text, tone }))];
}

function diffBody(diff: string, limit: number): BodyLine[] {
  const lines = clean(diff).replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, limit).map<BodyLine>((line) => {
    // Pi formats each line as `<sign><right-aligned number> <text>`; elided context is `<blank number> ...`.
    const match = /^([+\- ])(\s*\d*) (.*)$/.exec(line);
    if (!match) return { text: line, tone: "dim" };
    const [, sign, num, rest] = match;
    if (num.trim() === "" && rest.trim() === "...") return { gutter: `${num} ⋯`, text: "", tone: "muted" };
    return {
      gutter: `${num} │`,
      text: `${sign} ${rest}`,
      tone: sign === "+" ? "success" : sign === "-" ? "error" : "dim",
    };
  });
  if (lines.length > limit) shown.push({ text: `… ${lines.length - limit} more diff lines`, tone: "muted" });
  return shown;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function summarize(
  toolName: string,
  args: any,
  result: any,
  opts: { toolCallId: string; expanded: boolean; isError: boolean; diffPreview: boolean },
): Summary {
  const text = textOf(result);

  if (opts.isError) {
    return { detail: "failed", body: previewBody(text, ERROR_LINES, "head", "error") };
  }

  switch (toolName) {
    case "read": {
      if (result.content.some((c: { type: string }) => c.type === "image")) return { detail: "image", body: [] };
      const lines = countLines(text);
      const truncated = result.details?.truncation?.truncated ? " (truncated)" : "";
      return {
        detail: `${plural(lines, "line")}${truncated}`,
        body: opts.expanded ? previewBody(text, EXPANDED_LINES, "head", "dim") : [],
      };
    }
    case "bash":
    case "powershell": {
      const lines = countLines(text);
      const truncated = result.details?.truncation?.truncated ? " (truncated)" : "";
      return {
        detail: `${plural(lines, "line")}${truncated}`,
        body: opts.expanded ? previewBody(text, EXPANDED_LINES, "tail", "dim") : [],
      };
    }
    case "grep":
    case "find":
    case "ls": {
      const count = countLines(text);
      const noun = toolName === "grep" ? "match" : toolName === "find" ? "file" : "entry";
      const nounMany = toolName === "grep" ? "matches" : toolName === "find" ? "files" : "entries";
      return {
        detail: plural(count, noun, nounMany),
        body: opts.expanded ? previewBody(text, EXPANDED_LINES, "head", "dim") : [],
      };
    }
    case "edit": {
      const diff: string | undefined = result.details?.diff;
      if (!diff) return { detail: "applied", body: [] };
      const { added, removed } = diffStats(diff);
      let body: BodyLine[] = [];
      if (opts.expanded) body = diffBody(diff, DIFF_EXPANDED_LINES);
      else if (opts.diffPreview) body = diffBody(diff, DIFF_PREVIEW_LINES);
      return { detail: `+${added} −${removed}`, body };
    }
    case "write": {
      const content = typeof args?.content === "string" ? args.content : "";
      const diffed = summarizeWrite(opts.toolCallId, content, {
        expanded: opts.expanded,
        preview: opts.diffPreview,
        previewLines: DIFF_PREVIEW_LINES,
        expandedLines: DIFF_EXPANDED_LINES,
      });
      if (diffed) return diffed;
      // No snapshot (for example a resumed session): the old content is unknown, so only the new content can be shown.
      return {
        detail: plural(countLines(content), "line"),
        body: opts.expanded ? previewBody(content, EXPANDED_LINES, "head", "dim") : [],
      };
    }
    case "wt-ui-todo": {
      const details = result.details as { action?: string; todos?: { text: string; status: string }[] } | undefined;
      const todos = details?.todos ?? [];
      if (details?.action === "clear") return { detail: "cleared", body: [] };
      const done = todos.filter((t) => t.status === "done").length;
      return {
        detail: `${done}/${todos.length} done`,
        body: opts.expanded
          ? todos.map<BodyLine>((t) => ({
              text: `${TODO_ICONS[t.status] ?? "○"} ${t.text}`,
              tone: t.status === "done" ? "dim" : t.status === "in_progress" ? "success" : "muted",
            }))
          : [],
      };
    }
    case "wt-ui-ask": {
      const details = result.details as
        | { cancelled?: boolean; questions?: { id: string; label: string }[]; answers?: { id: string; labels: string[]; custom?: string }[] }
        | undefined;
      if (!details) return { detail: firstLine(text), body: [] };
      if (details.cancelled) return { detail: "cancelled", body: [] };
      const answers = details.answers ?? [];
      // Answers stay visible when collapsed: they are the point of the call and are short.
      const body = answers.map<BodyLine>((a) => {
        const label = details.questions?.find((q) => q.id === a.id)?.label ?? a.id;
        const parts = [...a.labels, ...(a.custom ? [`(wrote) ${a.custom}`] : [])];
        return { text: `${label}: ${parts.join(", ")}`, tone: "toolOutput" };
      });
      return { detail: `${answers.length} answered`, body };
    }
    default:
      return { detail: firstLine(text), body: [] };
  }
}

class BodyComponent implements Component {
  private readonly lines: BodyLine[];
  private readonly theme: Theme;
  private readonly indent: string;

  constructor(lines: BodyLine[], theme: Theme, indent: string) {
    this.lines = lines;
    this.theme = theme;
    this.indent = indent;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((l) => {
      const gutter = l.gutter ? `${this.theme.fg("dim", l.gutter)} ` : "";
      return truncateToWidth(this.indent + gutter + this.theme.fg(l.tone, l.text), width);
    });
  }
}

class HeaderComponent implements Component {
  private readonly toolName: string;
  private readonly args: any;
  private readonly state: CardState;
  private readonly theme: Theme;
  private readonly pad: string;

  constructor(toolName: string, args: any, state: CardState, theme: Theme, pad: string) {
    this.toolName = toolName;
    this.args = args;
    this.state = state;
    this.theme = theme;
    this.pad = pad;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme, state } = this;
    const final = state.final;

    const icon = !final ? theme.fg("warning", "⟳") : final.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const label = LABELS[this.toolName] ?? this.toolName;
    const left =
      `${this.pad}${icon} ${theme.fg("toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)))} ` +
      theme.fg("accent", clean(target(this.toolName, this.args)));

    let right = "";
    if (!final) {
      right = theme.fg("dim", "running…");
    } else {
      const parts = [final.detail, final.ms !== undefined ? formatMs(final.ms) : ""].filter(Boolean);
      right = theme.fg(final.error ? "error" : "dim", parts.join(" · "));
    }

    const rightWidth = visibleWidth(right);
    if (rightWidth + 2 >= width) return [truncateToWidth(left, width)];

    const room = width - rightWidth - 2;
    const fitted = truncateToWidth(left, room);
    const gap = " ".repeat(Math.max(2, width - visibleWidth(fitted) - rightWidth));
    return [truncateToWidth(`${fitted}${gap}${right}`, width)];
  }
}

export function registerToolCards(pi: ExtensionAPI): {
  isCardsEnabled(): boolean;
  isDiffEnabled(): boolean;
} {
  let cardsEnabled = true;
  let diffEnabled = true;

  pi.on("session_start", (_event, ctx) => {
    const { settings } = loadSettings(ctx.cwd);
    cardsEnabled = settings.toolCards;
    diffEnabled = settings.diffPreview;
  });

  pi.registerToolRenderer((toolName, next) => {
    if (!cardsEnabled || !CARD_TOOLS.has(toolName)) return next();

    return {
      // "self" drops the boxed background so each call is a single flat row.
      renderShell: "self",

      renderCall(args, theme, context) {
        const state = (context.state ??= {}) as CardState;
        return new HeaderComponent(toolName, args, state, theme, " ".repeat(context.outputPad ?? 1));
      },

      renderResult(result, options, theme, context) {
        const state = (context.state ??= {}) as CardState;
        const pad = " ".repeat(context.outputPad ?? 1);

        // Streaming updates keep the header in its running state.
        if (options.isPartial) return new BodyComponent([], theme, pad);

        const summary = summarize(toolName, context.args, result, {
          toolCallId: context.toolCallId,
          expanded: options.expanded,
          isError: context.isError,
          diffPreview: diffEnabled,
        });

        // The header is a separate component, so it only learns the outcome through shared state.
        // It reads that state while drawing, so no redraw is needed here beyond a deferred one.
        // context.invalidate() must not run synchronously: it re-enters Pi's updateDisplay, which then
        // appends this result component a second time (the diff showed up twice).
        const final: Final = { error: context.isError, detail: summary.detail, ms: context.durationMs };
        const key = `${final.error}|${final.detail}|${final.ms}`;
        if (state.key !== key) {
          state.final = final;
          state.key = key;
          queueMicrotask(() => context.invalidate());
        }

        return new BodyComponent(summary.body, theme, `${pad}  `);
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!cardsEnabled || event.toolName !== "write") return;
    await captureSnapshot(event.toolCallId, ctx.cwd, (event.input as { path?: unknown }).path);
  });

  return {
    isCardsEnabled: () => cardsEnabled,
    isDiffEnabled: () => diffEnabled,
  };
}
