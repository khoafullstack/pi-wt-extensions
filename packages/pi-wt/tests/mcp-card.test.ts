import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerToolCards } from "../extensions/ui/tool-cards.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

let resolver: any;
registerToolCards({ on: () => {}, registerToolRenderer: (r: unknown) => { resolver = r; } } as any);

function card(toolName: string, args: unknown) {
  const renderers = resolver(toolName, () => undefined);
  const state = {};
  const ctx = (extra: object = {}) => ({
    state, args, toolCallId: "1", isError: false, durationMs: 20, invalidate: () => {}, outputPad: 1, ...extra,
  });
  return {
    renderers,
    header: (width = 90) => renderers.renderCall(args, theme, ctx()).render(width).join("\n"),
    body: async (result: object, extra: { expanded?: boolean; isError?: boolean } = {}, width = 90) => {
      const component = renderers.renderResult(result, { isPartial: false, expanded: extra.expanded ?? false }, theme,
        ctx({ isError: extra.isError ?? false }));
      await Promise.resolve();
      return component.render(width).join("\n");
    },
  };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

test("MCP server tools and resource tools get flat cards; unrelated names fall through", () => {
  for (const name of ["mcp__context7__query_docs", "mcp__any__thing", "list_mcp_resources", "list_mcp_resource_templates",
    "read_mcp_resource"]) {
    assert.equal(resolver(name, () => undefined).renderShell, "self", name);
  }
  const other = {};
  assert.equal(resolver("mcp_not_prefixed", () => other), other);
});

test("context7 tools show the library name or id and query in the header", async () => {
  const resolve = card("mcp__context7__resolve_library_id", { libraryName: "next.js", query: "middleware" });
  assert.match(resolve.header(), /mcp\s+context7\/resolve_library_id next\.js/);
  const query = card("mcp__context7__query_docs", { libraryId: "/vercel/next.js", query: "how to use middleware" });
  assert.match(query.header(), /context7\/query_docs \/vercel\/next\.js · how to use middleware/);
  const body = await query.body(text("line 1\nline 2\nline 3\nline 4\nline 5"));
  assert.match(body, /line 3/);
  assert.doesNotMatch(body, /line 4/);
  assert.match(body, /… 2 more lines/);
  assert.match(query.header(), /5 lines · 20ms/);
  assert.match(await query.body(text("line 1\nline 2\nline 3\nline 4\nline 5"), { expanded: true }), /line 5/);
});

test("generic MCP tools summarize arguments and failures", async () => {
  const none = card("mcp__docs__ping", {});
  assert.match(none.header(), /docs\/ping\s/);
  const multi = card("mcp__docs__search", { q: "a", limit: 3 });
  assert.match(multi.header(), /docs\/search q=a limit=3/);
  const failing = card("mcp__docs__search", { q: "a" });
  assert.match(await failing.body(text("server exploded"), { isError: true }), /server exploded/);
  assert.match(failing.header(), /failed/);
});

test("resource listings report counts, pages and per-server errors", async () => {
  const listing = card("list_mcp_resources", {});
  assert.match(listing.header(), /res\s+all servers/);
  const payload = {
    server: undefined,
    resources: [{ server: "a", uri: "file:///x", name: "x" }, { server: "b", uri: "file:///y", name: "y" }],
    nextCursor: "c1",
    errors: [{ server: "c", error: "timeout" }],
  };
  const collapsed = await listing.body({ ...text(JSON.stringify(payload)) });
  assert.match(collapsed, /c: timeout/);
  assert.doesNotMatch(collapsed, /file:\/\/\/x/);
  assert.match(listing.header(), /2 resources · more pages · 1 error/);
  assert.match(await listing.body(text(JSON.stringify(payload)), { expanded: true }), /a {2}x {2}file:\/\/\/x/);

  const templates = card("list_mcp_resource_templates", { server: "docs", cursor: "n" });
  assert.match(templates.header(), /tmpl\s+docs \(next page\)/);
  const withStructured = { content: [], structuredContent: { resourceTemplates: [{ server: "docs", uriTemplate: "doc://{id}", name: "doc" }] } };
  await templates.body(withStructured);
  assert.match(templates.header(), /1 template/);
  assert.match(await templates.body(withStructured, { expanded: true }), /docs {2}doc {2}doc:\/\/\{id\}/);
});

test("reading a resource shows server, uri, output preview and stays within the width", async () => {
  const read = card("read_mcp_resource", { server: "docs", uri: "doc://readme" });
  assert.match(read.header(), /res\s+docs doc:\/\/readme/);
  const long = { ...text("x".repeat(900)), details: { fullOutputPath: "C:/tmp/full.txt" } };
  for (const width of [25, 60, 100]) {
    const out = await read.body(long, {}, width);
    assert.ok(out.split("\n").every((line: string) => visibleWidth(line) <= width), `width ${width}`);
  }
  assert.match(await read.body(long), /Full output: C:\/tmp\/full\.txt/);
  assert.match(read.header(), /\(truncated\)/);
});
