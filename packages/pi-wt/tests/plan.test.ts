import assert from "node:assert/strict";
import test from "node:test";
import { endedNormally } from "../extensions/plan/gate.ts";
import { registerPlan } from "../extensions/plan/index.ts";
import { PLAN_CHANGED_EVENT, restoreSnapshot } from "../extensions/plan/state.ts";
import { registerPromptEditor } from "../extensions/ui/prompt-editor.ts";
import { defaultConfig, validateConfig } from "../extensions/settings.ts";

function harness(initialTools = ["read", "write", "edit", "wt-ui-todo", "wt-plan-off"]) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  let active = [...initialTools];
  const notes: string[] = [];
  const changes: unknown[] = [];
  const pi = {
    events: { emit: (_channel: string, data: unknown) => changes.push(data), on: () => () => {} },
    on: (name: string, handler: any) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  const ctx = {
    cwd: process.cwd(), mode: "print", hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: { notify: (text: string) => notes.push(text) },
  };
  registerPlan(pi as never);
  return {
    ctx, entries, notes, changes, tools, commands, active: () => active,
    fire: (name: string, event: any = {}) => handlers.get(name)!(event, ctx),
    command: (args: string) => commands.get("wt-plan")!.handler(args, ctx),
    guidelines: async () => {
      const options = { promptGuidelines: [] as string[] };
      await handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
      return options.promptGuidelines;
    },
  };
}

const assistant = (stopReason = "stop") => ({ role: "assistant", stopReason });

test("settings default the plan shortcut to alt+m and validate overrides", () => {
  assert.equal(defaultConfig().plan.shortcut, "alt+m");
  assert.deepEqual(validateConfig({ plan: { shortcut: "ctrl+alt+p" } }).plan, { shortcut: "ctrl+alt+p" });
  assert.deepEqual(validateConfig({ plan: { shortcut: "Alt+Nope" } }).plan, {});
});

test("restoreSnapshot uses the latest valid entry and drops a gate for inactive plans", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: "wt-plan-state", data });
  assert.deepEqual(restoreSnapshot([]), { active: false, gateShown: false });
  assert.deepEqual(restoreSnapshot([entry({ active: true, gateShown: true }), entry({ junk: 1 })]), { active: true, gateShown: true });
  assert.deepEqual(restoreSnapshot([entry({ active: false, gateShown: true })]), { active: false, gateShown: false });
});

test("endedNormally looks at the last assistant message", () => {
  assert.equal(endedNormally([assistant("stop")]), true);
  assert.equal(endedNormally([assistant("stop"), assistant("aborted")]), false);
  assert.equal(endedNormally([assistant("error"), { role: "toolResult" }]), false);
  assert.equal(endedNormally([]), false);
});

test("plan mode blocks write and edit, adds guidelines and declares the exit tool only while on", async () => {
  const h = harness(["read", "write", "edit", "wt-ui-todo"]);
  assert.equal(h.fire("tool_call", { toolName: "write" }), undefined);
  assert.deepEqual(await h.guidelines(), []);

  await h.command("on");
  assert.ok(h.active().includes("wt-plan-off"));
  assert.equal(h.fire("tool_call", { toolName: "write" }).block, true);
  assert.equal(h.fire("tool_call", { toolName: "edit" }).block, true);
  assert.equal(h.fire("tool_call", { toolName: "read" }), undefined);
  assert.match((await h.guidelines()).join("\n"), /PLAN MODE is active/);
  assert.deepEqual(h.changes.at(-1), { active: true });

  await h.command("off");
  assert.ok(!h.active().includes("wt-plan-off"));
  assert.equal(h.fire("tool_call", { toolName: "write" }), undefined);
  assert.deepEqual(h.changes.at(-1), { active: false });
});

test("the exit tool needs a user reply after the review gate", async () => {
  const h = harness();
  await h.command("on");
  h.fire("input", { text: "plan the feature", source: "interactive" });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }).block, true, "no gate yet");

  h.fire("agent_end", { messages: [assistant()] });
  assert.ok(h.entries.some(entry => entry.customType === "wt-plan-gate"));
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }).block, true, "gate shown, no reply yet");
  await assert.rejects(h.tools.get("wt-plan-off").execute("1", {}, undefined, undefined, h.ctx), /until the user has replied/);

  h.fire("input", { text: "/wt-btw what?", source: "interactive" });
  h.fire("input", { text: "sent by extension", source: "extension" });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }).block, true, "commands and extension input do not confirm");

  h.fire("input", { text: "looks good, implement", source: "interactive" });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }), undefined);
  const result = await h.tools.get("wt-plan-off").execute("1", {}, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /wt-ui-todo/);
  assert.equal(result.details.active, false);
  assert.ok(!h.active().includes("wt-plan-off"));
  assert.equal(h.fire("tool_call", { toolName: "write" }), undefined);
  assert.deepEqual(await h.guidelines(), [], "the tool result already carried the checklist instruction");
});

test("a confirmation is consumed by the next plan turn", async () => {
  const h = harness();
  await h.command("on");
  h.fire("agent_end", { messages: [assistant()] });
  h.fire("input", { text: "also cover tests", source: "interactive" });
  h.fire("agent_end", { messages: [assistant()] });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }).block, true);
});

test("aborted runs do not open the gate", async () => {
  const h = harness();
  await h.command("on");
  h.fire("agent_end", { messages: [assistant("aborted")] });
  assert.ok(!h.entries.some(entry => entry.customType === "wt-plan-gate"));
  h.fire("input", { text: "go", source: "interactive" });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }).block, true);
});

test("turning plan mode off manually asks the next run to build a checklist once", async () => {
  const h = harness();
  await h.command("on");
  await h.command("off");
  const first = (await h.guidelines()).join("\n");
  assert.match(first, /turned off by the user/);
  assert.match(first, /wt-ui-todo/);
  assert.deepEqual(await h.guidelines(), []);
});

test("state is restored from the branch and invalid command arguments are rejected", async () => {
  const h = harness();
  await h.command("on");
  h.fire("agent_end", { messages: [assistant()] });
  await h.fire("session_start");
  assert.ok(h.active().includes("wt-plan-off"));
  h.fire("input", { text: "yes, implement", source: "interactive" });
  assert.equal(h.fire("tool_call", { toolName: "wt-plan-off" }), undefined, "the gate survives a restart");

  await h.command("status");
  assert.match(h.notes.at(-1)!, /Plan mode: on/);
  await assert.rejects(h.command("sideways"), /expected on, off or status/);
});

test("prompt editor shows PLAN in its top border while plan mode is on", () => {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const bus = new Map<string, (data: unknown) => void>();
  let factory: any;
  registerPromptEditor({
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { on: (channel: string, handler: any) => { bus.set(channel, handler); return () => {}; } },
  } as never);
  handlers.get("session_start")!({}, {
    cwd: process.cwd(), mode: "tui",
    ui: { theme: { fg: (_color: string, text: string) => `<${text}>` }, setEditorComponent: (f: unknown) => { factory = f; }, setWidget() {} },
  });
  const editor = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false, getKeys: () => [] });
  const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(plain(editor.render(40)[0]), `\u2500 wt \u276f ${"\u2500".repeat(33)}`);
  bus.get(PLAN_CHANGED_EVENT)!({ active: true });
  const line = plain(editor.render(40)[0]);
  assert.match(line, /^\u2500 wt \u276f <PLAN> \u2500+$/);
  assert.equal(line.length, 40);
  bus.get(PLAN_CHANGED_EVENT)!({ active: false });
  assert.doesNotMatch(plain(editor.render(40)[0]), /PLAN/);
});
