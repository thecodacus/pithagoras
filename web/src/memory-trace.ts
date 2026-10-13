import type { MemoryTraceStep } from "./api";

/**
 * A run of Understory's own agent as the graph shows it: its steps in a line,
 * and the notes it touched.
 *
 * The line is the run's notation, which Understory writes for a person to
 * read (`search "owner" (2) → read owner.md → ✓`): it names a note by its file
 * name only, and says how many notes a search found, not which. So the notes
 * are not read from it. They come from the run's own steps (`MemoryTraceStep`,
 * from Understory's `/api/trace`), which give the full path of each, and a
 * step that read, wrote, patched or deleted a note is the one that touched it.
 * A search only found notes, so it lights none: its words say how many.
 */
export type TraceEnd = "ok" | "partial" | "failed";

export interface TraceStep {
  /** The step as written. */
  text: string;
  /** What was done, its first word. */
  verb: string;
  /** What it was done to: the rest of the step. */
  target: string;
  /** The notes of the graph the step touched, once the run's steps are known. */
  notes: string[];
  /** The step says how the run ended. */
  end?: TraceEnd;
}

/** How Understory writes how a run ended: its last step. */
const ENDS: Record<string, TraceEnd> = { "✓": "ok", "⚠ partial": "partial", "✗": "failed" };
/** The tools that touch a note, as opposed to finding one or looking at the layout. */
const TOUCHES = new Set(["read_concept", "write_concept", "patch_concept", "delete_concept"]);

/** A run as the graph shows it. */
export interface TracePath {
  steps: TraceStep[];
  /** The notes the run touched that are in the graph, in the order it came to them, each once. */
  notes: string[];
  /** Whether the run changed the memory: by what its steps did when they are known, else by what it was asked. */
  changed: boolean;
  /** Whether the run's steps are known: before, nothing is said of which notes it touched. */
  known: boolean;
  /** How many notes the run touched, in the graph or not. */
  touched: number;
}

/**
 * What the graph shows of a run: its notation cut into steps, and, when its own
 * steps are known (`run`), which notes of the graph (`inGraph`) each touched.
 */
export function pathOf(trace: { kind: string; notation?: string }, run: MemoryTraceStep[] | undefined, inGraph: ReadonlySet<string>): TracePath {
  const parts = (trace.notation ?? "")
    .split(/\s*(?:→|->|⟶)\s*/)
    .map((text) => text.trim())
    .filter(Boolean);
  const end = parts.length && ENDS[parts[parts.length - 1]] ? parts.pop()! : undefined;
  // One part of the notation for each step, in order; a run that does not add up is not guessed at.
  const lined = run && run.length === parts.length ? run : undefined;
  const steps = parts.map((text, i): TraceStep => {
    const [verb, ...rest] = text.split(/\s+/);
    const touching = lined && TOUCHES.has(lined[i].tool) ? lined[i].paths.filter((p) => inGraph.has(p)) : [];
    return { text, verb, target: rest.join(" "), notes: touching };
  });
  if (end) steps.push({ text: end, verb: end, target: "", notes: [], end: ENDS[end] });
  const touched = lined ? new Set(lined.filter((s) => TOUCHES.has(s.tool)).flatMap((s) => s.paths)).size : 0;
  return {
    steps,
    notes: [...new Set(steps.flatMap((s) => s.notes))],
    changed: run ? run.some((s) => s.write) : trace.kind === "mutation",
    known: !!lined,
    touched,
  };
}
