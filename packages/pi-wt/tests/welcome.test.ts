import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

async function header() {
  // Settings are read from the home directory, so point it at an empty one.
  const home = await mkdtemp(join(tmpdir(), "wt-welcome-"));
  process.env.HOME = home; process.env.USERPROFILE = home;
  const { registerWelcome } = await import("../extensions/ui/welcome.ts");
  const handlers = new Map<string, (...args: any[]) => void>();
  registerWelcome({ on: (event: string, handler: any) => handlers.set(event, handler), getSessionName: () => undefined } as any);
  let factory: any;
  const ctx = {
    mode: "tui", cwd: join(home, "project"),
    ui: { setHeader: (f: unknown) => { factory = f; } },
    sessionManager: { getHeader: () => undefined, getSessionId: () => "abcd1234" },
  };
  handlers.get("session_start")!({}, ctx);
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => text };
  return factory({ requestRender: () => {} }, theme);
}

test("welcome header draws a blue block-letter logo with two white lines", async () => {
  const component = await header();
  const lines: string[] = component.render(100);
  const text = lines.join("\n");
  assert.ok(lines.filter((line) => line.includes("<mdLink>")).length >= 6);
  assert.match(text, /<mdLink>.*███████╗/);
  assert.match(text, /<text>Work Together<\/>/);
  assert.match(text, new RegExp(`<text>Pi Coding Agent v${VERSION.replace(/\./g, "\\.")}</>`));
  assert.ok(lines.indexOf(lines.find((l) => l.includes("Work Together"))!) > lines.findIndex((l) => l.includes("╚═╝")));
  assert.ok(lines.every((line) => visibleWidth(line.replace(/<\/?\w+>/g, "")) <= 100));
  component.dispose();
});

test("welcome header falls back to the plain name on narrow terminals", async () => {
  const component = await header();
  const text = component.render(40).join("\n");
  assert.match(text, /<mdLink>EZtek<\/>/);
  assert.doesNotMatch(text, /█/);
  assert.match(text, /Work Together/);
  component.dispose();
});
