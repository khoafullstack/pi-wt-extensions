import { highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadSettings } from "./settings.ts";
import { captureSnapshot, summarizeWrite } from "./write-diff.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Tone = "dim" | "muted" | "error" | "success" | "warning" | "toolOutput";

interface BodyLine {
  gutter?: string;
  text: string;
  tone: Tone;
  wrap?: boolean;
  mark?: { text: string; tone: Tone };
  // The text already carries its own colors (syntax highlighting), so the tone is not applied.
  raw?: boolean;
}

interface Final {
  error: boolean;
  detail: string;
  ms: number | undefined;
}

interface CardState {
  final?: Final;
  key?: string;
  // Header text while a partial result streams in; read at draw time, so it needs no redraw of its own.
  live?: string;
}

interface CodemodeCall {
  name: string;
  args: string;
  status: string;
  durationMs?: number;
  error?: string;
  cost?: number;
}

interface Summary {
  detail: string;
  body: BodyLine[];
}

const BUILT_IN = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// Tools from this package get the same card, so they look like the built-ins instead of Pi's boxed default.
const CARD_TOOLS = new Set([...BUILT_IN, "wt-ui-todo", "wt-ui-ask", "wt-advisor", "codemode"]);
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
const LABELS: Record<string, string> = {
  powershell: "pwsh",
  "wt-ui-todo": "plan",
  "wt-ui-ask": "ask",
  "wt-advisor": "advice",
  codemode: "code",
  list_mcp_resources: "res",
  list_mcp_resource_templates: "tmpl",
  read_mcp_resource: "res",
};
const MCP_PREFIX = "mcp__";

// MCP server tools are registered at runtime as `mcp__<server>__<tool>`, so they are matched by prefix.
function isCardTool(toolName: string): boolean {
  return CARD_TOOLS.has(toolName) || MCP_RESOURCE_TOOLS.has(toolName) || toolName.startsWith(MCP_PREFIX);
}

function labelFor(toolName: string): string {
  return LABELS[toolName] ?? (toolName.startsWith(MCP_PREFIX) ? "mcp" : toolName);
}
const TODO_ICONS: Record<string, string> = { done: "✓", in_progress: "●", pending: "○" };
const LABEL_WIDTH = 6;
const EXPANDED_LINES = 30;
const DIFF_PREVIEW_LINES = 12;
const DIFF_EXPANDED_LINES = 80;
const ERROR_LINES = 5;
const ADVICE_PREVIEW_LINES = 6;
const MCP_PREVIEW_LINES = 3;
const MCP_PREVIEW_LINE_CHARS = 200;
const CODEMODE_CALL_PREVIEW = 8;
const CODEMODE_OUTPUT_PREVIEW = 5;
const CODEMODE_SCRIPT_LINES = 40;
const CODEMODE_COLLAPSED_ARGS = 80;
// A single JSON line is common script output, so collapsed previews also cap line length.
const CODEMODE_COLLAPSED_LINE_CHARS = 300;
// Pi puts this header in its own content block, ahead of the script output.
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

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

function splitMcpName(toolName: string): { server: string; tool: string } {
  const rest = toolName.slice(MCP_PREFIX.length);
  const i = rest.indexOf("__");
  return i < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function scalarText(value: unknown): string {
  return clean(typeof value === "string" ? firstLine(value) : (JSON.stringify(value) ?? String(value)));
}

function mcpTarget(toolName: string, args: any): string {
  const { server, tool } = splitMcpName(toolName);
  const name = tool ? `${server}/${tool}` : server;
  const entries = args && typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [];
  // Context7 arguments are free text and library ids, which read better as plain values than as key=value pairs.
  if (server === "context7" && tool === "resolve_library_id") {
    return `${name} ${scalarText(args?.libraryName ?? args?.query ?? "…")}`;
  }
  if (server === "context7" && tool === "query_docs") {
    return `${name} ${[args?.libraryId, args?.query].filter((v) => typeof v === "string" && v).map(scalarText).join(" · ") || "…"}`;
  }
  if (entries.length === 0) return name;
  const summary =
    entries.length === 1 ? scalarText(entries[0][1]) : entries.map(([key, value]) => `${key}=${scalarText(value)}`).join(" ");
  return `${name} ${summary}`;
}

function target(toolName: string, args: any): string {
  if (toolName.startsWith(MCP_PREFIX)) return mcpTarget(toolName, args ?? undefined);
  if (!args || typeof args !== "object") return toolName === "list_mcp_resources" || toolName === "list_mcp_resource_templates" ? "all servers" : "…";
  switch (toolName) {
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return `${args.server || "all servers"}${args.cursor ? " (next page)" : ""}`;
    case "read_mcp_resource":
      return [args.server, args.uri].filter(Boolean).join(" ") || "…";
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
    case "wt-advisor":
      return firstLine(String(args.question ?? "…"));
    case "codemode": {
      if (typeof args.code !== "string") return "…";
      // The `// @options:` line configures the run, so it says nothing about what the script does.
      const line = args.code.split("\n").map((l: string) => l.trim()).find((l: string) => l && !/^\/\/\s*@options/i.test(l));
      return line ?? "…";
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

function formatCost(cost: number): string {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function codemodeCalls(result: any): CodemodeCall[] {
  const calls = result?.details?.calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter((c: any) => c && typeof c === "object" && typeof c.name === "string");
}

function callMark(status: string): { text: string; tone: Tone } {
  switch (status) {
    case "ok":
      return { text: "✓", tone: "success" };
    case "error":
      return { text: "✗", tone: "error" };
    case "cancelled":
      return { text: "⊘", tone: "muted" };
    default:
      return { text: "⟳", tone: "warning" };
  }
}

function callLines(call: CodemodeCall, expanded: boolean): BodyLine[] {
  const rawArgs = typeof call.args === "string" ? clean(call.args) : "";
  const args = !expanded && rawArgs.length > CODEMODE_COLLAPSED_ARGS ? `${rawArgs.slice(0, CODEMODE_COLLAPSED_ARGS - 1)}…` : rawArgs;
  const meta = [
    typeof call.durationMs === "number" ? formatMs(call.durationMs) : "",
    typeof call.cost === "number" && call.cost > 0 ? formatCost(call.cost) : "",
  ].filter(Boolean);
  const text = `${call.name}${args ? ` ${args}` : ""}${meta.length ? `  ${meta.join(" · ")}` : ""}`;
  const lines: BodyLine[] = [{ mark: callMark(call.status), text, tone: call.status === "error" ? "error" : "muted" }];
  if (expanded && call.error) {
    for (const line of clean(call.error).split("\n")) lines.push({ text: `  ${line}`, tone: "error", wrap: true });
  }
  return lines;
}

function scriptLines(code: string): BodyLine[] {
  const source = clean(code).replace(/\s+$/, "");
  let lines: string[];
  try {
    lines = highlightCode(source, "javascript");
  } catch {
    lines = source.split("\n");
  }
  const shown = lines.slice(0, CODEMODE_SCRIPT_LINES).map<BodyLine>((text) => ({ text, tone: "dim", raw: true }));
  if (lines.length > CODEMODE_SCRIPT_LINES) {
    shown.push({ text: `… ${lines.length - CODEMODE_SCRIPT_LINES} more script lines`, tone: "muted" });
  }
  return [{ text: "script", tone: "dim" }, ...shown];
}

function summarizeCodemode(
  args: any,
  result: any,
  opts: { expanded: boolean; isError: boolean; partial: boolean },
): Summary {
  const calls = codemodeCalls(result);
  const body: BodyLine[] = [];

  if (opts.expanded && typeof args?.code === "string" && args.code.trim()) body.push(...scriptLines(args.code));

  const shown = opts.expanded ? calls : calls.slice(-CODEMODE_CALL_PREVIEW);
  if (shown.length < calls.length) {
    body.push({ text: `… ${calls.length - shown.length} earlier calls`, tone: "muted" });
  }
  for (const call of shown) body.push(...callLines(call, opts.expanded));
  const priced = calls.filter((c) => typeof c.cost === "number" && c.cost > 0);
  if (priced.length > 1) {
    body.push({ text: `Model calls: ${formatCost(priced.reduce((sum, c) => sum + (c.cost ?? 0), 0))}`, tone: "muted" });
  }

  if (opts.partial) {
    return { detail: calls.length ? `running · ${plural(calls.length, "call")}` : "running…", body };
  }

  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const [first, ...rest] = blocks;
  const hasHeader = first?.type === "text" && typeof first.text === "string" && SCRIPT_HEADER.test(first.text);
  const output = textOf({ content: hasHeader ? rest : blocks }).trim();
  if (output) {
    const limit = opts.expanded ? EXPANDED_LINES : CODEMODE_OUTPUT_PREVIEW;
    const tone: Tone = opts.isError ? "error" : "toolOutput";
    const text = opts.expanded
      ? output
      : output
          .split("\n")
          .map((l) => (l.length > CODEMODE_COLLAPSED_LINE_CHARS ? `${l.slice(0, CODEMODE_COLLAPSED_LINE_CHARS - 1)}…` : l))
          .join("\n");
    body.push(...previewBody(text, limit, "head", tone).map((line) => ({ ...line, wrap: true })));
  }
  const fullOutputPath = result?.details?.fullOutputPath;
  if (!opts.expanded && typeof fullOutputPath === "string") {
    body.push({ text: `Full output: ${fullOutputPath}`, tone: "muted" });
  }

  const count = calls.length ? plural(calls.length, "call") : "";
  if (opts.isError) return { detail: count ? `failed · ${count}` : "failed", body };
  return { detail: count || "no calls", body };
}

function summarizeMcpOutput(result: any, text: string, expanded: boolean): Summary {
  const hasImage = Array.isArray(result?.content) && result.content.some((c: { type: string }) => c.type === "image");
  const lines = countLines(text);
  const fullOutputPath = result?.details?.fullOutputPath;
  if (!text.trim()) return { detail: hasImage ? "image" : "empty", body: [] };
  const clipped = expanded
    ? text
    : text
        .split("\n")
        .map((l) => (l.length > MCP_PREVIEW_LINE_CHARS ? `${l.slice(0, MCP_PREVIEW_LINE_CHARS - 1)}…` : l))
        .join("\n");
  const body = previewBody(clipped, expanded ? EXPANDED_LINES : MCP_PREVIEW_LINES, "head", "dim").map((line) => ({
    ...line,
    wrap: true,
  }));
  if (!expanded && typeof fullOutputPath === "string") body.push({ text: `Full output: ${fullOutputPath}`, tone: "muted" });
  return { detail: `${plural(lines, "line")}${typeof fullOutputPath === "string" ? " (truncated)" : ""}`, body };
}

// Listings are JSON; structuredContent is used when Pi passes it along, the text block otherwise.
function mcpListing(result: any, text: string): any {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") return structured;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarizeMcpListing(toolName: string, result: any, text: string, expanded: boolean): Summary {
  const payload = mcpListing(result, text);
  const key = toolName === "list_mcp_resources" ? "resources" : "resourceTemplates";
  if (!payload || !Array.isArray(payload[key])) return { detail: firstLine(text), body: [] };
  const items: any[] = payload[key].filter((item: any) => item && typeof item === "object");
  const errors: any[] = Array.isArray(payload.errors) ? payload.errors : [];
  const noun = toolName === "list_mcp_resources" ? "resource" : "template";
  const detail = [
    plural(items.length, noun),
    payload.nextCursor ? "more pages" : "",
    errors.length ? plural(errors.length, "error") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Servers that failed to list are shown even when collapsed: the list is incomplete without them.
  const body: BodyLine[] = errors.map((e) => ({ text: `${e?.server ?? "?"}: ${clean(String(e?.error ?? "failed"))}`, tone: "error" }));
  if (expanded) {
    for (const item of items.slice(0, EXPANDED_LINES)) {
      const where = clean(String(item.uri ?? item.uriTemplate ?? ""));
      body.push({ text: [item.server, item.name, where].filter(Boolean).join("  "), tone: "dim" });
    }
    if (items.length > EXPANDED_LINES) body.push({ text: `… ${items.length - EXPANDED_LINES} more ${noun}s`, tone: "muted" });
  }
  return { detail, body };
}

function summarize(
  toolName: string,
  args: any,
  result: any,
  opts: { toolCallId: string; expanded: boolean; isError: boolean; diffPreview: boolean },
): Summary {
  // Failed scripts keep their nested calls and partial output, so they skip the generic error preview.
  if (toolName === "codemode") return summarizeCodemode(args, result, { ...opts, partial: false });

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
    case "wt-advisor": {
      const details = result.details as { model?: string; thinkingLevel?: string; shortened?: boolean } | undefined;
      const detail = [
        details?.model ?? "advisor",
        details?.thinkingLevel ? `thinking ${details.thinkingLevel}` : "",
        details?.shortened ? "shortened" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      // The advice is the point of the call, so a preview stays visible when collapsed.
      const limit = opts.expanded ? EXPANDED_LINES : ADVICE_PREVIEW_LINES;
      return {
        detail,
        body: previewBody(text, limit, "head", "toolOutput").map((line) => ({ ...line, wrap: true })),
      };
    }
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return summarizeMcpListing(toolName, result, text, opts.expanded);
    case "read_mcp_resource":
      return summarizeMcpOutput(result, text, opts.expanded);
    default:
      if (toolName.startsWith(MCP_PREFIX)) return summarizeMcpOutput(result, text, opts.expanded);
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
    return this.lines.flatMap((l) => {
      const mark = l.mark ? `${this.theme.fg(l.mark.tone, l.mark.text)} ` : "";
      const gutter = l.gutter ? `${this.theme.fg("dim", l.gutter)} ` : "";
      const content = l.raw ? l.text : this.theme.fg(l.tone, l.text);
      if (!l.wrap) return [truncateToWidth(this.indent + mark + gutter + content, width)];
      const prefix = this.indent + mark + gutter;
      // Continuation lines align under the text, not under the mark.
      const hanging = this.indent + " ".repeat(visibleWidth(mark + gutter));
      const room = Math.max(1, width - visibleWidth(prefix));
      return wrapTextWithAnsi(content, room).map((part, i) => truncateToWidth((i === 0 ? prefix : hanging) + part, width));
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
    const label = labelFor(this.toolName);
    const left =
      `${this.pad}${icon} ${theme.fg("toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)))} ` +
      theme.fg("accent", clean(target(this.toolName, this.args)));

    let right = "";
    if (!final) {
      right = theme.fg("dim", state.live ?? "running…");
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
    if (!cardsEnabled || !isCardTool(toolName)) return next();

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
        if (options.isPartial) {
          if (toolName !== "codemode") return new BodyComponent([], theme, pad);
          // Nested calls are only visible through these snapshots, so show them as they run.
          const live = summarizeCodemode(context.args, result, { expanded: options.expanded, isError: false, partial: true });
          state.live = live.detail;
          return new BodyComponent(live.body, theme, `${pad}  `);
        }

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
