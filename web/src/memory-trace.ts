/**
 * The path a run of Understory's own agent took through the memory, read from
 * the notation it keeps ("browse layout → read branches.md → ✓"): its steps,
 * and which of them name a note of the graph, so that the graph can light the
 * notes the run touched. Understory writes the notes' file names as it chose
 * to (a full path, a path from some folder, or only the name), so a step is
 * matched to a note by as much of the path as it gives, and left unmatched
 * rather than guessed when more than one note would fit.
 */
export interface TraceStep {
  /** The step as written. */
  text: string;
  /** What was done, its first word. */
  verb: string;
  /** What it was done to: the rest of the step. */
  target: string;
  /** The notes of the graph the step names: one, or none. */
  notes: string[];
  /** The step says how the run ended, with a tick or a cross. */
  end?: "ok" | "failed";
}

const ARROW = /\s*(?:→|->|⟶)\s*/;
const ENDS: Record<string, "ok" | "failed"> = { "✓": "ok", "✔": "ok", "✗": "failed", "✘": "failed", "✕": "failed", "×": "failed" };
/** A file name of a note in a step: not cut at a slash, a dot or a dash, and not at the quotes and brackets it may be wrapped in. */
const FILE = /[^\s"'`,;()[\]<>]+\.md\b/;

/** The note a name in a step stands for, or none: the full path, else a path that ends the way the name does, and a bare file name only when one note has it. */
export function noteOf(name: string, paths: string[]): string | undefined {
  const bare = name.replace(/^(?:\.{1,2}\/)+/, "").replace(/^\/+/, "");
  const exact = paths.filter((p) => p.replace(/^\/+/, "") === bare);
  if (exact.length === 1) return exact[0];
  const tail = paths.filter((p) => p.endsWith(`/${bare}`));
  return tail.length === 1 ? tail[0] : undefined;
}

/** The steps of a notation, with the notes of `paths` they name. */
export function stepsOf(notation: string | undefined, paths: string[]): TraceStep[] {
  if (!notation?.trim()) return [];
  return notation
    .split(ARROW)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text): TraceStep => {
      const end = ENDS[text];
      if (end) return { text, verb: text, target: "", notes: [], end };
      const [verb, ...rest] = text.split(/\s+/);
      const file = FILE.exec(text)?.[0];
      const note = file ? noteOf(file, paths) : undefined;
      return { text, verb, target: rest.join(" "), notes: note ? [note] : [] };
    });
}

/** The notes a run touched, in the order it came to them, each once. */
export const notesOf = (steps: TraceStep[]): string[] => [...new Set(steps.flatMap((s) => s.notes))];
