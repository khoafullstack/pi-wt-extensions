import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelReference { provider: string; id: string }
export interface ModeConfig {
  btw: {
    model: ModelReference | null;
    thinkingLevel: ThinkingLevel | null;
    focusShortcut: string;
    fallbackShortcut: string;
  };
  advisor: {
    model: ModelReference | null;
    thinkingLevel: ThinkingLevel | null;
    maxCallsPerRun: number;
    timeoutMs: number;
    maxOutputTokens: number;
  };
}
export interface ConfigPatch {
  btw?: Partial<ModeConfig["btw"]>;
  advisor?: Partial<ModeConfig["advisor"]>;
}
export type ConfigContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface WtSettings {
  statusBar: boolean; toolCards: boolean; diffPreview: boolean; turnSeparator: boolean;
  editor: boolean; todos: boolean; ask: boolean; welcome: boolean; userMessage: boolean;
}
export const DEFAULT_SETTINGS: WtSettings = {
  statusBar: true, toolCards: true, diffPreview: true, turnSeparator: true,
  editor: true, todos: true, ask: true, welcome: true, userMessage: true,
};
const FILE_NAME = "pi-wt-settings.json";
export function globalSettingsPath(home = homedir()): string { return join(home, ".pi", "agent", FILE_NAME); }
export function projectSettingsPath(cwd: string): string { return join(cwd, ".pi", FILE_NAME); }
export function defaultSettings(): WtSettings & ModeConfig { return { ...DEFAULT_SETTINGS, ...defaultConfig() }; }

/** UI flags retain project overrides; mode sections are trust-gated separately. */
export function loadSettings(cwd: string, home = homedir()): { settings: WtSettings; errors: string[] } {
  const errors: string[] = [];
  const settings = { ...DEFAULT_SETTINGS };
  for (const path of [globalSettingsPath(home), projectSettingsPath(cwd)]) {
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
      if (!record(data)) throw new Error("expected a JSON object");
      for (const [key, value] of Object.entries(data)) {
        if (key === "btw" || key === "advisor") continue;
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) errors.push(`${path}: unknown key "${key}"`);
        else if (typeof value !== "boolean") errors.push(`${path}: "${key}" must be true or false`);
        else settings[key as keyof WtSettings] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { settings, errors };
}

export function defaultConfig(): ModeConfig {
  return {
    btw: { model: null, thinkingLevel: null, focusShortcut: "alt+b", fallbackShortcut: "ctrl+alt+b" },
    advisor: { model: null, thinkingLevel: null, maxCallsPerRun: 3, timeoutMs: 120_000, maxOutputTokens: 4096 },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function model(value: unknown): ModelReference | null | undefined {
  if (value === null) return null;
  if (record(value) && typeof value.provider === "string" && value.provider.trim()
    && typeof value.id === "string" && value.id.trim()) {
    return { provider: value.provider.trim(), id: value.id.trim() };
  }
  return undefined;
}
function shortcut(value: unknown): value is string {
  return typeof value === "string" && /^(?:(?:ctrl|alt|shift)\+)*[a-z0-9]$/.test(value);
}

/** Invalid fields are ignored individually, so a bad override cannot erase valid defaults. */
export function validateConfig(value: unknown): ConfigPatch {
  const patch: ConfigPatch = {};
  if (!record(value)) return patch;
  if (record(value.btw)) {
    const input = value.btw;
    const btw: ConfigPatch["btw"] = {};
    const selected = model(input.model);
    if (selected !== undefined) btw.model = selected;
    if (input.thinkingLevel === null || (typeof input.thinkingLevel === "string" && levels.has(input.thinkingLevel))) {
      btw.thinkingLevel = input.thinkingLevel as ThinkingLevel | null;
    }
    if (shortcut(input.focusShortcut)) btw.focusShortcut = input.focusShortcut;
    if (shortcut(input.fallbackShortcut)) btw.fallbackShortcut = input.fallbackShortcut;
    patch.btw = btw;
  }
  if (record(value.advisor)) {
    const input = value.advisor;
    const advisor: ConfigPatch["advisor"] = {};
    const selected = model(input.model);
    if (selected !== undefined) advisor.model = selected;
    if (input.thinkingLevel === null || (typeof input.thinkingLevel === "string" && levels.has(input.thinkingLevel))) {
      advisor.thinkingLevel = input.thinkingLevel as ThinkingLevel | null;
    }
    for (const key of ["maxCallsPerRun", "timeoutMs", "maxOutputTokens"] as const) {
      const number = input[key];
      if (typeof number === "number" && Number.isSafeInteger(number) && number > 0
        && (key !== "timeoutMs" || number <= 2_147_483_647)) advisor[key] = number;
    }
    patch.advisor = advisor;
  }
  return patch;
}

function merge(base: ModeConfig, patch: ConfigPatch): ModeConfig {
  return { btw: { ...base.btw, ...patch.btw }, advisor: { ...base.advisor, ...patch.advisor } };
}
async function readConfig(path: string): Promise<ConfigPatch> {
  try { return validateConfig(JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""))); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function configPaths(ctx: ConfigContext, home = homedir()) {
  return { global: globalSettingsPath(home), project: projectSettingsPath(ctx.cwd) };
}

async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!record(data)) throw new Error(`${path}: expected a JSON object`);
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(target: string, data: unknown, createOnly = false): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (createOnly) {
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

/** Import old mode settings once, preserving canonical overrides and the old file as a backup. */
async function migrateScope(target: string, createDefaults: boolean): Promise<void> {
  await withFileMutationQueue(target, async () => {
    const legacyPath = join(dirname(target), "wt-mode.json");
    const legacy = await readObject(legacyPath);
    if (legacy) {
      const current = await readObject(target);
      const imported = validateConfig(legacy);
      const data: Record<string, unknown> = { ...(current ?? (createDefaults ? DEFAULT_SETTINGS : {})) };
      for (const key of ["btw", "advisor"] as const) {
        if (data[key] === undefined || record(data[key])) {
          data[key] = { ...(createDefaults ? defaultConfig()[key] : {}), ...imported[key],
            ...(record(data[key]) ? data[key] : {}) };
        }
      }
      await writeAtomic(target, data);
      // Archive only after publishing successfully; interrupted migrations can safely retry.
      await rename(legacyPath, `${legacyPath}.${randomUUID()}.migrated.bak`);
    } else if (createDefaults) {
      try { await access(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeAtomic(target, defaultSettings(), true);
      }
    }
  });
}

export async function ensureGlobalConfig(home = homedir()): Promise<string> {
  const target = globalSettingsPath(home);
  await migrateScope(target, true);
  return target;
}

export async function ensureSettings(ctx: ConfigContext, home = homedir()): Promise<void> {
  const project = projectSettingsPath(ctx.cwd);
  const trusted = ctx.isProjectTrusted();
  await ensureGlobalConfig(home);
  if (trusted) await migrateScope(project, false);
}

export async function loadConfig(ctx: ConfigContext, home = homedir()): Promise<ModeConfig> {
  const paths = configPaths(ctx, home);
  const trusted = ctx.isProjectTrusted();
  let config = merge(defaultConfig(), await readConfig(paths.global));
  // Do not even read a project's configuration until Pi trusts it.
  if (trusted) config = merge(config, await readConfig(paths.project));
  return config;
}

/** Save only this scope's overrides; never copy inherited project settings into global config. */
export async function saveConfig(
  ctx: ConfigContext, patch: ConfigPatch, scope: "global" | "project" = "global", home = homedir(),
): Promise<void> {
  if (scope === "project" && !ctx.isProjectTrusted()) throw new Error("wt-mode: project is not trusted");
  const target = configPaths(ctx, home)[scope];
  await withFileMutationQueue(target, async () => {
    const previous: Record<string, unknown> = await readObject(target) ?? (scope === "global" ? { ...DEFAULT_SETTINGS } : {});
    const next = validateConfig(patch);
    const data: Record<string, unknown> = { ...previous };
    for (const key of ["btw", "advisor"] as const) {
      if (next[key] !== undefined) data[key] = { ...(record(previous[key]) ? previous[key] : {}), ...next[key] };
    }
    await writeAtomic(target, data);
  });
}
