import { PLAN_OFF_TOOL, TODO_TOOL } from "./state.ts";

export function planGuidelines(): string[] {
  return [
    "PLAN MODE is active. Investigate and design only; do not implement anything yet.",
    "Do not modify files. The write and edit tools are blocked. Do not run bash or shell commands whose purpose is to change files or repository state: no redirections into files, sed -i, tee, mv, cp, rm, mkdir, git add/commit/checkout/reset/stash, package installs, formatters or code generators. Read-only commands are fine.",
    "Explore with read, grep, find and ls until you can write a concrete plan.",
    "End your turn with the plan as your final message: goal, files involved, ordered steps, risks and open questions. Then stop and wait for the user.",
    `If the user replies that they want the plan implemented, call ${PLAN_OFF_TOOL} on its own (no other tool calls in the same message). Never call it before the user has replied to a finished plan. If the user asks for changes instead, revise the plan and stop again.`,
  ];
}

export function implementGuidelines(todoAvailable: boolean): string[] {
  const checklist = todoAvailable
    ? `Before changing any file, call ${TODO_TOOL} with action "set" to create a checklist from the approved plan, then implement it and mark each step as you go.`
    : "Before changing any file, write a short checklist from the approved plan, then implement it step by step.";
  return ["Plan mode was turned off by the user, so implementation is allowed now.", checklist];
}

export function offToolResult(todoAvailable: boolean): string {
  const checklist = todoAvailable
    ? `Call ${TODO_TOOL} with action "set" and one item per plan step before changing any file, then implement the plan and update each step as you go.`
    : "Write a short checklist of the plan steps before changing any file, then implement them one by one.";
  return `Plan mode is off. Implementation is allowed. ${checklist}`;
}
