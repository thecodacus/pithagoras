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
 * A search only found notes, so it lights none: its words say how many. The
 * words of the line are made from those steps too, once they are known.
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

/** What Understory cuts a search's query to in the notation: its words are the notation's, so they are written the same here. */
const QUERY_LETTERS = 30;
const cut = (text: string) => (text.length > QUERY_LETTERS ? `${text.slice(0, QUERY_LETTERS - 1)}…` : text);
/** A file name, as the notation writes a note: the last part of its path. */
const fileName = (path: string) => path.split("/").pop() ?? path;

/** What a step says, as Understory's notation writes it (`buildNotation`), from the step itself. */
function wordsOf(step: MemoryTraceStep): string {
  switch (step.tool) {
    case "search_knowledge":
      return `search "${cut(step.summary)}" (${step.paths.length})`;
    case "read_concept":
      return `read ${fileName(step.paths[0] ?? step.summary)}`;
    case "list_directory":
      return "browse layout";
    case "lint_knowledge":
      return "lint graph";
    case "write_concept":
      return `write ${fileName(step.paths[0] ?? "")}`;
    case "patch_concept":
      return `patch ${fileName(step.paths[0] ?? "")}`;
    case "delete_concept":
      return `delete ${fileName(step.paths[0] ?? "")}`;
    default:
      return step.tool;
  }
}

const OUTCOMES: Record<string, string> = { success: "✓", partial: "⚠ partial", failed: "✗" };

/**
 * What the graph shows of a run: its steps in a line, and which notes of the
 * graph (`inGraph`) each touched.
 *
 * Once the run's own steps are known (`run`), the line is made from them, not
 * cut out of the notation: a search's query is written there as it was asked,
 * and may hold an arrow. Until they are, it is the notation cut at Understory's
 * own joint (` → `), words only, and nothing is said of the notes.
 */
export function pathOf(trace: { kind: string; notation?: string }, run: { steps: MemoryTraceStep[]; outcome?: string } | undefined, inGraph: ReadonlySet<string>): TracePath {
  let parts = (trace.notation ?? "")
    .split(" → ")
    .map((text) => text.trim())
    .filter(Boolean);
  let end = parts.length && ENDS[parts[parts.length - 1]] ? parts.pop()! : undefined;
  if (run) {
    parts = run.steps.map(wordsOf);
    end = run.outcome && OUTCOMES[run.outcome] ? OUTCOMES[run.outcome] : end;
  }
  const steps = parts.map((text, i): TraceStep => {
    const [verb, ...rest] = text.split(/\s+/);
    const step = run?.steps[i];
    return { text, verb, target: rest.join(" "), notes: step && TOUCHES.has(step.tool) ? step.paths.filter((p) => inGraph.has(p)) : [] };
  });
  if (end) steps.push({ text: end, verb: end, target: "", notes: [], end: ENDS[end] });
  const touched = run ? new Set(run.steps.filter((s) => TOUCHES.has(s.tool)).flatMap((s) => s.paths)).size : 0;
  return {
    steps,
    notes: [...new Set(steps.flatMap((s) => s.notes))],
    changed: run ? run.steps.some((s) => s.write) : trace.kind === "mutation",
    known: !!run,
    touched,
  };
}
