import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_STATE_ENTRY = "wt-plan-state";
export const PLAN_GATE_ENTRY = "wt-plan-gate";
export const PLAN_OFF_TOOL = "wt-plan-off";
export const TODO_TOOL = "wt-ui-todo";
/** `pi.events` channel announcing `{ active: boolean }`; the prompt editor shows it in its top border. */
export const PLAN_CHANGED_EVENT = "wt-plan:changed";

/** Tools that can change files directly; bash is only restrained through the prompt. */
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export interface PlanSnapshot { active: boolean; gateShown: boolean }

function snapshot(data: unknown): PlanSnapshot | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { active, gateShown } = data as Record<string, unknown>;
  if (typeof active !== "boolean") return undefined;
  return { active, gateShown: active && gateShown === true };
}

export function restoreSnapshot(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): PlanSnapshot {
  let state: PlanSnapshot = { active: false, gateShown: false };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
    state = snapshot(entry.data) ?? state;
  }
  return state;
}

/**
 * Plan mode state. `gateShown` and `confirmed` implement the review gate: the agent may leave plan
 * mode only after a plan turn ended and the user then sent a message of their own.
 */
export class PlanState {
  active = false;
  gateShown = false;
  confirmed = false;
  /** Set when the user leaves plan mode manually, so the next run is told to build a checklist first. */
  implementNext = false;

  private readonly pi: Pick<ExtensionAPI, "appendEntry">;

  constructor(pi: Pick<ExtensionAPI, "appendEntry">) { this.pi = pi; }

  restore(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const restored = restoreSnapshot(ctx.sessionManager.getBranch() as never);
    this.active = restored.active;
    this.gateShown = restored.gateShown;
    this.confirmed = false;
    this.implementNext = false;
  }

  private persist(): void {
    this.pi.appendEntry<PlanSnapshot>(PLAN_STATE_ENTRY, { active: this.active, gateShown: this.gateShown });
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.gateShown = false;
    this.confirmed = false;
    this.implementNext = false;
    this.persist();
  }

  /** `viaTool` means the tool result already carries the checklist instruction. */
  disable(viaTool: boolean): void {
    if (!this.active) return;
    this.active = false;
    this.gateShown = false;
    this.confirmed = false;
    this.implementNext = !viaTool;
    this.persist();
  }

  /** Called when a plan turn ended and the review gate was shown to the user. */
  openGate(): void {
    if (!this.active) return;
    this.gateShown = true;
    this.confirmed = false;
    this.persist();
  }

  /** A user-typed message after the gate counts as the confirmation the agent needs. */
  noteUserMessage(): void {
    if (this.active && this.gateShown) this.confirmed = true;
  }
}
