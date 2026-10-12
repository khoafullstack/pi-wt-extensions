import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatClock } from "./session-info.ts";
import { loadSettings } from "./settings.ts";

const MAX_WIDTH = 100;
const BRAND = "Work Together by Eztek";

interface SessionMeta {
  cwd: string;
  tag: string;
  started?: string;
}

function shortenHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) || path.startsWith(`${home}\\`) ? `~${path.slice(home.length)}` : path;
}

/** Startup header: brand banner and a session line. It replaces Pi's default logo and key hints. */
export function registerWelcome(pi: ExtensionAPI): { isEnabled(): boolean } {
  let enabled = true;
  let meta: SessionMeta | undefined;
  let requestRender: (() => void) | undefined;

  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      requestRender = () => tui.requestRender();

      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const w = Math.min(width, MAX_WIDTH);
          if (w < 30 || !meta) return [];

          const dim = (t: string) => theme.fg("dim", t);
          const accent = (t: string) => theme.fg("accent", t);

          const inner = visibleWidth(BRAND) + 2;
          const banner = [
            accent(`╭${"─".repeat(inner)}╮`),
            `${accent("│")} ${theme.bold(accent(BRAND))} ${accent("│")}  ${theme.bold(theme.fg("text", "Pi coding agent"))} ${dim(`v${VERSION}`)}`,
            accent(`╰${"─".repeat(inner)}╯`),
          ];

          const name = pi.getSessionName();
          const info = [theme.fg("muted", shortenHome(meta.cwd))];
          if (name) info.push(theme.fg("muted", `"${name}"`));
          info.push(dim(`session ${meta.tag}`));
          if (meta.started) info.push(dim(`started ${meta.started}`));

          const lines = [""];
          for (const line of banner) lines.push(truncateToWidth(` ${line}`, w));
          lines.push(truncateToWidth(` ${info.join(dim(" · "))}`, w));
          lines.push("");
          return lines;
        },
      };
    });
  }

  function start(ctx: ExtensionContext): void {
    try {
      const header = ctx.sessionManager.getHeader();
      meta = {
        cwd: ctx.cwd,
        tag: `#${ctx.sessionManager.getSessionId().slice(-4)}`,
        started: header ? formatClock(header.timestamp) : undefined,
      };
    } catch {
      meta = { cwd: ctx.cwd, tag: "#----" };
    }
    install(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = loadSettings(ctx.cwd).settings.welcome;
    if (enabled) start(ctx);
  });
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("session_shutdown", () => {
    requestRender = undefined;
  });

  return { isEnabled: () => enabled };
}
