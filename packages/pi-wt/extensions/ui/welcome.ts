import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatClock } from "./session-info.ts";
import { loadSettings } from "./settings.ts";

const MAX_WIDTH = 100;
const TAGLINE = "Work Together";

// Block letters spelling EZTEK; every row of a glyph has the same width so rows can be joined directly.
const GLYPHS: Record<string, string[]> = {
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  Z: ["███████╗", "╚══███╔╝", "  ███╔╝ ", " ███╔╝  ", "███████╗", "╚══════╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
};
const LOGO = Array.from({ length: 6 }, (_, row) => [..."EZTEK"].map((letter) => GLYPHS[letter][row]).join(""));
const LOGO_WIDTH = Math.max(...LOGO.map(visibleWidth));

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
          // `mdLink` is blue in every bundled theme and follows the active theme's link color elsewhere.
          const blue = (t: string) => theme.fg("mdLink", t);
          const white = (t: string) => theme.fg("text", t);

          // Narrow terminals cannot fit the block letters, so they get the plain name instead.
          const logo = w >= LOGO_WIDTH + 2 ? LOGO.map(blue) : [theme.bold(blue("EZtek"))];
          const banner = [...logo, theme.bold(white(TAGLINE)), white(`Pi Coding Agent v${VERSION}`)];

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
