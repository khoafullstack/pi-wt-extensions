import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { configPaths, defaultConfig, ensureGlobalConfig, loadConfig, saveConfig, validateConfig } from "../extensions/mode/config.ts";
import { defaultSettings } from "../extensions/settings.ts";
import { branchMessages, prepareTranscript } from "../extensions/mode/transcript.ts";
import { callModel } from "../extensions/mode/llm.ts";

const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "test", id: "model" } as Model<Api>;
function assistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: "test", model: "model", usage, stopReason: "stop", timestamp: 0 };
}
function caller(result: () => Promise<AssistantMessage>, signal?: AbortSignal) {
  const calls: unknown[][] = [];
  const ctx = { signal, modelRegistry: { streamSimple: (...args: unknown[]) => {
    calls.push(args); return { result };
  } } } as unknown as Pick<ExtensionContext, "modelRegistry" | "signal">;
  return { ctx, calls };
}

test("global config bootstrap creates complete defaults once and keeps existing user content", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-bootstrap-"));
  try {
    const paths = await Promise.all([ensureGlobalConfig(root), ensureGlobalConfig(root)]);
    assert.equal(paths[0], paths[1]);
    assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), defaultSettings());
    assert.deepEqual(await readdir(join(root, ".pi", "agent")), ["pi-wt-settings.json"]);
    const userConfig = '{"advisor":{"model":{"provider":"custom","id":"chosen"}}}\n';
    await writeFile(paths[0], userConfig);
    await ensureGlobalConfig(root);
    assert.equal(await readFile(paths[0], "utf8"), userConfig);
    await writeFile(paths[0], "{invalid JSON");
    await ensureGlobalConfig(root);
    assert.equal(await readFile(paths[0], "utf8"), "{invalid JSON");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bootstrap and a concurrent settings save preserve the chosen model", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-bootstrap-"));
  try {
    const ctx = { cwd: root, isProjectTrusted: () => false };
    const model = { provider: "custom", id: "chosen" };
    await Promise.all([ensureGlobalConfig(root), saveConfig(ctx, { advisor: { model } }, "global", root)]);
    assert.deepEqual((await loadConfig(ctx, root)).advisor.model, model);
    await Promise.all([saveConfig(ctx, { btw: { thinkingLevel: "high" } }, "global", root), ensureGlobalConfig(root)]);
    assert.equal((await loadConfig(ctx, root)).btw.thinkingLevel, "high");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config validates fields, inherits trusted overrides and serializes concurrent updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-mode-"));
  try {
    const ctx = { cwd: join(root, "project"), isProjectTrusted: () => true };
    const paths = configPaths(ctx, root);
    assert.deepEqual(await loadConfig(ctx, root), defaultConfig());
    assert.deepEqual(validateConfig({ advisor: { timeoutMs: -1, maxCallsPerRun: 2, thinkingLevel: "invalid" },
      btw: { model: { provider: "", id: "bad" }, thinkingLevel: "invalid" } }),
    { advisor: { maxCallsPerRun: 2 }, btw: {} });
    await Promise.all([
      saveConfig(ctx, { advisor: { model: { provider: "test", id: "strong" }, thinkingLevel: "high" } }, "global", root),
      saveConfig(ctx, { btw: { thinkingLevel: "high" } }, "global", root),
    ]);
    await saveConfig(ctx, { advisor: { maxOutputTokens: 2000 } }, "project", root);
    const loaded = await loadConfig(ctx, root);
    assert.equal(loaded.btw.thinkingLevel, "high");
    assert.equal(loaded.advisor.model?.id, "strong");
    assert.equal(loaded.advisor.thinkingLevel, "high");
    await saveConfig(ctx, { advisor: { thinkingLevel: null } }, "project", root);
    assert.equal((await loadConfig(ctx, root)).advisor.thinkingLevel, null);
    assert.equal((await loadConfig({ ...ctx, isProjectTrusted: () => false }, root)).advisor.thinkingLevel, "high");
    assert.equal(loaded.advisor.maxOutputTokens, 2000);
    assert.equal((await loadConfig({ ...ctx, isProjectTrusted: () => false }, root)).advisor.maxOutputTokens, 4096);
    await assert.rejects(saveConfig({ ...ctx, isProjectTrusted: () => false }, {}, "project", root), /not trusted/);
    assert.deepEqual((await readdir(join(root, ".pi", "agent"))).filter(name => name.endsWith(".tmp")), []);
    assert.equal(JSON.parse(await readFile(paths.global, "utf8")).advisor.maxOutputTokens, undefined);
    await writeFile(paths.global, "{broken");
    assert.equal((await loadConfig(ctx, root)).advisor.model, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untrusted project config is not read, corrupt and BOM config are tolerated", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-mode-"));
  try {
    const ctx = { cwd: root, isProjectTrusted: () => false };
    const paths = configPaths(ctx, root);
    await mkdir(paths.project, { recursive: true }); // Reading this directory would fail.
    assert.deepEqual(await loadConfig(ctx, root), defaultConfig());
    await mkdir(join(root, ".pi", "agent"), { recursive: true });
    await writeFile(paths.global, '\uFEFF{"btw":{"thinkingLevel":"low"}}');
    assert.equal((await loadConfig(ctx, root)).btw.thinkingLevel, "low");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transcript follows the active branch, filters BTW and honors context edits", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 0 });
  manager.appendMessage(assistant("wrong branch"));
  manager.branch(first);
  const current = manager.appendMessage(assistant("current"));
  manager.appendCustomEntry("wt-btw-thread-entry", { question: "secret" });
  manager.appendCustomMessageEntry("wt-btw-note", "side secret", true);
  manager.appendContextEdit(current, { content: [{ type: "text", text: "edited" }] });
  const before = JSON.stringify(manager.getEntries());
  const result = prepareTranscript(manager, { contextWindow: 32_000, question: "review" });
  const text = String(result.messages[0].content);
  assert.match(text, /first/);
  assert.match(text, /edited/);
  assert.doesNotMatch(text, /wrong branch|secret|current/);
  assert.equal(JSON.stringify(manager.getEntries()), before);
});

test("full advisor transcript retains history before compaction; BTW seed uses compacted context", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "original question", timestamp: 0 });
  const kept = manager.appendMessage(assistant("recent"));
  manager.appendCompaction("summary", kept, 100);
  manager.appendMessage({ role: "user", content: "latest", timestamp: 0 });
  assert.doesNotMatch(JSON.stringify(branchMessages(manager, "context")), /original question/);
  assert.match(JSON.stringify(branchMessages(manager, "full")), /original question/);
});

test("truncation caps tool results, drops old history, preserves first user and latest", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "first user", timestamp: 0 });
  manager.appendMessage({ role: "toolResult", toolCallId: "1", toolName: "read",
    content: [{ type: "text", text: "x".repeat(10_000) }], isError: false, timestamp: 0 });
  manager.appendMessage(assistant("old".repeat(1000)));
  manager.appendMessage({ role: "user", content: "latest user", timestamp: 0 });
  const before = JSON.stringify(manager.getEntries());
  const result = prepareTranscript(manager, { contextWindow: 1500, maxOutputTokens: 100, question: "review" });
  assert.equal(result.shortened, true);
  assert.ok(result.droppedMessages > 0);
  assert.ok(result.estimatedTokens <= 1200);
  assert.match(String(result.messages[0].content), /first user/);
  assert.match(String(result.messages[0].content), /latest user/);
  assert.match(String(result.messages[0].content), /Transcript shortened/);
  assert.equal(JSON.stringify(manager.getEntries()), before);
  assert.throws(() => prepareTranscript(manager, { contextWindow: 100, question: "q".repeat(1000) }), /exceed/);
});

test("single completion returns text and usage with no tools", async () => {
  const fake = caller(async () => assistant("advice"));
  assert.deepEqual(await callModel(fake.ctx, { model, messages: [] }), { text: "advice", usage });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual((fake.calls[0][1] as { tools: unknown[] }).tools, []);
  assert.equal((fake.calls[0][2] as { maxTokens: number }).maxTokens, 4096);
});

test("single completion rejects provider errors, empty text and tool/deferred results", async () => {
  for (const stopReason of ["error", "aborted", "toolUse", "deferred", "pending"] as const) {
    const fake = caller(async () => ({ ...assistant(""), stopReason }));
    await assert.rejects(callModel(fake.ctx, { model, messages: [] }));
  }
  await assert.rejects(callModel(caller(async () => assistant(" ")).ctx, { model, messages: [] }), /no text/);
});

test("pre-aborted signal prevents a request", async () => {
  const controller = new AbortController(); controller.abort();
  const fake = caller(async () => assistant("advice"), controller.signal);
  await assert.rejects(callModel(fake.ctx, { model, messages: [] }), /aborted/);
  assert.equal(fake.calls.length, 0);
});

test("timeout aborts and returns even when a provider ignores the signal", async () => {
  const fake = caller(() => new Promise(() => {}));
  await assert.rejects(callModel(fake.ctx, { model, messages: [], timeoutMs: 10 }), /timed out/);
  assert.equal((fake.calls[0][2] as { signal: AbortSignal }).signal.aborted, true);
});

test("caller and context signals both abort an in-flight request", async () => {
  for (const useContext of [true, false]) {
    const controller = new AbortController();
    const fake = caller(() => new Promise(() => {}), useContext ? controller.signal : undefined);
    const pending = callModel(fake.ctx, { model, messages: [], signal: useContext ? undefined : controller.signal });
    controller.abort();
    await assert.rejects(pending, /aborted/);
  }
});
