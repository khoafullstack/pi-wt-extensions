import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUi } from "./ui/index.ts";
import { registerMode } from "./mode/index.ts";
import { registerPlan } from "./plan/index.ts";
import { ensureSettings } from "./settings.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => { await ensureSettings(ctx); });
  registerUi(pi);
  registerMode(pi);
  registerPlan(pi);
}
