import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type BtwMode = "context";
export interface Exchange { question: string; answer: AssistantMessage }
export interface ThreadState { mode: BtwMode; exchanges: Exchange[] }
export function emptyThread(mode: BtwMode = "context"): ThreadState { return { mode, exchanges: [] }; }

function exchange(value: unknown): value is Exchange {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Exchange>;
  return typeof data.question === "string" && !!data.answer && data.answer.role === "assistant"
    && typeof data.answer.api === "string" && typeof data.answer.provider === "string" && typeof data.answer.model === "string"
    && typeof data.answer.timestamp === "number" && Number.isFinite(data.answer.timestamp)
    && !!data.answer.usage && typeof data.answer.usage.totalTokens === "number"
    && Array.isArray(data.answer.content) && data.answer.content.every(block =>
      !!block && typeof block === "object" && (block.type === "text" && typeof block.text === "string"
        || block.type === "thinking" && typeof block.thinking === "string"));
}

/** Only the selected branch contributes state. A reset shadows all preceding turns. */
export function restoreThread(entries: SessionEntry[]): ThreadState {
  let state = emptyThread();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "wt-btw-thread-reset") {
      const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
      if (mode === "context" || mode === "contextless") state = emptyThread();
    } else if (entry.customType === "wt-btw-thread-entry" && exchange(entry.data)) {
      state.exchanges.push(entry.data);
    }
  }
  return state;
}

export function answerText(answer: AssistantMessage): string {
  return answer.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
export function threadText(state: ThreadState): string {
  return state.exchanges.map(turn => `You: ${turn.question}\n\nBTW: ${answerText(turn.answer)}`).join("\n\n");
}
export function resetThread(pi: ExtensionAPI, mode: BtwMode): ThreadState {
  pi.appendEntry("wt-btw-thread-reset", { mode });
  return emptyThread(mode);
}
export function restoreFromContext(ctx: ExtensionContext): ThreadState { return restoreThread(ctx.sessionManager.getBranch()); }
