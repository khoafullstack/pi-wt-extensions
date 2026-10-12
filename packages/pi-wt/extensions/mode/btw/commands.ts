import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, Text } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig, type ThinkingLevel } from "../config.ts";
import { chooseModel, modelLabel } from "../models.ts";
import { filterBtwMessages } from "../transcript.ts";
import { BtwOverlay } from "./overlay.ts";
import { BtwSession } from "./session.ts";

export function parseBtwArgs(args: string): { question: string; save: boolean } {
  // Only a leading --save is an option. A later mention is part of the user's question.
  const match = /^\s*--save(?:\s+|$)/.exec(args);
  return { question: (match ? args.slice(match[0].length) : args).trim(), save: !!match };
}

export function selectFocusShortcut(primary: string, fallback: string, bindings: Record<string, unknown>): string | undefined {
  const occupied = new Set(Object.values(bindings).flatMap(value => Array.isArray(value) ? value : [value]));
  return [primary, fallback].find(key => !occupied.has(key));
}

export function registerBtw(pi: ExtensionAPI, options: { thread?: BtwSession; load?: typeof loadConfig; save?: typeof saveConfig } = {}): BtwSession {
  const thread = options.thread ?? new BtwSession(pi);
  const readConfig = options.load ?? loadConfig;
  const writeConfig = options.save ?? saveConfig;
  const overlay = new BtwOverlay(thread);
  let stopInput: (() => void) | undefined;
  let focusKey: string | undefined;
  const clearUI = () => { stopInput?.(); stopInput = undefined; focusKey = undefined; overlay.dismiss(); };
  const setup = async (ctx: ExtensionContext) => {
    clearUI();
    const restoring = thread.restore(ctx);
    const generation = thread.generation;
    await restoring;
    if (generation !== thread.generation) return;
    const config = await readConfig(ctx);
    if (generation !== thread.generation || ctx.mode !== "tui") return;
    focusKey = selectFocusShortcut(config.btw.focusShortcut, config.btw.fallbackShortcut, getKeybindings().getResolvedBindings());
    if (!focusKey) { ctx.ui.notify("wt-btw: both focus shortcuts conflict; use /wt-btw to focus", "warning"); return; }
    overlay.focusKey = focusKey;
    // A raw input listener permits trusted project remaps without mutating Pi's global shortcuts.
    stopInput = ctx.ui.onTerminalInput(data => {
      if (!focusKey || !matchesKey(data, focusKey as Parameters<typeof matchesKey>[1])) return;
      overlay.toggle(ctx);
      return { consume: true };
    });
  };
  pi.registerShortcut("ctrl+alt+b", {
    description: "wt-btw: toggle focus between side thread and main editor (configurable)",
    handler: ctx => { if (focusKey === "ctrl+alt+b") overlay.toggle(ctx); },
  });
  pi.on("session_start", async (_event, ctx) => { await setup(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await setup(ctx); });
  pi.on("session_shutdown", async () => { clearUI(); await thread.dispose(); });
  pi.on("context", event => ({ messages: filterBtwMessages(event.messages) }));
  // Pi's summarizers use preparation arrays directly rather than the context event.
  // Remove notes there too, so a later compaction/branch summary cannot leak side content.
  pi.on("session_before_compact", event => {
    event.preparation.messagesToSummarize = filterBtwMessages(event.preparation.messagesToSummarize);
    event.preparation.turnPrefixMessages = filterBtwMessages(event.preparation.turnPrefixMessages);
  });
  pi.on("session_before_tree", event => {
    const entries = event.preparation.entriesToSummarize;
    const filtered = entries.filter(entry => !((entry.type === "custom_message" || entry.type === "custom")
      && entry.customType.startsWith("wt-btw-")));
    entries.splice(0, entries.length, ...filtered);
  });
  pi.registerMessageRenderer("wt-btw-note", (message, _options, theme) =>
    new Text(theme.fg("accent", "BTW\n") + (typeof message.content === "string" ? message.content : ""), 0, 0));

  pi.registerCommand("wt-btw", {
    description: "Side conversation with main-session context; [--save] [question]",
    handler: async (args, ctx) => {
      const parsed = parseBtwArgs(args);
      if (parsed.save && !parsed.question) throw new Error("wt-btw: --save requires an inline question");
      if (ctx.mode !== "tui" && !parsed.question) throw new Error("wt-btw: this host requires an inline question");
      if (ctx.mode === "tui") overlay.show(ctx);
      if (parsed.question) await thread.prompt(parsed.question, ctx, parsed.save);
    },
  });
  pi.registerCommand("wt-btw-clear", {
    description: "Clear the side conversation; next question takes a fresh main-session context snapshot",
    handler: async () => { overlay.dismiss(); await thread.reset(); },
  });
  pi.registerCommand("wt-btw-config", {
    description: "Configure BTW: choose model, then thinking; [provider/model-id|clear] [level|clear]",
    handler: async (args, ctx) => {
      const generation = thread.generation;
      const [modelArg = "", thinkingArg = "", ...extra] = args.trim().split(/\s+/);
      if (extra.length) throw new Error("wt-btw-config: expected [provider/model-id|clear] [level|clear]");
      if (!ctx.hasUI && (!modelArg || !thinkingArg)) {
        throw new Error("wt-btw-config: provide model and thinking level inline without UI");
      }
      const levels = ["clear", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (thinkingArg && !levels.includes(thinkingArg)) throw new Error(`wt-btw-config: choose ${levels.join(", ")}`);
      const selected = await chooseModel(ctx, modelArg, "BTW model (clear = inherit main)", () => generation === thread.generation);
      if (selected === undefined || generation !== thread.generation) return;
      const level = thinkingArg || await ctx.ui.select("BTW thinking level (clear = inherit main)", levels);
      if (level === undefined || generation !== thread.generation) return;
      if (!levels.includes(level)) throw new Error(`wt-btw-config: choose ${levels.join(", ")}`);
      const thinkingLevel = level === "clear" ? null : level as ThinkingLevel;
      // Commit the entire flow once; cancelling either step leaves both settings untouched.
      await writeConfig(ctx, { btw: { model: selected, thinkingLevel } });
      if (generation !== thread.generation) return;
      pi.appendEntry("wt-btw-config-change", { model: selected, thinkingLevel });
      overlay.dismiss();
      const disposing = thread.dispose(); // Retain completed exchanges; rebuild with the new configuration.
      const afterDispose = thread.generation;
      await disposing;
      if (afterDispose !== thread.generation) return;
      const config = await readConfig(ctx);
      if (afterDispose !== thread.generation) return;
      ctx.ui.notify(`BTW: ${modelLabel(config.btw.model)} ? thinking: ${config.btw.thinkingLevel ?? "inherit main"}`, "info");
    },
  });
  return thread;
}
