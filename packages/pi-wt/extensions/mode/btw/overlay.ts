import { getMarkdownTheme, getSelectListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, Text, matchesKey, truncateToWidth, visibleWidth,
  type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { BtwSession } from "./session.ts";
import { threadText } from "./state.ts";

// Must stay equal to the overlay's maxHeight, otherwise Pi clips the bottom border.
const OVERLAY_HEIGHT_RATIO = 0.9;

export class BtwOverlayComponent extends Container implements Focusable {
  private editor: Editor;
  private scroll = 0;
  private page = 10;
  private stopListening: () => void;
  private tui: TUI;
  private theme: Theme;
  private thread: BtwSession;
  private submit: (question: string) => void;
  private close: () => void;
  private focusKey: string;
  private toggleFocus: () => void;
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }

  constructor(tui: TUI, theme: Theme, thread: BtwSession,
    submit: (question: string) => void, close: () => void,
    focusKey: string, toggleFocus: () => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.thread = thread;
    this.submit = submit;
    this.close = close;
    this.focusKey = focusKey;
    this.toggleFocus = toggleFocus;
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg("accent", text), selectList: getSelectListTheme(),
    });
    this.addChild(this.editor);
    this.editor.onSubmit = text => {
      if (!text.trim()) return;
      this.editor.addToHistory(text);
      this.editor.setText("");
      this.scroll = 0;
      this.submit(text);
    };
    this.stopListening = thread.subscribe(() => tui.requestRender());
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.thread.busy) void this.thread.abort().catch(error => { this.thread.error = String(error); this.tui.requestRender(); });
      else this.close();
    } else if (matchesKey(data, this.focusKey as Parameters<typeof matchesKey>[1])) this.toggleFocus();
    else if (matchesKey(data, "pageUp")) this.scroll += Math.max(1, this.page - 2);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - Math.max(1, this.page - 2));
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_RATIO));
    const editorLines = this.editor.render(inner).slice(-Math.min(6, height - 4));
    const history = threadText(this.thread.state);
    const question = this.thread.currentQuestion ? `\n\nYou: ${this.thread.currentQuestion}` : "";
    const streaming = this.thread.liveText ? `\n\nBTW (streaming):\n${this.thread.liveText}` : "";
    const thinking = this.thread.thinking ? `\n\nThinking:\n${this.thread.thinking}` : "";
    const text = history + question + thinking + streaming || "Ask a side question. This thread stays outside the main context.";
    const lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(inner);
    const available = Math.max(1, height - editorLines.length - 4);
    this.page = available;
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - available));
    const end = Math.max(0, lines.length - this.scroll);
    const body = lines.slice(Math.max(0, end - available), end);
    const above = Math.max(0, end - available);
    // Keep the overlay a constant height so it does not jump while a reply streams in.
    while (body.length < available) body.push("");
    const status = this.thread.error || this.thread.activity || (this.thread.busy ? `${this.thread.pending} question(s) pending…` : "Ready");
    const header = ` BTW · ${this.thread.state.mode} · ${this.focused ? "focused" : "main editor"} `;
    const border = (text: string) => this.theme.fg("border", text);
    const frame = (line: string) => {
      const clipped = truncateToWidth(line, inner, "");
      return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
    };
    const title = truncateToWidth(this.theme.fg("accent", header), Math.max(0, inner - 2), "");
    const top = border("╭─") + title + border("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮");
    const position = above > 0 || this.scroll > 0 ? ` ↑${above} ↓${this.scroll} ` : "";
    const marker = truncateToWidth(this.theme.fg("dim", position), Math.max(0, inner - 2), "");
    const bottom = border("╰" + "─".repeat(Math.max(0, inner - 1 - visibleWidth(marker)))) + marker + border("─╯");
    return [
      truncateToWidth(top, width, ""),
      ...body.map(frame),
      ...new Text(this.theme.fg(this.thread.error ? "error" : "muted", status), 0, 0).render(inner).slice(0, 1).map(frame),
      ...editorLines.map(frame),
      frame(this.theme.fg("dim", `Enter: send · Esc: ${this.thread.busy ? "abort" : "close"} · ${this.focusKey}: focus · PgUp/PgDn: scroll`)),
      truncateToWidth(bottom, width, ""),
    ];
  }
  dispose(): void { this.stopListening(); }
}

export class BtwOverlay {
  private handle?: OverlayHandle;
  private done?: () => void;
  private opening = false;
  private generation = 0;
  private thread: BtwSession;
  focusKey = "ctrl+alt+b";
  constructor(thread: BtwSession) { this.thread = thread; }
  dismiss(): void {
    this.generation++;
    const done = this.done;
    this.done = undefined;
    this.handle = undefined;
    this.opening = false;
    done?.();
  }
  toggle(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (!this.handle) { this.show(ctx); return; }
    if (this.handle.isFocused()) this.handle.unfocus();
    else this.handle.focus();
  }
  show(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (this.handle) { this.handle.focus(); return; }
    if (this.opening) return;
    this.opening = true;
    const generation = this.generation;
    let finish: (() => void) | undefined;
    void ctx.ui.custom<void>((tui, theme, _keys, done) => {
      const close = () => { if (generation === this.generation) this.dismiss(); };
      finish = () => done();
      if (generation !== this.generation) return new Text("", 0, 0);
      this.done = finish;
      return new BtwOverlayComponent(tui, theme, this.thread, question => {
        const threadGeneration = this.thread.generation;
        void this.thread.prompt(question, ctx).catch(error => {
          if (threadGeneration === this.thread.generation) ctx.ui.notify(String(error), "error");
        });
      }, close, this.focusKey, () => this.toggle(ctx));
    }, {
      overlay: true, overlayOptions: { width: "85%", maxHeight: `${Math.round(OVERLAY_HEIGHT_RATIO * 100)}%`, anchor: "center" },
      onHandle: handle => {
        if (generation !== this.generation) { handle.hide(); finish?.(); return; }
        this.handle = handle;
      },
    }).catch(error => {
      if (generation === this.generation) ctx.ui.notify(`wt-btw overlay: ${String(error)}`, "error");
    }).finally(() => {
      if (generation === this.generation) { this.handle = undefined; this.done = undefined; this.opening = false; }
    });
  }
}
