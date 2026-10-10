import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "❯";
// Non-breaking spaces: Markdown strips the leading ordinary spaces of a paragraph's continuation lines.
const HANGING_INDENT = "\u00a0\u00a0";

// A line that starts a Markdown block (heading, list, quote, fence, table, indented code) must keep its first column.
const BLOCK_START = /^(?:\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|\s{4,}|\t)/;

function decorate(markdown: string): string {
  if (markdown.trim() === "") return markdown;

  const lines = markdown.split(/\r?\n/);
  if (lines.some((line) => BLOCK_START.test(line))) {
    // Prefixing would change how these lines parse. The first line is the only one safe to mark.
    return BLOCK_START.test(lines[0]!) ? markdown : [`${MARKER} ${lines[0]}`, ...lines.slice(1)].join("\n");
  }

  return lines.map((line, i) => (i === 0 ? `${MARKER} ${line}` : line === "" ? line : `${HANGING_INDENT}${line}`)).join("\n");
}

/**
 * Display-only: the stored message and what the model receives are unchanged.
 * Pi allows one markdown transformer per extension, so this is the only one registered here.
 */
export function registerUserMessage(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;

  pi.registerMarkdownTransformer((markdown, context) => {
    if (!enabled || context.messageType !== "user") return markdown;
    return decorate(markdown);
  });

  pi.registerCommand("wt-ui-user", {
    description: "Bật/tắt dấu ❯ ở user message (on | off, bỏ trống để đảo trạng thái; /reload để vẽ lại message cũ)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      ctx.ui.notify(`wt-ui user message: ${enabled ? "on" : "off"} (message cũ vẽ lại sau /reload)`, "info");
    },
  });

  return { isEnabled: () => enabled };
}
