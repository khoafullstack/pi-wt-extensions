import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";

export interface SingleCallOptions {
  model: Model<Api>;
  messages: Context["messages"];
  systemPrompt?: string;
  reasoning?: SimpleStreamOptions["reasoning"] | "off";
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SingleCallResult { text: string; usage: Usage }

/** One authenticated completion, without tools or an agent loop. */
export async function callModel(
  ctx: Pick<ExtensionContext, "modelRegistry" | "signal">, options: SingleCallOptions,
): Promise<SingleCallResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxTokens = options.maxOutputTokens ?? 4096;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("wt-mode: invalid model call limits");
  const controller = new AbortController();
  const signals = [...new Set([ctx.signal, options.signal].filter((signal): signal is AbortSignal => !!signal))];
  const abort = () => controller.abort(new Error("wt-mode: model call aborted"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (const signal of signals) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    // Race even non-cooperative providers so the caller's deadline is enforced.
    const request = async () => {
      controller.signal.throwIfAborted();
      const response = await ctx.modelRegistry.streamSimple(options.model, {
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        tools: [],
      }, { signal: controller.signal, maxTokens, reasoning: options.reasoning === "off" ? undefined : options.reasoning }).result();
      controller.signal.throwIfAborted();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `wt-mode: model call ${response.stopReason}`);
      }
      if (response.stopReason === "toolUse" || response.stopReason === "deferred" || response.stopReason === "pending") {
        throw new Error(`wt-mode: expected a single text completion, received ${response.stopReason}`);
      }
      const text = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (!text.trim()) throw new Error("wt-mode: model returned no text");
      return { text, usage: response.usage };
    };
    timer = setTimeout(() => controller.abort(new Error(`wt-mode: model call timed out after ${timeoutMs} ms`)), timeoutMs);
    return await Promise.race([request(), aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
