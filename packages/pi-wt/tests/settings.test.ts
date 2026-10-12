import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPaths, ensureSettings, loadConfig, loadSettings, saveConfig } from "../extensions/settings.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "wt-unified-"));
  const ctx = { cwd: join(home, "project"), isProjectTrusted: () => true };
  const paths = configPaths(ctx, home);
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
  return { home, ctx, paths, legacy: join(home, ".pi", "agent", "wt-mode.json"),
    cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("migration keeps UI flags, imports legacy mode once and preserves canonical mode overrides", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.global, JSON.stringify({ welcome: false, extra: "keep", advisor: { thinkingLevel: "high" } }));
    const legacy = JSON.stringify({ advisor: { model: { provider: "test", id: "strong" }, thinkingLevel: "low" },
      btw: { thinkingLevel: "off" } });
    await writeFile(f.legacy, legacy);
    await Promise.all([ensureSettings(f.ctx, f.home), ensureSettings(f.ctx, f.home)]);
    const config = await loadConfig(f.ctx, f.home);
    assert.equal(config.advisor.thinkingLevel, "high"); assert.equal(config.advisor.model?.id, "strong");
    assert.equal(config.btw.thinkingLevel, "off");
    assert.equal(loadSettings(f.ctx.cwd, f.home).settings.welcome, false);
    const saved = JSON.parse(await readFile(f.paths.global, "utf8")); assert.equal(saved.extra, "keep");
    const entries = await readdir(join(f.home, ".pi", "agent"));
    assert.ok(!entries.includes("wt-mode.json"));
    const backup = entries.find(name => name.endsWith(".migrated.bak")); assert.ok(backup);
    assert.equal(await readFile(join(f.home, ".pi", "agent", backup), "utf8"), legacy);
    const before = await readFile(f.paths.global, "utf8"); await ensureSettings(f.ctx, f.home);
    assert.equal(await readFile(f.paths.global, "utf8"), before);
  } finally { await f.cleanup(); }
});

test("trusted project migration keeps scope sparse and untrusted mode overrides are ignored", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.global, JSON.stringify({ advisor: { thinkingLevel: "high", maxOutputTokens: 2222 } }));
    const legacy = join(f.ctx.cwd, ".pi", "wt-mode.json");
    await writeFile(legacy, JSON.stringify({ advisor: { thinkingLevel: "low" } }));
    const untrusted = { ...f.ctx, isProjectTrusted: () => false };
    await ensureSettings(untrusted, f.home);
    assert.equal((await loadConfig(untrusted, f.home)).advisor.thinkingLevel, "high");
    assert.ok((await readdir(join(f.ctx.cwd, ".pi"))).includes("wt-mode.json"));
    await ensureSettings(f.ctx, f.home);
    assert.deepEqual(JSON.parse(await readFile(f.paths.project, "utf8")), { btw: {}, advisor: { thinkingLevel: "low" } });
    const config = await loadConfig(f.ctx, f.home);
    assert.equal(config.advisor.thinkingLevel, "low"); assert.equal(config.advisor.maxOutputTokens, 2222);
    assert.equal((await loadConfig(untrusted, f.home)).advisor.thinkingLevel, "high");
  } finally { await f.cleanup(); }
});

test("saving mode settings preserves UI and unknown fields with concurrent updates", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.global, JSON.stringify({ welcome: false, toolCards: false, custom: { value: 42 } }));
    await Promise.all([
      saveConfig(f.ctx, { advisor: { thinkingLevel: "max" } }, "global", f.home),
      saveConfig(f.ctx, { btw: { thinkingLevel: "off" } }, "global", f.home),
    ]);
    const saved = JSON.parse(await readFile(f.paths.global, "utf8"));
    assert.equal(saved.welcome, false); assert.equal(saved.toolCards, false); assert.deepEqual(saved.custom, { value: 42 });
    assert.equal(saved.advisor.thinkingLevel, "max"); assert.equal(saved.btw.thinkingLevel, "off");
    await writeFile(f.paths.project, JSON.stringify({ welcome: true, advisor: { thinkingLevel: "low" } }));
    const ui = loadSettings(f.ctx.cwd, f.home);
    assert.equal(ui.settings.welcome, true);
    assert.ok(!ui.errors.some(error => error.includes('"advisor"') || error.includes('"btw"')));
  } finally { await f.cleanup(); }
});

test("migration and saves cannot overwrite corrupt canonical settings", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.global, "{invalid"); await writeFile(f.legacy, '{"advisor":{"thinkingLevel":"high"}}');
    await assert.rejects(ensureSettings(f.ctx, f.home), SyntaxError);
    await assert.rejects(saveConfig(f.ctx, { advisor: { thinkingLevel: "low" } }, "global", f.home), SyntaxError);
    assert.equal(await readFile(f.paths.global, "utf8"), "{invalid");
    assert.ok((await readdir(join(f.home, ".pi", "agent"))).includes("wt-mode.json"));
  } finally { await f.cleanup(); }
});

test("a malformed legacy file is preserved without changing existing settings", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.global, '{"welcome":false}'); await writeFile(f.legacy, "{invalid");
    await assert.rejects(ensureSettings(f.ctx, f.home), SyntaxError);
    assert.equal(await readFile(f.paths.global, "utf8"), '{"welcome":false}');
    assert.equal(await readFile(f.legacy, "utf8"), "{invalid");
  } finally { await f.cleanup(); }
});
