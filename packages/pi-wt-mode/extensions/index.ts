import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("wt-mode", {
    description: "wt mode placeholder command",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-wt-mode is loaded", "info");
    },
  });
}
