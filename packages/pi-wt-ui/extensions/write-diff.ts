import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DiffLine {
  /** Line-number column, drawn dim and separated from the text. */
  gutter?: string;
  text: string;
  tone: "dim" | "muted" | "error" | "success";
}

export type Snapshot = { kind: "missing" } | { kind: "text"; content: string } | { kind: "skipped" };

interface Op {
  sign: " " | "+" | "-";
  /** Line number in the new file for " " and "+", in the old file for "-". */
  no: number;
  text: string;
}

interface Diff {
  ops: Op[];
  added: number;
  removed: number;
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CACHED = 200;
const MAX_DP_CELLS = 4_000_000;
const CONTEXT_LINES = 2;
const NEW_FILE_PREVIEW_LINES = 8;

const snapshots = new Map<string, Snapshot>();
const diffs = new Map<string, Diff>();

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MAX_CACHED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function resolveWritePath(cwd: string, raw: string): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

/**
 * Must run before the write tool executes: afterwards the old content is gone and the result
 * only carries the new content. Never throws, because a failing tool_call handler blocks the tool.
 */
export async function captureSnapshot(toolCallId: string, cwd: string, rawPath: unknown): Promise<void> {
  if (typeof rawPath !== "string" || !rawPath) return;

  let snapshot: Snapshot;
  try {
    const abs = resolveWritePath(cwd, rawPath);
    const info = await stat(abs);
    snapshot =
      !info.isFile() || info.size > MAX_SNAPSHOT_BYTES
        ? { kind: "skipped" }
        : { kind: "text", content: await readFile(abs, "utf8") };
  } catch (error) {
    snapshot = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "skipped" };
  }
  remember(snapshots, toolCallId, snapshot);
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function computeDiff(oldText: string, newText: string): Diff {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid: Array<{ sign: Op["sign"]; text: string; a?: number; b?: number }> = [];

  if (midA.length * midB.length > MAX_DP_CELLS) {
    // Too large for an exact LCS: report the whole changed region as replaced.
    for (const [i, text] of midA.entries()) mid.push({ sign: "-", text, a: start + i + 1 });
    for (const [i, text] of midB.entries()) mid.push({ sign: "+", text, b: start + i + 1 });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        mid.push({ sign: " ", text: midB[j], a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        mid.push({ sign: "-", text: midA[i], a: start + i + 1 });
        i++;
      } else {
        mid.push({ sign: "+", text: midB[j], b: start + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) mid.push({ sign: "-", text: midA[i], a: start + i + 1 });
    for (; j < m; j++) mid.push({ sign: "+", text: midB[j], b: start + j + 1 });
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ sign: " ", no: i + 1, text: a[i] });
  let added = 0;
  let removed = 0;
  for (const item of mid) {
    if (item.sign === "+") added++;
    if (item.sign === "-") removed++;
    ops.push({ sign: item.sign, no: (item.sign === "-" ? item.a : item.b) as number, text: item.text });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ sign: " ", no: endB + k + 1, text: a[endA + k] });

  return { ops, added, removed };
}

function clean(text: string): string {
  return text.replace(/\t/g, "  ");
}

function numberWidth(ops: Op[]): number {
  let max = 1;
  for (const op of ops) max = Math.max(max, op.no);
  return String(max).length;
}

function formatOp(op: Op, width: number): DiffLine {
  const tone = op.sign === "+" ? "success" : op.sign === "-" ? "error" : "dim";
  return { gutter: `${String(op.no).padStart(width)} │`, text: `${op.sign} ${clean(op.text)}`, tone };
}

/** Changed lines plus a few lines of context, with a separator between distant hunks. */
function hunkLines(ops: Op[]): DiffLine[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (const [i, op] of ops.entries()) {
    if (op.sign === " ") continue;
    for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(ops.length - 1, i + CONTEXT_LINES); k++) keep[k] = true;
  }

  const width = numberWidth(ops);
  const out: DiffLine[] = [];
  let lastKept = -1;
  for (const [i, op] of ops.entries()) {
    if (!keep[i]) continue;
    if (lastKept !== -1 && i !== lastKept + 1) out.push({ gutter: `${" ".repeat(width)} ⋯`, text: "", tone: "muted" });
    out.push(formatOp(op, width));
    lastKept = i;
  }
  return out;
}

function limited(lines: DiffLine[], limit: number): DiffLine[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), { text: `… ${lines.length - limit} more diff lines`, tone: "muted" }];
}

export interface WriteSummaryOptions {
  expanded: boolean;
  /** Show the diff while collapsed. */
  preview: boolean;
  previewLines: number;
  expandedLines: number;
}

/** Returns undefined when no snapshot exists (for example a session resumed from disk). */
export function summarizeWrite(
  toolCallId: string,
  newContent: string,
  options: WriteSummaryOptions,
): { detail: string; body: DiffLine[] } | undefined {
  const snapshot = snapshots.get(toolCallId);
  if (!snapshot || snapshot.kind === "skipped") return undefined;

  const visible = options.expanded ? options.expandedLines : options.previewLines;
  const showBody = options.expanded || options.preview;

  if (snapshot.kind === "missing") {
    const lines = splitLines(newContent);
    const ops: Op[] = lines.map((text, i) => ({ sign: "+", no: i + 1, text }));
    const width = numberWidth(ops);
    const shown = options.expanded ? options.expandedLines : Math.min(options.previewLines, NEW_FILE_PREVIEW_LINES);
    const body = limited(ops.map((op) => formatOp(op, width)), shown);
    return { detail: `new file · +${lines.length}`, body: showBody ? body : [] };
  }

  let diff = diffs.get(toolCallId);
  if (!diff) {
    diff = computeDiff(snapshot.content, newContent);
    remember(diffs, toolCallId, diff);
  }

  if (diff.added === 0 && diff.removed === 0) return { detail: "no changes", body: [] };

  return {
    detail: `overwritten · +${diff.added} −${diff.removed}`,
    body: showBody ? limited(hunkLines(diff.ops), visible) : [],
  };
}
