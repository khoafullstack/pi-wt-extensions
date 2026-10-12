import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSettings } from "./settings.ts";

const TOOL_NAME = "wt-ui-ask";
const OTHER = "__other__";

const MAX_EXAMPLE = 400;
/** Width at which the example note moves from under the list to a right-hand column. */
const SIDE_BY_SIDE_MIN = 84;
/** Share of the width given to the example column. */
const NOTE_SHARE = 0.55;

interface Option {
  label: string;
  description?: string;
  example?: string;
}

const MAX_EXAMPLE_LINES = 12;

/** Keeps line breaks and indentation (file trees, snippets) while capping characters and lines. */
function clip(text: string, max: number): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let out = lines.slice(0, MAX_EXAMPLE_LINES).join("\n");
  const cutLines = lines.length > MAX_EXAMPLE_LINES;
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  else if (cutLines) out += "\n…";
  return out;
}

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: Option[];
  multiple: boolean;
  allowOther: boolean;
}

interface Answer {
  id: string;
  labels: string[];
  /** 1-based positions of the chosen preset options. */
  indexes: number[];
  custom?: string;
}

interface AskResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Unique identifier for this question" }),
      label: Type.Optional(Type.String({ description: "Short tab label, e.g. 'Scope' (defaults to Q1, Q2...)" })),
      prompt: Type.String({ description: "The full question text" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Display label. Put the recommended option first and say so in the label" }),
          description: Type.Optional(Type.String({ description: "One line shown under the label" })),
          example: Type.Optional(
            Type.String({
              description: `Short concrete example of what choosing this option means (e.g. a snippet, command, or sample output), shown in a side note while the option is highlighted. Line breaks and indentation are kept, so a file tree or snippet can be written with \\n. Max ${MAX_EXAMPLE} characters and ${MAX_EXAMPLE_LINES} lines, longer text is cut.`,
            }),
          ),
        }),
        { description: "Choices to offer" },
      ),
      multiple: Type.Optional(Type.Boolean({ description: "Allow selecting several options (default: false)" })),
      allowOther: Type.Optional(Type.Boolean({ description: "Let the user type their own answer (default: true)" })),
    }),
    { description: "One to four questions to ask the user" },
  ),
});

function normalize(raw: { id: string; label?: string; prompt: string; options: Option[]; multiple?: boolean; allowOther?: boolean }[]): Question[] {
  return raw.map((q, i) => ({
    id: q.id,
    label: q.label || `Q${i + 1}`,
    prompt: q.prompt,
    options: q.options.map((o) => ({ ...o, example: o.example ? clip(o.example, MAX_EXAMPLE) : undefined })),
    multiple: q.multiple === true,
    allowOther: q.allowOther !== false,
  }));
}

function describeAnswer(a: Answer): string {
  const parts = [...a.labels];
  if (a.custom) parts.push(`(wrote) ${a.custom}`);
  return parts.join(", ");
}

/** Full-screen questionnaire. Resolves with `cancelled: true` on Esc or abort. */
function runQuestionnaire(ctx: ExtensionContext, questions: Question[], signal?: AbortSignal): Promise<AskResult> {
  return ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
    const isMulti = questions.length > 1;
    const totalTabs = questions.length + 1;
    const answers = new Map<string, Answer>();
    const picked = new Map<string, Set<number>>();
    let tab = 0;
    let cursor = 0;
    let inputMode = false;
    let cache: string[] | undefined;
    let finished = false;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    const finish = (cancelled: boolean) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      done({ questions, answers: [...answers.values()], cancelled });
    };
    const onAbort = () => finish(true);
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener("abort", onAbort, { once: true });

    const refresh = () => {
      cache = undefined;
      tui.requestRender();
    };

    const question = (): Question | undefined => questions[tab];
    const rows = (q: Question): (Option & { other?: boolean })[] =>
      q.allowOther ? [...q.options, { label: "Type your own answer…", other: true }] : q.options;
    const allAnswered = () => questions.every((q) => answers.has(q.id));

    function advance() {
      if (!isMulti) return finish(false);
      tab = tab < questions.length - 1 ? tab + 1 : questions.length;
      cursor = 0;
      refresh();
    }

    function saveChoice(q: Question, indexes: number[], custom?: string) {
      answers.set(q.id, { id: q.id, indexes, labels: indexes.map((i) => q.options[i - 1]!.label), custom });
    }

    editor.onSubmit = (value) => {
      const q = question();
      if (!q) return;
      const text = value.trim();
      inputMode = false;
      editor.setText("");
      if (!text) return refresh();
      const chosen = q.multiple ? [...(picked.get(q.id) ?? [])].sort((a, b) => a - b) : [];
      saveChoice(q, chosen, text);
      advance();
    };

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          editor.setText("");
        } else {
          editor.handleInput(data);
        }
        return refresh();
      }

      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          tab = (tab + 1) % totalTabs;
          cursor = 0;
          return refresh();
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          tab = (tab - 1 + totalTabs) % totalTabs;
          cursor = 0;
          return refresh();
        }
      }

      if (tab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
        else if (matchesKey(data, Key.escape)) finish(true);
        return;
      }

      const q = question()!;
      const list = rows(q);

      if (matchesKey(data, Key.up)) {
        cursor = Math.max(0, cursor - 1);
        return refresh();
      }
      if (matchesKey(data, Key.down)) {
        cursor = Math.min(list.length - 1, cursor + 1);
        return refresh();
      }
      if (matchesKey(data, Key.escape)) return finish(true);

      const row = list[cursor]!;

      if (q.multiple && data === " " && !row.other) {
        const set = picked.get(q.id) ?? new Set<number>();
        const idx = cursor + 1;
        if (set.has(idx)) set.delete(idx);
        else set.add(idx);
        picked.set(q.id, set);
        return refresh();
      }

      if (matchesKey(data, Key.enter)) {
        if (row.other) {
          inputMode = true;
          editor.setText("");
          return refresh();
        }
        if (q.multiple) {
          const set = picked.get(q.id) ?? new Set<number>();
          if (set.size === 0) set.add(cursor + 1);
          picked.set(q.id, set);
          saveChoice(q, [...set].sort((a, b) => a - b), answers.get(q.id)?.custom);
        } else {
          saveChoice(q, [cursor + 1]);
        }
        advance();
      }
    }

    function render(width: number): string[] {
      if (cache) return cache;
      const w = Math.max(1, width);
      const lines: string[] = [];
      const wrapTo = (out: string[], width: number, prefix: string, text: string) => {
        const pw = visibleWidth(prefix);
        if (pw >= width) return void out.push(...wrapTextWithAnsi(prefix + text, width));
        const parts = wrapTextWithAnsi(text, width - pw);
        parts.forEach((p, i) => out.push(`${i === 0 ? prefix : " ".repeat(pw)}${p}`));
      };
      const wrap = (prefix: string, text: string) => wrapTo(lines, w, prefix, text);
      // Example text keeps its own line breaks and indentation; only over-long lines wrap.
      const noteTo = (out: string[], width: number, indent: string, text: string) => {
        for (const raw of text.split("\n")) {
          const lead = /^ */.exec(raw)![0];
          const body = raw.slice(lead.length);
          if (!body) out.push("");
          else wrapTo(out, width, indent + lead, theme.fg("muted", body));
        }
      };

      lines.push(theme.fg("accent", "─".repeat(w)));

      if (isMulti) {
        const tabs = ["← "];
        questions.forEach((q, i) => {
          const text = ` ${answers.has(q.id) ? "■" : "□"} ${q.label} `;
          tabs.push(
            (i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answers.has(q.id) ? "success" : "muted", text)) + " ",
          );
        });
        const submit = " ✓ Submit ";
        tabs.push((tab === questions.length ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg(allAnswered() ? "success" : "dim", submit)) + " →");
        wrap(" ", tabs.join(""));
        lines.push("");
      }

      const q = question();
      if (tab === questions.length) {
        wrap(" ", theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        for (const item of questions) {
          const a = answers.get(item.id);
          if (a) wrap(" ", `${theme.fg("muted", `${item.label}: `)}${theme.fg("text", describeAnswer(a))}`);
        }
        lines.push("");
        if (allAnswered()) wrap(" ", theme.fg("success", "Press Enter to submit"));
        else wrap(" ", theme.fg("warning", `Unanswered: ${questions.filter((x) => !answers.has(x.id)).map((x) => x.label).join(", ")}`));
      } else if (q) {
        wrap(" ", theme.fg("text", theme.bold(q.prompt)));
        lines.push("");
        const set = picked.get(q.id) ?? new Set<number>();
        const list = rows(q);
        const sideBySide = w >= SIDE_BY_SIDE_MIN && list.some((r) => r.example);
        const noteW = sideBySide ? Math.floor(w * NOTE_SHARE) : 0;
        const listW = sideBySide ? w - noteW - 3 : w;

        const left: string[] = [];
        list.forEach((row, i) => {
          const selected = i === cursor;
          const mark = row.other ? "✎" : q.multiple ? (set.has(i + 1) ? "[x]" : "[ ]") : `${i + 1}.`;
          const color = selected ? "accent" : "text";
          wrapTo(left, listW, selected ? theme.fg("accent", "> ") : "  ", theme.fg(color, `${mark} ${row.label}`));
          if (row.description) wrapTo(left, listW, "      ", theme.fg("muted", row.description));
        });

        const current = list[cursor];
        const example = current && !current.other ? current.example : undefined;

        if (sideBySide) {
          const note: string[] = [theme.fg("dim", "Example")];
          if (example) noteTo(note, noteW, "", example);
          else note.push(theme.fg("dim", current?.other ? "Write your own answer" : "No example for this option"));

          const height = Math.max(left.length, note.length);
          for (let i = 0; i < height; i++) {
            const l = left[i] ?? "";
            const pad = " ".repeat(Math.max(0, listW - visibleWidth(l)));
            lines.push(`${l}${pad}${theme.fg("borderMuted", " │ ")}${note[i] ?? ""}`);
          }
        } else {
          lines.push(...left);
          if (example) {
            lines.push("");
            wrap("  ", theme.fg("dim", "Example:"));
            noteTo(lines, w, "    ", example);
          }
        }
        if (inputMode) {
          lines.push("");
          wrap(" ", theme.fg("muted", "Your answer:"));
          for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
        }
      }

      lines.push("");
      if (inputMode) wrap(" ", theme.fg("dim", "Enter submit · Esc back"));
      else {
        const q2 = question();
        const keys = [isMulti ? "Tab/←→ navigate" : "", "↑↓ move", q2?.multiple ? "Space toggle" : "", "Enter confirm", "Esc cancel"].filter(Boolean);
        wrap(" ", theme.fg("dim", keys.join(" · ")));
      }
      lines.push(theme.fg("accent", "─".repeat(w)));

      cache = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cache = undefined;
      },
      handleInput,
    };
  });
}

/** Dialog-only fallback for RPC mode, where custom components are unavailable. */
async function runDialogs(ctx: ExtensionContext, questions: Question[]): Promise<AskResult> {
  const answers: Answer[] = [];
  for (const q of questions) {
    const choices = q.options.map((o) => o.label);
    if (q.allowOther) choices.push("Type your own answer…");
    const picked = await ctx.ui.select(q.prompt, choices);
    if (picked === undefined) return { questions, answers, cancelled: true };
    const index = q.options.findIndex((o) => o.label === picked);
    if (index >= 0) {
      answers.push({ id: q.id, labels: [picked], indexes: [index + 1] });
      continue;
    }
    const text = await ctx.ui.input(q.prompt, "");
    if (text === undefined || !text.trim()) return { questions, answers, cancelled: true };
    answers.push({ id: q.id, labels: [], indexes: [], custom: text.trim() });
  }
  return { questions, answers, cancelled: false };
}

function formatForModel(result: AskResult): string {
  if (result.cancelled) return "User cancelled the questions without answering.";
  return result.answers
    .map((a) => {
      const label = result.questions.find((q) => q.id === a.id)?.label ?? a.id;
      const chosen = a.indexes.map((n, i) => `${n}. ${a.labels[i]}`);
      const parts: string[] = [];
      if (chosen.length > 0) parts.push(`user selected: ${chosen.join("; ")}`);
      if (a.custom) parts.push(`user wrote: ${a.custom}`);
      return `${label}: ${parts.join(" and ")}`;
    })
    .join("\n");
}

const DEMO: Question[] = normalize([
  {
    id: "scope",
    label: "Scope",
    prompt: "Which part should I work on first?",
    options: [
      {
        label: "UI polish (recommended)",
        description: "Fastest visible improvement",
        example: "Compact tool cards, colored diffs, a status bar. Result: `✓ edit src/a.ts (+3 −1)` instead of a boxed output.",
      },
      { label: "Performance", description: "Profile and optimize hot paths", example: "src/\n  render/\n    cache.ts   (new)\n    lines.ts\n  index.ts\n\nCache rendered lines by width; skip re-render when nothing changed." },
      { label: "Tests" },
    ],
  },
  {
    id: "extras",
    label: "Extras",
    prompt: "Which extras do you want? (pick several)",
    multiple: true,
    options: [{ label: "Docs" }, { label: "Changelog" }, { label: "Examples" }],
  },
]);

export function registerAskUser(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;

  pi.on("session_start", (_event, ctx) => {
    enabled = loadSettings(ctx.cwd).settings.ask;
    if (!enabled) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL_NAME));
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask",
    description:
      "Ask the user one to four multiple-choice questions when you need a decision, a preference, or missing requirements before continuing. Offer concrete options (put your recommendation first), set multiple:true when several choices can apply. Give each option a short `example` (a snippet, command, or sample result, under 400 characters) when the label alone may be unclear. The user can always type their own answer. Do not use it for questions you can answer by reading the code.",
    parameters: AskParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("No interactive UI available, ask the question in plain text instead.");
      if (params.questions.length === 0) throw new Error("No questions provided");
      for (const q of params.questions) {
        if (q.options.length === 0 && q.allowOther === false) throw new Error(`Question "${q.id}" has no options`);
      }

      const questions = normalize(params.questions);
      const result = ctx.mode === "tui" ? await runQuestionnaire(ctx, questions, signal) : await runDialogs(ctx, questions);
      return { content: [{ type: "text", text: formatForModel(result) }], details: result };
    },

    renderCall(args, theme) {
      const qs = (args.questions ?? []) as { id: string; label?: string }[];
      const labels = qs.map((q) => q.label || q.id).join(", ");
      const text = theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
      return new Text(labels ? `${text} ${theme.fg("dim", `(${labels})`)}` : text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(theme.fg("error", first?.type === "text" ? first.text : "failed"), 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      const lines = details.answers.map((a) => `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("text", describeAnswer(a))}`);
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("wt-ui-ask-demo", {
    description: "Preview the ask dialog without a model",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return ctx.ui.notify("demo needs interactive mode", "error");
      const result = await runQuestionnaire(ctx, DEMO);
      ctx.ui.notify(formatForModel(result), result.cancelled ? "warning" : "info");
    },
  });

  return { isEnabled: () => enabled };
}

