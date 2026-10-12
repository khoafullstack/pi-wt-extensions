import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerToolCards } from "../extensions/ui/tool-cards.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const HEADER_OK = "Script completed\nWall time 1.2 seconds\nOutput:\n";
const HEADER_FAILED = "Script failed\nWall time 0.4 seconds\nOutput:\n";

function renderers() {
  let resolver: any;
  registerToolCards({ on: () => {}, registerToolRenderer: (r: unknown) => { resolver = r; } } as any);
  return resolver("codemode", () => undefined);
}

function session(code: string) {
  const card = renderers();
  const args = { code };
  const state = {};
  const ctx = (extra: object = {}) => ({
    state, args, toolCallId: "1", isError: false, durationMs: undefined, invalidate: () => {}, outputPad: 1, ...extra,
  });
  return {
    header: (width = 80) => card.renderCall(args, theme, ctx()).render(width).join("\n"),
    partial: (calls: unknown[], width = 80) =>
      card.renderResult({ content: [], details: { calls } }, { isPartial: true, expanded: false }, theme, ctx())
        .render(width).join("\n"),
    final: async (result: object, extra: { expanded?: boolean; isError?: boolean; durationMs?: number } = {}, width = 80) => {
      const component = card.renderResult(result, { isPartial: false, expanded: extra.expanded ?? false }, theme,
        ctx({ isError: extra.isError ?? false, durationMs: extra.durationMs }));
      await Promise.resolve();
      return component.render(width).join("\n");
    },
  };
}

const call = (name: string, status: string, extra: object = {}) => ({ id: "1/1", name, args: "{}", status, ...extra });

test("codemode uses the flat card shell and names the script by its first meaningful line", () => {
  const card = renderers();
  assert.equal(card.renderShell, "self");
  const s = session("// @options: {\"timeout\": 5}\n\nconst r = await tools.read({ path: 'a.ts' });");
  assert.match(s.header(), /code\s+const r = await tools\.read/);
  assert.doesNotMatch(s.header(), /@options/);
});

test("codemode shows nested calls and a live count while the script runs", () => {
  const s = session("await tools.read({})");
  const text = s.partial([call("read", "ok", { durationMs: 12 }), call("grep", "running")]);
  assert.match(text, /✓ read \{\} {2}12ms/);
  assert.match(text, /⟳ grep/);
  assert.match(s.header(), /running · 2 calls/);
});

test("codemode final card drops the script header, summarizes calls and keeps only recent calls collapsed", async () => {
  const s = session("await tools.read({})");
  const calls = Array.from({ length: 10 }, (_, i) => call(`tool${i}`, "ok", { durationMs: 5 }));
  const result = {
    content: [{ type: "text", text: HEADER_OK }, { type: "text", text: "line 1\nline 2" }],
    details: { calls, fullOutputPath: "C:/tmp/out.txt" },
  };
  const body = await s.final(result, { durationMs: 1200 });
  assert.doesNotMatch(body, /Script completed|Wall time/);
  assert.match(body, /… 2 earlier calls/);
  assert.doesNotMatch(body, /tool0\b/);
  assert.match(body, /tool9/);
  assert.match(body, /line 1\n.*line 2/);
  assert.match(body, /Full output: C:\/tmp\/out\.txt/);
  assert.match(s.header(), /10 calls · 1\.2s/);
  const expanded = await s.final(result, { expanded: true });
  assert.match(expanded, /tool0\b/);
  assert.match(expanded, /script/);
  assert.doesNotMatch(expanded, /Full output/);
});

test("failed codemode scripts keep nested calls, error text and partial output", async () => {
  initTheme("dark", false);
  const s = session("await tools.bash({})");
  const result = {
    content: [{ type: "text", text: HEADER_FAILED }, { type: "text", text: "partial\nScript error: boom" }],
    details: { calls: [call("bash", "error", { error: "exit code 1" })] },
  };
  const collapsed = await s.final(result, { isError: true });
  assert.match(collapsed, /✗ bash/);
  assert.match(collapsed, /Script error: boom/);
  assert.doesNotMatch(collapsed, /exit code 1/);
  assert.match(s.header(), /✗ code.*failed · 1 call/);
  assert.match(await s.final(result, { isError: true, expanded: true }), /exit code 1/);
});

test("codemode card tolerates missing details and stays within the width", async () => {
  const s = session("return 1");
  const plain = await s.final({ content: [{ type: "text", text: "no header here" }] });
  assert.match(plain, /no header here/);
  assert.match(s.header(), /no calls/);
  const long = session("return 1");
  const wide = { content: [{ type: "text", text: HEADER_OK }, { type: "text", text: "x".repeat(900) }],
    details: { calls: [call("read", "ok", { args: "y".repeat(500) })] } };
  for (const width of [25, 60, 100]) {
    const text = await long.final(wide, {}, width);
    assert.ok(text.split("\n").every((line: string) => visibleWidth(line) <= width), `width ${width}`);
  }
});
