import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelReference } from "./config.ts";
import { ModelSelector } from "./model-selector.ts";

export function modelLabel(reference: ModelReference | null): string {
  return reference ? `${reference.provider}/${reference.id}` : "inherit main";
}

/** Inline provider/id works in every host; dialogs are only used when available. */
export async function chooseModel(ctx: ExtensionContext, args: string, title: string,
  isCurrent: () => boolean = () => true): Promise<ModelReference | null | undefined> {
  let choice = args.trim();
  if (!choice) {
    if (!ctx.hasUI) throw new Error(`${title}: provide provider/model-id or clear inline`);
    const options = ["clear", ...ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`)];
    choice = (ctx.mode === "tui"
      ? await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) =>
        new ModelSelector(tui, title, options, getSelectListTheme(), done))
      : await ctx.ui.select(title, options)) ?? "";
    if (!choice || !isCurrent()) return undefined;
  }
  if (choice === "clear") return null;
  const slash = choice.indexOf("/");
  if (slash < 1) throw new Error(`${title}: expected provider/model-id or clear`);
  const reference = { provider: choice.slice(0, slash), id: choice.slice(slash + 1) };
  const selected = ctx.modelRegistry.find(reference.provider, reference.id);
  if (!selected) throw new Error(`${title}: unknown model ${choice}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(selected)) throw new Error(`${title}: no credentials for ${choice}`);
  return reference;
}

export function resolveBtwModel(ctx: ExtensionContext, reference: ModelReference | null): Model<Api> {
  if (reference) {
    const override = ctx.modelRegistry.find(reference.provider, reference.id);
    if (override && ctx.modelRegistry.hasConfiguredAuth(override)) return override;
    ctx.ui.notify(`wt-btw: ${modelLabel(reference)} unavailable; using main model`, "warning");
  }
  if (!ctx.model) throw new Error("wt-btw: no main model available; configure /wt-btw-config");
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("wt-btw: main model has no credentials");
  return ctx.model;
}
