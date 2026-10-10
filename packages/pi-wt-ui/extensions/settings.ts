import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WtSettings {
  statusBar: boolean;
  toolCards: boolean;
  diffPreview: boolean;
  turnSeparator: boolean;
  editor: boolean;
  todos: boolean;
  ask: boolean;
  welcome: boolean;
  userMessage: boolean;
}

export const DEFAULT_SETTINGS: WtSettings = {
  statusBar: true,
  toolCards: true,
  diffPreview: true,
  turnSeparator: true,
  editor: true,
  todos: true,
  ask: true,
  welcome: true,
  userMessage: true,
};

const FILE_NAME = "pi-wt-settings.json";

export function globalSettingsPath(): string {
  return join(homedir(), ".pi", "agent", FILE_NAME);
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", FILE_NAME);
}

function readFile(path: string, errors: string[]): Partial<WtSettings> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  let data: unknown;
  try {
    // A BOM (common from Windows editors) makes JSON.parse throw.
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    errors.push(`${path}: expected a JSON object`);
    return {};
  }

  const result: Partial<WtSettings> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(key in DEFAULT_SETTINGS)) {
      errors.push(`${path}: unknown key "${key}"`);
    } else if (typeof value !== "boolean") {
      errors.push(`${path}: "${key}" must be true or false`);
    } else {
      result[key as keyof WtSettings] = value;
    }
  }
  return result;
}

/** Writes the global file with every default on first run. Never overwrites, never touches the project file. */
export function ensureGlobalSettings(): string | undefined {
  const path = globalSettingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // "wx" fails if the file exists, so a user's edits are never replaced.
    writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    return `${path}: could not create (${error instanceof Error ? error.message : "unknown error"})`;
  }
}

/** Defaults, then the global file, then the project file. Read on every call so `/reload` picks up edits. */
export function loadSettings(cwd: string): { settings: WtSettings; errors: string[] } {
  const errors: string[] = [];
  const settings: WtSettings = {
    ...DEFAULT_SETTINGS,
    ...readFile(globalSettingsPath(), errors),
    ...readFile(projectSettingsPath(cwd), errors),
  };
  return { settings, errors };
}
