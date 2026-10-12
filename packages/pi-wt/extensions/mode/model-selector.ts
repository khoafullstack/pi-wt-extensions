import { getKeybindings, Input, SelectList, truncateToWidth, type Component, type Focusable, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";

/** Keep the selected model in view, including after a terminal resize. */
export class ModelSelector implements Component, Focusable {
  private list!: SelectList;
  private readonly search = new Input({ prompt: "Search: ", placeholder: "provider or model" });
  private filtered: string[] = [];
  private visible = 0;
  private selected = 0;
  private readonly tui: Pick<TUI, "terminal" | "requestRender">;
  private readonly title: string;
  private readonly options: string[];
  private readonly theme: SelectListTheme;
  private readonly done: (choice: string | undefined) => void;
  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  constructor(tui: Pick<TUI, "terminal" | "requestRender">, title: string, options: string[],
    theme: SelectListTheme, done: (choice: string | undefined) => void) {
    this.tui = tui; this.title = title; this.options = options; this.theme = theme; this.done = done;
    this.resize();
  }

  private resize(): void {
    const visible = Math.max(1, Math.min(12, Math.floor(this.tui.terminal.rows * 0.6) - 5));
    if (visible === this.visible) return;
    this.visible = visible;
    this.rebuild();
  }

  private rebuild(): void {
    const terms = this.search.getValue().trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.filtered = this.options.filter(value => terms.every(term => value.toLowerCase().includes(term)));
    this.list = new SelectList(this.filtered.map(value => ({ value, label: value })), this.visible,
      { ...this.theme, noMatch: () => this.theme.noMatch("  No matching models") });
    this.list.setSelectedIndex(this.selected);
    this.list.onSelectionChange = item => { this.selected = this.filtered.indexOf(item.value); };
    this.list.onSelect = item => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  render(width: number): string[] {
    this.resize();
    return [truncateToWidth(this.title, width), ...this.search.render(width), "", ...this.list.render(width),
      truncateToWidth("Type to search · ↑↓ select · Enter confirm · Esc cancel", width)];
  }
  handleInput(data: string): void {
    this.resize();
    const keys = getKeybindings();
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
      .some(key => keys.matches(data, key))) {
      this.list.handleInput(data);
    } else {
      const previous = this.search.getValue();
      this.search.handleInput(data);
      if (previous !== this.search.getValue()) { this.selected = 0; this.rebuild(); }
    }
    this.tui.requestRender();
  }
  invalidate(): void { this.list.invalidate(); this.search.invalidate(); }
}
