import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPackage from "../extensions/index.ts";

test("combined entry point registers UI and mode exactly once and preserves advisor rendering", () => {
  const commands = new Set<string>(), tools = new Set<string>();
  const renderers: any[] = [];
  let markdownTransformers = 0;
  const add = (set: Set<string>, name: string) => {
    assert.ok(!set.has(name), `Duplicate registration: ${name}`); set.add(name);
  };
  const pi = {
    on: () => () => {},
    registerCommand: (name: string) => add(commands, name),
    registerTool: (tool: { name: string }) => add(tools, tool.name),
    registerToolRenderer: (renderer: unknown) => renderers.push(renderer),
    registerMarkdownTransformer: () => { markdownTransformers++; },
    registerEntryRenderer: () => {}, registerMessageRenderer: () => {}, registerShortcut: () => {},
  } as unknown as ExtensionAPI;
  registerPackage(pi);
  assert.deepEqual([...tools].sort(), ["wt-advisor", "wt-ui-ask", "wt-ui-todo"]);
  assert.deepEqual([...commands].sort(), ["wt-advisor", "wt-advisor-thinking", "wt-btw", "wt-btw-clear", "wt-btw-config",
    "wt-mode", "wt-ui", "wt-ui-ask-demo"]);
  assert.equal(markdownTransformers, 1);
  assert.equal(renderers.length, 1);
  const advisorRenderer = {};
  assert.equal(renderers[0]("wt-advisor", () => advisorRenderer), advisorRenderer);
  assert.equal(renderers[0]("read", () => undefined).renderShell, "self");
});

test("root and package manifests declare one entry point and all bundled themes exist", async () => {
  const rootUrl = new URL("../../../package.json", import.meta.url);
  const packageUrl = new URL("../package.json", import.meta.url);
  const root = JSON.parse(await readFile(rootUrl, "utf8"));
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(pkg.name, "pi-wt");
  assert.deepEqual(root.pi.extensions, ["./packages/pi-wt/extensions/index.ts"]);
  assert.deepEqual(pkg.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(root.pi.themes, ["./packages/pi-wt/themes"]);
  assert.deepEqual(pkg.pi.themes, ["./themes"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.equal(pkg.dependencies, undefined);
  for (const range of Object.values(pkg.peerDependencies)) assert.equal(range, "*");
  await access(new URL(root.pi.extensions[0], rootUrl));
  await access(new URL(pkg.pi.extensions[0], packageUrl));
  for (const name of ["wt-catppuccin-mocha", "wt-tokyo-night", "wt-gruvbox-dark", "wt-nord"]) {
    const theme = JSON.parse(await readFile(new URL(`../themes/${name}.json`, import.meta.url), "utf8"));
    assert.equal(theme.name, name);
  }
});
