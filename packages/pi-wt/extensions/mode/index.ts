import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor.ts";
import { registerBtw } from "./btw/commands.ts";
import { loadConfig } from "./config.ts";
import { modelLabel } from "./models.ts";

export function registerMode(pi: ExtensionAPI) {
  registerAdvisor(pi);
  registerBtw(pi);
  pi.registerCommand("wt-mode", {
    description: "Show BTW and advisor model configuration",
    handler: async (_args, ctx) => {
      const config = await loadConfig(ctx);
      ctx.ui.notify(`BTW: ${modelLabel(config.btw.model)} · thinking: ${config.btw.thinkingLevel ?? "inherit main"}\n`
        + `Advisor: ${config.advisor.model ? modelLabel(config.advisor.model) : "disabled"} · thinking: ${config.advisor.thinkingLevel ?? "inherit main"} · ${config.advisor.maxCallsPerRun} calls/run`, "info");
    },
  });
}
