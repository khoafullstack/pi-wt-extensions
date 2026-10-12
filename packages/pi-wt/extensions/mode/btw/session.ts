import {
  createAgentSession, createExtensionRuntime, convertToLlm, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions, type ExtensionAPI,
  type ExtensionContext, type ModelRuntime, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../config.ts";
import { resolveBtwModel } from "../models.ts";
import { branchMessages } from "../transcript.ts";
import { answerText, emptyThread, resetThread, restoreFromContext, type BtwMode, type ThreadState } from "./state.ts";

export const readonlyTools = ["read", "grep", "find", "ls"];
export function btwResourceLoader(parentPrompt: string): ResourceLoader {
  const prompt = parentPrompt.replace(/<(?:cwd|date)>[\s\S]*?<\/(?:cwd|date)>\s*/g, "")
    .replace(/\nCurrent (?:date(?: and time)?|working directory):[^\n]*/g, "");
  const systemPrompt = `${prompt}\n\nYou are in an independent BTW side conversation. `
    + "Earlier messages are background from the main session. "
    + "Answer the user's side questions; do not continue the main agent's task. "
    + "Only the following capabilities are available, regardless of tools mentioned in inherited instructions.\n"
    + "<btw_capabilities>\nTools: read, grep, find, ls. Read-only access; no shell, edits, writes, advisor, MCP or delegation.\n</btw_capabilities>";
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** Pi 1.1.0's compatibility registry wraps this runtime privately (verified against installed SDK).
 * Sharing it preserves custom providers, virtual models and runtime-only credentials.
 * Fail explicitly on incompatible hosts instead of creating an unauthenticated parallel runtime.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime || typeof runtime.streamSimple !== "function") {
    throw new Error("wt-btw: this Pi version does not expose the registry runtime required by the sub-session (tested with Pi 1.1.0)");
  }
  return runtime;
}

type CreateSession = (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
export class BtwSession {
  state: ThreadState = emptyThread();
  liveText = "";
  currentQuestion = "";
  thinking = "";
  activity = "";
  error = "";
  pending = 0;
  generation = 0;
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private pi: ExtensionAPI;
  private createSession: CreateSession;
  private readConfig: typeof loadConfig;

  constructor(pi: ExtensionAPI, createSession: CreateSession = createAgentSession, readConfig = loadConfig) {
    this.pi = pi;
    this.createSession = createSession;
    this.readConfig = readConfig;
  }
  get busy(): boolean { return this.pending > 0; }
  get signal(): AbortSignal { return this.lifetime.signal; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private clearLive(): void { this.liveText = ""; this.currentQuestion = ""; this.thinking = ""; this.activity = ""; }

  /** Synchronously invalidates queued work before waiting for the old child to stop. */
  async dispose(): Promise<void> {
    this.generation++;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.pending = 0;
    this.queue = Promise.resolve();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    const session = this.session; this.session = undefined;
    this.clearLive(); this.changed();
    if (session) { try { await session.abort(); } finally { session.dispose(); } }
  }
  async restore(ctx: ExtensionContext): Promise<void> {
    this.state = restoreFromContext(ctx);
    this.error = "";
    await this.dispose();
  }
  async reset(mode: BtwMode = this.state.mode): Promise<void> {
    // Append immediately on the current branch; stale completions cannot follow this reset.
    this.state = resetThread(this.pi, mode);
    this.error = "";
    await this.dispose();
  }
  async abort(): Promise<void> {
    // Cancel queued prompts too. Keep the completed thread and reopen a clean child next time.
    await this.dispose();
  }

  private async ensureSession(ctx: ExtensionContext, generation: number): Promise<AgentSession> {
    const config = await this.readConfig(ctx);
    if (generation !== this.generation) throw new Error("wt-btw: thread changed");
    const model = resolveBtwModel(ctx, config.btw.model);
    const thinkingLevel = config.btw.thinkingLevel ?? ctx.thinkingLevel ?? this.pi.getThinkingLevel();
    if (this.session) {
      const session = this.session;
      if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
        await session.setModel(model, { persist: false });
      }
      if (generation !== this.generation) throw new Error("wt-btw: thread changed");
      session.setThinkingLevel(thinkingLevel, { persist: false });
      return session;
    }
    const manager = SessionManager.inMemory(ctx.cwd);
    if (this.state.mode === "context") {
      // Child owns its prompt and declarations. Never inherit the parent's system/tool loadout.
      for (const message of convertToLlm(branchMessages(ctx.sessionManager))) {
        if (message.role !== "system") manager.appendMessage(message);
      }
    }
    if (manager.getEntries().length || this.state.exchanges.length) {
      manager.appendMessage({ role: "user", content: "Background ends here. The following is the independent BTW thread.", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Understood. I will answer only the BTW side questions." }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    for (const turn of this.state.exchanges) {
      manager.appendMessage({ role: "user", content: turn.question, timestamp: turn.answer.timestamp });
      manager.appendMessage(turn.answer);
    }
    const { session } = await this.createSession({
      cwd: ctx.cwd, sessionManager: manager, model, modelRuntime: parentModelRuntime(ctx),
      thinkingLevel,
      tools: [...readonlyTools],
      resourceLoader: btwResourceLoader(ctx.getSystemPrompt()),
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
    });
    if (generation !== this.generation) {
      try { await session.abort(); } finally { session.dispose(); }
      throw new Error("wt-btw: thread changed");
    }
    this.session = session;
    this.unsubscribe = session.subscribe(event => { if (generation === this.generation) this.onEvent(event); });
    return session;
  }

  private onEvent(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.message.role === "assistant") {
      this.liveText = answerText(event.message);
      this.thinking = event.message.content.filter(block => block.type === "thinking").map(block => block.thinking).join("\n");
    } else if (event.type === "tool_execution_start") this.activity = `Reading: ${event.toolName}`;
    else if (event.type === "tool_execution_end") this.activity = event.isError ? `${event.toolName}: failed` : `${event.toolName}: done`;
    else if (event.type === "compaction_start") this.activity = "Compacting side thread…";
    this.changed();
  }

  prompt(question: string, ctx: ExtensionContext, save = false): Promise<string> {
    if (!question.trim()) return Promise.reject(new Error("wt-btw: question must not be empty"));
    const generation = this.generation;
    this.pending++;
    this.error = "";
    this.changed();
    const work = this.queue.then(async () => {
      if (generation !== this.generation) throw new Error("wt-btw: prompt cancelled");
      this.clearLive(); this.currentQuestion = question; this.changed();
      try {
        const session = await this.ensureSession(ctx, generation);
        if (generation !== this.generation) throw new Error("wt-btw: prompt cancelled");
        const start = session.messages.length;
        await session.prompt(question, { source: "extension", expandPromptTemplates: false });
        if (generation !== this.generation) throw new Error("wt-btw: prompt cancelled");
        const answer = session.messages.slice(start).filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
        if (!answer || answer.stopReason === "error" || answer.stopReason === "aborted") {
          throw new Error(answer?.errorMessage || "wt-btw: no answer returned");
        }
        const text = answerText(answer);
        if (!text.trim()) throw new Error("wt-btw: model returned no text");
        // Persist a standalone answer, without tool calls/signatures tied to the transient child.
        const saved: AssistantMessage = { ...answer, content: [{ type: "text", text }], stopReason: "stop" };
        const turn = { question, answer: saved };
        this.pi.appendEntry("wt-btw-thread-entry", turn);
        this.state.exchanges.push(turn);
        if (save || ctx.mode !== "tui") {
          this.pi.sendMessage({ customType: "wt-btw-note", content: `You: ${question}\n\nBTW: ${text}`, display: true },
            ctx.isIdle() ? undefined : { deliverAs: "followUp" });
        }
        return text;
      } catch (error) {
        if (generation === this.generation) {
          this.error = error instanceof Error ? error.message : String(error);
          // Failed/aborted turns must not contaminate subsequent questions.
          this.unsubscribe?.(); this.unsubscribe = undefined;
          const session = this.session; this.session = undefined;
          if (session) { try { await session.abort(); } finally { session.dispose(); } }
        }
        throw error;
      } finally {
        if (generation === this.generation) {
          this.pending--; this.clearLive(); this.changed();
        }
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
