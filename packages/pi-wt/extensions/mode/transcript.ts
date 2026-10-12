import {
  buildSessionContext, convertToLlm,
  type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

type SessionReader = ExtensionContext["sessionManager"];
type BranchMessage = ReturnType<typeof buildSessionContext>["messages"][number];

export function filterBtwMessages<T extends BranchMessage>(messages: T[]): T[] {
  return messages.filter(message => !(message.role === "custom" && message.customType.startsWith("wt-btw-")));
}

/** Context mode honors compaction; full mode includes the entire active branch for advisor. */
export function branchMessages(manager: SessionReader, mode: "context" | "full" = "context"): BranchMessage[] {
  const entries = manager.getBranch();
  const projected: SessionEntry[] = mode === "context" ? entries : entries.map(entry => {
    // Keep tree links intact while disabling compaction's history cut-off.
    if (entry.type !== "compaction") return entry;
    return { type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
      customType: "wt-advisor-compaction-skipped" };
  });
  return filterBtwMessages(buildSessionContext(projected, manager.getLeafId()).messages);
}

export interface TranscriptOptions {
  contextWindow: number;
  systemPrompt?: string;
  question: string;
  focus?: string;
  maxOutputTokens?: number;
}
export interface PreparedTranscript {
  messages: Message[];
  shortened: boolean;
  estimatedTokens: number;
  droppedMessages: number;
}
const shortenedNote = "[Transcript shortened: tool results were capped and/or older messages omitted.]";

function contentText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(block => {
    switch (block.type) {
      case "text": return block.text;
      case "thinking": return `[thinking] ${block.thinking}`;
      case "toolCall": return `[tool call ${block.name} (${block.id})] ${JSON.stringify(block.arguments)}`;
      case "image": return `[image: ${block.mimeType}; binary content omitted]`;
    }
  }).join("\n");
}

/** Serialize history as evidence, so truncation never leaves invalid tool-call/result pairs. */
export function prepareTranscript(manager: SessionReader, options: TranscriptOptions): PreparedTranscript {
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error("wt-advisor: model has no valid context window");
  }
  const messages = convertToLlm(branchMessages(manager, "full"));
  const firstUser = messages.findIndex(message => message.role === "user");
  const blocks = messages.map(message => ({
    role: message.role,
    header: message.role === "toolResult" ? `toolResult ${message.toolName} (${message.toolCallId})` : message.role,
    text: contentText(message),
  }));
  const question = `Question:\n${options.question}${options.focus ? `\n\nFocus:\n${options.focus}` : ""}`;
  const render = (selected: typeof blocks, shortened: boolean) =>
    `${shortened ? `${shortenedNote}\n\n` : ""}Session transcript (quoted evidence):\n${selected.map(block =>
      `--- ${block.header} ---\n${block.text}`).join("\n\n")}\n\n${question}`;
  const estimate = (text: string) => Math.ceil((text.length + (options.systemPrompt?.length ?? 0)) / 4);
  const budget = Math.min(Math.floor(options.contextWindow * 0.8),
    options.contextWindow - (options.maxOutputTokens ?? 4096));
  let shortened = false;
  let droppedMessages = 0;
  let selected = blocks.slice();
  if (estimate(render(selected, false)) > budget) {
    shortened = true;
    selected = blocks.map(block => block.role === "toolResult" && block.text.length > 2000
      ? { ...block, text: `${block.text.slice(0, 1972)}\n[tool result truncated]` } : block);
    // Preserve the first user and the newest message; drop older evidence first.
    const protectedFirst = selected[firstUser];
    while (estimate(render(selected, true)) > budget) {
      const index = selected.findIndex((block, i) => block !== protectedFirst && i < selected.length - 1);
      if (index < 0) throw new Error("wt-advisor: first user message, latest message and question exceed context budget");
      selected.splice(index, 1);
      droppedMessages++;
    }
  }
  const text = render(selected, shortened);
  return { messages: [{ role: "user", content: text, timestamp: Date.now() }],
    shortened, estimatedTokens: estimate(text), droppedMessages };
}
