import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadSettings } from "./settings.ts";

const BAR_CELLS = 10;

interface SessionStats {
  cost: number;
  dirty: boolean;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 10 ? 2 : 1)}`;
}

export function registerStatusBar(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;
  let stats: SessionStats = { cost: 0, dirty: false };
  let requestRender: (() => void) | undefined;

  function collectCost(ctx: ExtensionContext): number {
    let cost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        cost += (entry.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
      }
    }
    return cost;
  }

  async function collectDirty(): Promise<boolean> {
    try {
      const res = await pi.exec("git", ["status", "--porcelain"]);
      return res.code === 0 && res.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async function refreshStats(ctx: ExtensionContext): Promise<void> {
    const cost = collectCost(ctx);
    const dirty = await collectDirty();
    stats = { cost, dirty };
    requestRender?.();
  }

  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose() {
          unsubBranch();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const sep = theme.fg("dim", " │ ");
          const segments: string[] = [];

          const model = ctx.model?.id ?? "no-model";
          segments.push(
            `${theme.fg("accent", "◆")} ${theme.fg("accent", model)}${theme.fg("dim", ` · think:${pi.getThinkingLevel()}`)}`,
          );

          let usage: ReturnType<ExtensionContext["getContextUsage"]>;
          try {
            usage = ctx.getContextUsage();
          } catch {
            usage = undefined;
          }
          if (usage?.percent != null) {
            const pct = Math.max(0, Math.min(100, usage.percent));
            const filled = Math.round((pct / 100) * BAR_CELLS);
            const color = pct < 60 ? "success" : pct < 85 ? "warning" : "error";
            const bar = theme.fg(color, "▓".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_CELLS - filled));
            segments.push(`${theme.fg("dim", "ctx")} ${bar} ${theme.fg(color, `${Math.round(pct)}%`)}`);
          } else {
            segments.push(`${theme.fg("dim", "ctx")} ${theme.fg("dim", "?")}`);
          }

          segments.push(theme.fg("dim", formatCost(stats.cost)));

          const branch = footerData.getGitBranch();
          if (branch) {
            segments.push(theme.fg("dim", ` ${branch}${stats.dirty ? "*" : ""}`));
          }

          segments.push(theme.fg("dim", `${pi.getActiveTools().length} tools`));

          // Statuses from other extensions (setStatus) replace the built-in footer's own status row,
          // so they must be drawn here or they disappear while this footer is active.
          const statuses = [...footerData.getExtensionStatuses()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/[\r\n]+/g, " ").trim())
            .filter(Boolean)
            .join(" ");
          const statusWidth = statuses ? visibleWidth(statuses) + 1 : 0;
          const available = Math.max(0, width - statusWidth);

          // Drop the right-most segments first on narrow terminals, always keeping model and context.
          while (segments.length > 2 && visibleWidth(` ${segments.join(sep)}`) > available) {
            segments.pop();
          }

          const left = truncateToWidth(` ${segments.join(sep)}`, available);
          if (!statuses) return [left];

          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(statuses) - 1));
          return [truncateToWidth(`${left}${pad}${statuses} `, width)];
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    enabled = loadSettings(ctx.cwd).settings.statusBar;
    if (enabled) install(ctx);
    await refreshStats(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshStats(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await refreshStats(ctx);
  });

  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());

  pi.on("session_shutdown", () => {
    requestRender = undefined;
  });

  return { isEnabled: () => enabled };
}
