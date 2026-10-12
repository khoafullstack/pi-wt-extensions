import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PLAN_CHANGED_EVENT } from "../plan/state.ts";
import { loadSettings } from "./settings.ts";

const WIDGET_KEY = "wt-ui-editor-hint";
const LABEL = " wt ❯ ";
const HINT = "/ commands · @ files · ! bash · esc interrupt";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function isPlainBorder(line: string): boolean {
  const plain = line.replace(ANSI, "");
  return plain.length > 0 && /^─+$/.test(plain);
}

type Paint = (text: string) => string;

class WtEditor extends CustomEditor {
  private paint: Paint;
  private planBadge: () => string | undefined;

  constructor(tui: ConstructorParameters<typeof CustomEditor>[0], theme: ConstructorParameters<typeof CustomEditor>[1], kb: ConstructorParameters<typeof CustomEditor>[2], planBadge: () => string | undefined) {
    super(tui, theme, kb);
    this.planBadge = planBadge;
    const borderColor = (theme as { borderColor?: Paint }).borderColor;
    this.paint = typeof borderColor === "function" ? borderColor : (text) => text;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Only a plain rule is replaced. Borders that carry scroll indicators stay untouched.
    if (lines.length === 0 || !isPlainBorder(lines[0]!) || width < LABEL.length + 6) return lines;

    const badge = this.planBadge();
    const badgeWidth = badge ? visibleWidth(badge) + 1 : 0;
    const label = `\x1b[1m${this.paint(LABEL)}\x1b[22m${badge ? `${badge}${this.paint(" ")}` : ""}`;
    const rule = this.paint("─".repeat(Math.max(0, width - 1 - visibleWidth(LABEL) - badgeWidth)));
    lines[0] = truncateToWidth(`${this.paint("─")}${label}${rule}`, width, "");
    return lines;
  }
}

export function registerPromptEditor(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;
  let planActive = false;
  let requestRender: (() => void) | undefined;
  let stopPlanEvents: (() => void) | undefined;

  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    stopPlanEvents?.();
    stopPlanEvents = pi.events.on(PLAN_CHANGED_EVENT, (data) => {
      planActive = (data as { active?: unknown } | undefined)?.active === true;
      requestRender?.();
    });
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      requestRender = () => tui.requestRender();
      // Colors are resolved per render so a theme change is picked up.
      const badge = () => (planActive ? `\x1b[1m${ctx.ui.theme.fg("warning", "PLAN")}\x1b[22m` : undefined);
      return new WtEditor(tui, theme, kb, badge);
    });
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        invalidate() {},
        render: (width: number) => [truncateToWidth(` ${theme.fg("dim", HINT)}`, width)],
      }),
      { placement: "belowEditor" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = loadSettings(ctx.cwd).settings.editor;
    if (enabled) install(ctx);
  });

  pi.on("session_shutdown", () => {
    stopPlanEvents?.();
    stopPlanEvents = undefined;
    requestRender = undefined;
  });

  return { isEnabled: () => enabled };
}
