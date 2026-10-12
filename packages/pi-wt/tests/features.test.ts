import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, initTheme, ModelRegistry, ModelRuntime, SessionManager,
  type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerAdvisor } from "../extensions/mode/advisor.ts";
import { defaultConfig } from "../extensions/mode/config.ts";
import { resolveBtwModel } from "../extensions/mode/models.ts";
import { ModelSelector } from "../extensions/mode/model-selector.ts";
import { branchMessages } from "../extensions/mode/transcript.ts";
import { parseBtwArgs, registerBtw, selectFocusShortcut } from "../extensions/mode/btw/commands.ts";
import { BtwOverlayComponent } from "../extensions/mode/btw/overlay.ts";
import { BtwSession, btwResourceLoader } from "../extensions/mode/btw/session.ts";
import { restoreThread } from "../extensions/mode/btw/state.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<Api> = { id: "test-model", provider: "wt-test", api: "openai-completions", name: "Test",
  baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function answer(text = "side answer"): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], usage, stopReason: "stop", timestamp: Date.now() };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function host() {
  const manager = SessionManager.inMemory();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const events = new Map<string, ((event: any, ctx: any) => any)[]>();
  const notes: any[] = [], sent: any[] = [], notifications: string[] = [];
  const pi = {
    on: (name: string, callback: (event: any, ctx: any) => any) => { events.set(name, [...events.get(name) ?? [], callback]); return () => {}; },
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
    registerShortcut: () => {}, registerMessageRenderer: () => {},
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    sendMessage: (message: any, options: any) => { notes.push({ message, options }); manager.appendCustomMessageEntry(message.customType, message.content, true); },
    sendUserMessage: (content: unknown, options: unknown) => sent.push({ content, options }),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const config = defaultConfig();
  let completionCount = 0;
  const completionOptions: { reasoning?: string }[] = [];
  const registry = {
    runtime: { streamSimple: () => {} },
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getAvailable: () => [model], hasConfiguredAuth: (selected: Model<Api>) => selected.id === model.id,
    streamSimple: (_model: unknown, _context: unknown, options: { reasoning?: string }) => {
      completionCount++; completionOptions.push(options); return { result: async () => answer("advisor answer") };
    },
  };
  const ctx = {
    cwd: process.cwd(), sessionManager: manager, model, modelRegistry: registry, mode: "print", hasUI: false,
    thinkingLevel: "medium", signal: undefined, isIdle: () => true, isProjectTrusted: () => false,
    getSystemPrompt: () => "Parent prompt\n<cwd>\nold cwd\n</cwd>",
    ui: { notify: (message: string) => notifications.push(message), confirm: async () => false, select: async () => undefined },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  return { pi, ctx, config, manager, commands, tools, events, notes, sent, notifications,
    configIO: { load: async () => config, save: async () => {} },
    completions: () => completionCount, completionOptions,
    emit: async (name: string) => { for (const callback of events.get(name) ?? []) await callback({ type: name }, ctx); },
  };
}
function fakeChildren(onPrompt?: (question: string) => Promise<void>) {
  const options: CreateAgentSessionOptions[] = [];
  const children: { disposed: boolean; aborted: boolean; messages: any[] }[] = [];
  let active = 0, maxActive = 0;
  const create = async (input: CreateAgentSessionOptions) => {
    options.push(input);
    const child = { disposed: false, aborted: false, messages: [...input.sessionManager!.buildSessionContext().messages] };
    children.push(child);
    let listen: ((event: AgentSessionEvent) => void) | undefined;
    let selectedModel = input.model, selectedThinking = input.thinkingLevel;
    const session = {
      get model() { return selectedModel; },
      get thinkingLevel() { return selectedThinking; },
      setModel: async (model: Model<Api>) => { selectedModel = model; },
      setThinkingLevel: (level: typeof selectedThinking) => { selectedThinking = level; },
      messages: child.messages,
      subscribe: (callback: (event: AgentSessionEvent) => void) => { listen = callback; return () => { listen = undefined; }; },
      prompt: async (question: string) => {
        active++; maxActive = Math.max(active, maxActive);
        try {
          child.messages.push({ role: "user", content: question, timestamp: Date.now() });
          listen?.({ type: "message_update", message: answer("streaming"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming", partial: answer("streaming") } });
          await onPrompt?.(question);
          child.messages.push(answer(question));
        } finally { active--; }
      },
      abort: async () => { child.aborted = true; },
      dispose: () => { child.disposed = true; },
    } as unknown as AgentSession;
    return { session };
  };
  return { create, options, children, maxActive: () => maxActive };
}

test("advisor stays registered when unavailable and makes no request", async () => {
  const h = host(); registerAdvisor(h.pi, h.configIO);
  await assert.rejects(h.tools.get("wt-advisor")!.execute("1", { question: "review" }, undefined, undefined, h.ctx), /unavailable.*Do not retry/);
  assert.equal(h.completions(), 0);
});

test("advisor caps concurrent calls, returns usage and resets each run", async () => {
  const h = host(); h.config.advisor.model = { provider: model.provider, id: model.id };
  h.manager.appendMessage({ role: "user", content: "main task", timestamp: 0 });
  registerAdvisor(h.pi, h.configIO);
  const call = () => h.tools.get("wt-advisor")!.execute("1", { question: "review", focus: "risks" }, undefined, undefined, h.ctx);
  const results = await Promise.allSettled([call(), call(), call(), call()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  assert.equal(h.completions(), 3);
  const first = results.find(result => result.status === "fulfilled");
  assert.ok(first && first.status === "fulfilled"); assert.deepEqual(first.value.usage, usage);
  await h.emit("agent_start"); await call(); assert.equal(h.completions(), 4);
});

test("model selector supports inline IDs, clear and stores the selected model", async () => {
  const h = host(); const patches: unknown[] = [];
  registerAdvisor(h.pi, { ...h.configIO, save: async (_ctx, patch) => { patches.push(patch); } });
  await h.commands.get("wt-advisor")!.handler(`${model.provider}/${model.id}`, h.ctx);
  await h.commands.get("wt-advisor")!.handler("clear", h.ctx);
  assert.deepEqual(patches, [{ advisor: { model: { provider: model.provider, id: model.id } } }, { advisor: { model: null } }]);
});

test("advisor forwards configured or inherited thinking and reports it in results", async () => {
  for (const override of ["high", "off", null] as const) {
    const h = host(); h.config.advisor.model = { provider: model.provider, id: model.id };
    h.config.advisor.thinkingLevel = override; h.ctx.thinkingLevel = "low";
    registerAdvisor(h.pi, h.configIO);
    const result = await h.tools.get("wt-advisor")!.execute("1", { question: "review" }, undefined, undefined, h.ctx);
    assert.equal(h.completionOptions[0].reasoning, override === "off" ? undefined : override ?? "low");
    assert.equal(result.details.thinkingLevel, override ?? "low");
  }
});

test("advisor thinking command saves levels, clears inheritance and rejects invalid input", async () => {
  const h = host(); const patches: unknown[] = [];
  registerAdvisor(h.pi, { ...h.configIO, save: async (_ctx, patch) => {
    patches.push(patch); Object.assign(h.config.advisor, patch.advisor);
  } });
  const command = h.commands.get("wt-advisor-thinking")!;
  await command.handler("high", h.ctx); await command.handler("clear", h.ctx);
  await assert.rejects(command.handler("invalid", h.ctx), /expected/);
  await assert.rejects(command.handler("", h.ctx), /inline thinking level/);
  assert.deepEqual(patches, [{ advisor: { thinkingLevel: "high" } }, { advisor: { thinkingLevel: null } }]);
  assert.deepEqual(h.notifications, ["Advisor thinking: high", "Advisor thinking: inherit main"]);
});

test("advisor thinking dialog cancels and cannot save after shutdown", async () => {
  const h = host(), choice = deferred<string | undefined>();
  h.ctx.hasUI = true;
  let saved = false;
  registerAdvisor(h.pi, { ...h.configIO, save: async () => { saved = true; } });
  await h.commands.get("wt-advisor-thinking")!.handler("", h.ctx);
  h.ctx.ui.select = async () => choice.promise;
  const selecting = h.commands.get("wt-advisor-thinking")!.handler("", h.ctx);
  await h.emit("session_shutdown"); choice.resolve("high");
  await selecting; assert.equal(saved, false);
});

test("advisor model dialog cannot save settings after session shutdown", async () => {
  const h = host(), choice = deferred<string | undefined>();
  h.ctx.hasUI = true; h.ctx.ui.select = async () => choice.promise;
  let saved = false;
  registerAdvisor(h.pi, { ...h.configIO, save: async () => { saved = true; } });
  const selecting = h.commands.get("wt-advisor")!.handler("", h.ctx);
  await h.emit("session_shutdown"); choice.resolve(`${model.provider}/${model.id}`);
  await selecting; assert.equal(saved, false);
});

test("model selector scrolls to the last option and preserves selection after resize", () => {
  let rows = 24, selected: string | undefined;
  const options = Array.from({ length: 80 }, (_, i) => `provider/model-${i}`);
  const plain = (text: string) => text;
  const selector = new ModelSelector({ terminal: { get rows() { return rows; } }, requestRender: () => {} } as any,
    "Advisor", options, { selectedPrefix: plain, selectedText: plain, description: plain,
      scrollInfo: plain, noMatch: plain }, choice => { selected = choice; });
  for (let i = 0; i < 79; i++) selector.handleInput("\x1b[B");
  let lines = selector.render(50);
  assert.ok(lines.some(line => line.includes("→ provider/model-79")));
  assert.ok(lines.length <= rows);
  rows = 10; lines = selector.render(30);
  assert.ok(lines.some(line => line.includes("→ provider/model-79")));
  assert.ok(lines.length <= rows); assert.ok(lines.every(line => visibleWidth(line) <= 30));
  selector.handleInput("\r"); assert.equal(selected, options[79]);
  selector.handleInput("\x1b"); assert.equal(selected, undefined);
});

test("advisor uses the scrolling selector in TUI and saves its chosen model", async () => {
  initTheme("dark", false);
  const h = host(); h.ctx.mode = "tui"; h.ctx.hasUI = true;
  let patch: unknown;
  h.ctx.ui.select = async () => { throw new Error("Unbounded dialog must not be used in TUI"); };
  h.ctx.ui.custom = async (factory: any) => new Promise<any>(resolve => {
    const component = factory({ terminal: { rows: 24 }, requestRender: () => {} }, {}, {}, resolve);
    assert.ok(component instanceof ModelSelector);
    component.handleInput("\x1b[B"); component.handleInput("\r");
  });
  registerAdvisor(h.pi, { ...h.configIO, save: async (_ctx, value) => { patch = value; } });
  await h.commands.get("wt-advisor")!.handler("", h.ctx);
  assert.deepEqual(patch, { advisor: { model: { provider: model.provider, id: model.id } } });
});

test("model search matches provider/model substrings, edits query and preserves filtered selection on resize", () => {
  let rows = 24, selected: string | undefined;
  const plain = (text: string) => text;
  const selector = new ModelSelector({ terminal: { get rows() { return rows; } }, requestRender: () => {} } as any,
    "Models", ["clear", "alpha/model-one", "beta/model-one", "beta/model-two"],
    { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
    choice => { selected = choice; });
  selector.focused = true;
  for (const key of "BETA model") selector.handleInput(key);
  assert.ok(selector.render(60).some(line => line.includes("→ beta/model-one")));
  assert.ok(!selector.render(60).some(line => line.includes("alpha/model-one")));
  selector.handleInput("\x1b[B"); rows = 10;
  assert.ok(selector.render(60).some(line => line.includes("→ beta/model-two")));
  selector.handleInput("\r"); assert.equal(selected, "beta/model-two");
  selector.handleInput("x");
  assert.ok(selector.render(60).some(line => line.includes("No matching models")));
  selected = undefined; selector.handleInput("\r"); assert.equal(selected, undefined);
  selector.handleInput("\x7f");
  assert.ok(selector.render(60).some(line => line.includes("→ beta/model-one")));
  selector.handleInput("\x15"); // Ctrl+U clears the search input.
  assert.ok(selector.render(60).some(line => line.includes("→ clear")));
  selector.handleInput("\r"); assert.equal(selected, "clear");
});

test("side prompts serialize, reuse one child and never change main model context", async () => {
  const h = host(), child = fakeChildren(async () => { await Promise.resolve(); });
  h.ctx.mode = "tui";
  h.manager.appendMessage({ role: "user", content: "main task", timestamp: 0 });
  const before = JSON.stringify(branchMessages(h.manager));
  const thread = new BtwSession(h.pi, child.create, h.configIO.load);
  const replies = await Promise.all([thread.prompt("one", h.ctx), thread.prompt("two", h.ctx)]);
  assert.deepEqual(replies, ["one", "two"]);
  assert.equal(child.maxActive(), 1); assert.equal(child.children.length, 1);
  assert.equal(thread.busy, false); assert.equal(thread.state.exchanges.length, 2);
  assert.equal(JSON.stringify(branchMessages(h.manager)), before);
  assert.equal(h.notes.length, 0);
  assert.deepEqual(child.options[0].tools, ["read", "grep", "find", "ls"]);
  assert.equal(child.options[0].resourceLoader!.getExtensions().extensions.length, 0);
  assert.match(JSON.stringify(child.children[0].messages), /main task/);
  await thread.dispose(); await thread.dispose();
  assert.equal(child.children[0].disposed, true);
});

test("context mode inherits main messages, removes BTW notes and restores completed exchanges", async () => {
  const h = host(), child = fakeChildren();
  h.ctx.mode = "tui";
  h.manager.appendMessage({ role: "user", content: "main task", timestamp: 0 });
  h.manager.appendCustomMessageEntry("wt-btw-note", "private note", true);
  const thread = new BtwSession(h.pi, child.create, h.configIO.load);
  await thread.reset("context"); await thread.prompt("side task", h.ctx);
  assert.match(JSON.stringify(child.options[0].sessionManager!.getEntries()), /main task/);
  assert.doesNotMatch(JSON.stringify(child.options[0].sessionManager!.getEntries()), /private note/);
  assert.equal(restoreThread(h.manager.getBranch()).exchanges.length, 1);
  await thread.restore(h.ctx); await thread.prompt("next", h.ctx);
  assert.equal(child.children.length, 2);
  assert.match(JSON.stringify(child.options[1].sessionManager!.getEntries()), /side task/);
  await thread.reset(); assert.equal(thread.state.exchanges.length, 0);
  assert.equal(restoreThread(h.manager.getBranch()).mode, "context");
  await thread.dispose();
});

test("generation guard drops in-flight and queued replies after reset", async () => {
  const h = host(), entered = deferred(), gate = deferred();
  const child = fakeChildren(async () => { entered.resolve(); await gate.promise; });
  h.ctx.mode = "tui";
  const thread = new BtwSession(h.pi, child.create, h.configIO.load);
  const first = thread.prompt("old", h.ctx), queued = thread.prompt("queued", h.ctx);
  const settled = Promise.allSettled([first, queued]);
  await entered.promise; await thread.reset("context"); gate.resolve();
  const result = await settled;
  assert.ok(result.every(item => item.status === "rejected"));
  assert.equal(thread.state.exchanges.length, 0);
  assert.equal(restoreThread(h.manager.getBranch()).exchanges.length, 0);
  assert.equal(child.children[0].disposed, true);
});

test("reset during child creation disposes the stale child before any prompt", async () => {
  const h = host(), entered = deferred(), gate = deferred(), child = fakeChildren();
  const thread = new BtwSession(h.pi, async options => { entered.resolve(); await gate.promise; return child.create(options); }, h.configIO.load);
  const pending = thread.prompt("old", h.ctx); const settled = Promise.allSettled([pending]);
  await entered.promise; await thread.reset(); gate.resolve(); await settled;
  assert.equal(child.children[0].disposed, true);
  assert.equal(h.notes.length, 0); assert.equal(thread.state.exchanges.length, 0);
});

test("save and non-TUI replies produce filtered visible notes, queued while main is busy", async () => {
  const h = host(), child = fakeChildren();
  const thread = new BtwSession(h.pi, child.create, h.configIO.load);
  h.ctx.isIdle = () => false;
  await thread.prompt("non-TUI", h.ctx);
  h.ctx.mode = "tui"; await thread.prompt("saved", h.ctx, true);
  assert.equal(h.notes.length, 2);
  assert.ok(h.notes.every(note => note.options.deliverAs === "followUp"));
  assert.equal(branchMessages(h.manager).length, 0);
  await thread.dispose();
});

test("auth fallback chooses main and reports missing models/credentials", () => {
  const h = host();
  assert.equal(resolveBtwModel(h.ctx, { provider: "missing", id: "missing" }), model);
  assert.match(h.notifications[0], /using main/);
  h.ctx.model = undefined; assert.throws(() => resolveBtwModel(h.ctx, null), /no main model/);
  h.ctx.model = model; h.ctx.modelRegistry.hasConfiguredAuth = () => false;
  assert.throws(() => resolveBtwModel(h.ctx, null), /no credentials/);
});

test("commands enforce inline questions, use context and clear the side thread", async () => {
  const h = host(), child = fakeChildren(), thread = new BtwSession(h.pi, child.create, h.configIO.load);
  const patches: unknown[] = [];
  registerBtw(h.pi, { thread, load: h.configIO.load, save: async (_ctx, patch) => { patches.push(patch); } });
  await assert.rejects(h.commands.get("wt-btw")!.handler("", h.ctx), /inline question/);
  await h.commands.get("wt-btw")!.handler("question", h.ctx);
  assert.equal(thread.state.mode, "context");
  await h.commands.get("wt-btw-config")!.handler("clear clear", h.ctx);
  assert.deepEqual(patches, [{ btw: { model: null, thinkingLevel: null } }]);
  await h.commands.get("wt-btw-clear")!.handler("", h.ctx);
  assert.equal(thread.state.exchanges.length, 0);
  await h.emit("session_shutdown"); await h.emit("session_shutdown");
});

test("BTW config chooses model then thinking and saves once while keeping completed exchanges", async () => {
  const h = host(), child = fakeChildren(), thread = new BtwSession(h.pi, child.create, h.configIO.load);
  await thread.prompt("previous question", h.ctx);
  h.ctx.hasUI = true;
  const titles: string[] = [], patches: unknown[] = [];
  h.ctx.ui.select = async title => {
    titles.push(title); return titles.length === 1 ? `${model.provider}/${model.id}` : "high";
  };
  registerBtw(h.pi, { thread, load: h.configIO.load, save: async (_ctx, patch) => {
    patches.push(patch); Object.assign(h.config.btw, patch.btw);
  } });
  await h.commands.get("wt-btw-config")!.handler("", h.ctx);
  assert.match(titles[0], /model/); assert.match(titles[1], /thinking/);
  assert.deepEqual(patches, [{ btw: { model: { provider: model.provider, id: model.id }, thinkingLevel: "high" } }]);
  assert.equal(child.children[0].disposed, true); assert.equal(thread.state.exchanges.length, 1);
  assert.match(h.notifications[0], /thinking: high/);
  await thread.dispose();
});

test("BTW config cancels either step without saving and ignores a stale thinking dialog", async () => {
  const h = host(), thread = new BtwSession(h.pi), patches: unknown[] = [];
  h.ctx.hasUI = true;
  registerBtw(h.pi, { thread, load: h.configIO.load, save: async (_ctx, patch) => { patches.push(patch); } });
  const command = h.commands.get("wt-btw-config")!;
  await command.handler("", h.ctx); // Cancel model selection.
  let step = 0;
  h.ctx.ui.select = async () => ++step === 1 ? `${model.provider}/${model.id}` : undefined;
  await command.handler("", h.ctx); // Cancel thinking selection.
  const choice = deferred<string | undefined>(), entered = deferred();
  h.ctx.ui.select = async () => { entered.resolve(); return choice.promise; };
  const pending = command.handler(`${model.provider}/${model.id}`, h.ctx);
  await entered.promise; await thread.reset(); choice.resolve("high"); await pending;
  assert.deepEqual(patches, []);
  await thread.dispose();
});

test("BTW clear rebuilds from fresh main context; legacy contextless threads restore in context mode", async () => {
  const h = host(), child = fakeChildren(), thread = new BtwSession(h.pi, child.create, h.configIO.load);
  h.manager.appendCustomEntry("wt-btw-thread-reset", { mode: "contextless" });
  assert.equal(restoreThread(h.manager.getBranch()).mode, "context");
  registerBtw(h.pi, { thread, load: h.configIO.load });
  await h.commands.get("wt-btw")!.handler("first", h.ctx);
  h.manager.appendMessage({ role: "user", content: "new main context", timestamp: 0 });
  await h.commands.get("wt-btw-clear")!.handler("", h.ctx);
  await h.commands.get("wt-btw")!.handler("second", h.ctx);
  assert.match(JSON.stringify(child.options[1].sessionManager!.getEntries()), /new main context/);
  assert.equal(thread.state.exchanges.length, 1);
  await assert.rejects(h.commands.get("wt-btw-config")!.handler("clear", h.ctx), /model and thinking level inline/);
  await assert.rejects(h.commands.get("wt-btw-config")!.handler("clear invalid", h.ctx), /choose/);
  assert.equal(h.sent.length, 0);
  await thread.dispose();
});

test("session setup cannot recreate terminal listeners after shutdown during cleanup", async () => {
  const h = host(), thread = new BtwSession(h.pi), entered = deferred(), gate = deferred();
  let attached = false;
  h.ctx.mode = "tui";
  h.ctx.ui.onTerminalInput = () => { attached = true; return () => {}; };
  thread.restore = async () => { thread.generation++; entered.resolve(); await gate.promise; };
  registerBtw(h.pi, { thread, load: h.configIO.load });
  const setup = h.emit("session_start");
  await entered.promise; await h.emit("session_shutdown"); gate.resolve(); await setup;
  assert.equal(attached, false);
});

test("options and shortcuts preserve literal question text and avoid editor conflicts", () => {
  assert.deepEqual(parseBtwArgs("--save hello"), { save: true, question: "hello" });
  assert.deepEqual(parseBtwArgs("explain --save"), { save: false, question: "explain --save" });
  assert.equal(selectFocusShortcut("alt+b", "ctrl+alt+b", { wordLeft: ["ctrl+left", "alt+b"] }), "ctrl+alt+b");
  assert.equal(selectFocusShortcut("alt+b", "ctrl+alt+b", { one: "alt+b", two: "ctrl+alt+b" }), undefined);
  const loader = btwResourceLoader("parent\n<cwd>old</cwd>\nCurrent date: old");
  assert.doesNotMatch(loader.getSystemPrompt()!, /old/); assert.match(loader.getSystemPrompt()!, /btw_capabilities/);
});

test("overlay Esc aborts a busy thread before dismissing; focus is delegated to composer", async () => {
  const h = host(), thread = new BtwSession(h.pi);
  let closed = 0, aborted = 0;
  thread.pending = 1;
  thread.abort = async () => { aborted++; thread.pending = 0; };
  // Rendering uses the actual Pi theme in the integration smoke test; input needs no terminal.
  const component = new BtwOverlayComponent({ requestRender: () => {} } as any,
    { fg: (_color: string, text: string) => text } as any, thread, () => {}, () => { closed++; }, "ctrl+alt+b", () => {});
  component.focused = true; assert.equal(component.focused, true);
  component.handleInput("\x1b"); assert.equal(aborted, 1); assert.equal(closed, 0);
  component.handleInput("\x1b"); assert.equal(closed, 1); component.dispose();
});

test("saved notes stay out of compaction and branch summary preparations", async () => {
  const h = host(); registerBtw(h.pi, { load: h.configIO.load });
  h.manager.appendMessage({ role: "user", content: "main", timestamp: 0 });
  h.manager.appendCustomMessageEntry("wt-btw-note", "side secret", true);
  const messages = h.manager.buildSessionContext().messages;
  const compact = { preparation: { messagesToSummarize: messages, turnPrefixMessages: messages } };
  h.events.get("session_before_compact")![0](compact, h.ctx);
  assert.doesNotMatch(JSON.stringify(compact), /side secret/);
  const entries = h.manager.getBranch();
  h.events.get("session_before_tree")![0]({ preparation: { entriesToSummarize: entries } }, h.ctx);
  assert.doesNotMatch(JSON.stringify(entries), /side secret/);
  assert.match(JSON.stringify(h.manager.getEntries()), /side secret/); // Stored visible note is unchanged.
});

test("overlay renders streaming/thinking/activity within viewport bounds", () => {
  initTheme("dark", false);
  const h = host(), thread = new BtwSession(h.pi);
  thread.liveText = "Answer " + "wrapped text ".repeat(30); thread.thinking = "Considering options";
  thread.activity = "Reading: read";
  const component = new BtwOverlayComponent({ requestRender: () => {}, terminal: { rows: 30 } } as any,
    { fg: (_color: string, text: string) => text } as any, thread, () => {}, () => {}, "ctrl+alt+b", () => {});
  component.focused = true;
  for (const width of [25, 60, 100]) {
    const lines = component.render(width);
    assert.ok(lines.length <= 27);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /Reading/);
    assert.match(lines[0], /^╭.*╮$/);
    assert.match(lines.at(-1)!, /^╰.*╯$/);
  }
  component.dispose();
});

test("overlay keeps a constant height and scrolls long conversations with position markers", () => {
  initTheme("dark", false);
  const h = host(), thread = new BtwSession(h.pi);
  const component = new BtwOverlayComponent({ requestRender: () => {}, terminal: { rows: 30 } } as any,
    { fg: (_color: string, text: string) => text } as any, thread, () => {}, () => {}, "ctrl+alt+b", () => {});
  const short = component.render(60);
  assert.doesNotMatch(short.at(-1)!, /↑/);
  thread.liveText = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n");
  const bottom = component.render(60);
  assert.equal(bottom.length, short.length);
  assert.match(bottom.join("\n"), /line 79/);
  assert.match(bottom.at(-1)!, /↓0/);
  component.handleInput("\x1b[5~");
  const scrolled = component.render(60);
  assert.equal(scrolled.length, short.length);
  assert.doesNotMatch(scrolled.join("\n"), /line 79/);
  assert.match(scrolled.at(-1)!, /↓[1-9]/);
  component.handleInput("\x1b[6~");
  assert.match(component.render(60).join("\n"), /line 79/);
  component.dispose();
});

test("real Pi SDK child declares only read tools, loads no extensions and preserves parent context", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-sdk-"));
  const h = host(); h.ctx.mode = "tui"; h.ctx.cwd = root;
  h.manager.appendMessage({ role: "user", content: "main context", timestamp: 0 });
  const before = JSON.stringify(branchMessages(h.manager));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const declarations: string[][] = [];
  runtime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, apiKey: "test-only", api: model.api,
    models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
    streamSimple: (selected, context) => {
      declarations.push(getCurrentTools(context.messages).map(tool => tool.name).sort());
      const stream = createAssistantMessageEventStream();
      const response = { ...answer(), api: selected.api, provider: selected.provider, model: selected.id };
      stream.push({ type: "start", partial: response });
      stream.push({ type: "done", reason: "stop", message: response }); stream.end(); return stream;
    },
  });
  h.ctx.modelRegistry = new ModelRegistry(runtime); h.ctx.model = h.ctx.modelRegistry.find(model.provider, model.id)!;
  let child: AgentSession | undefined;
  const thread = new BtwSession(h.pi, async options => {
    const result = await createAgentSession(options); child = result.session;
    assert.equal(result.extensionsResult.extensions.length, 0);
    return result;
  }, h.configIO.load);
  try {
    await thread.reset("context"); await thread.prompt("side question", h.ctx);
    assert.deepEqual(child!.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
    assert.deepEqual(declarations, [["find", "grep", "ls", "read"]]);
    assert.equal(JSON.stringify(branchMessages(h.manager)), before);
    assert.equal(thread.state.exchanges.length, 1);
  } finally { await thread.dispose(); await rm(root, { recursive: true, force: true }); }
});
