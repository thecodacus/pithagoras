import type { DiagramPlugin } from "streamdown";

/**
 * Mermaid, fetched the first time a diagram actually shows up.
 *
 * Streamdown draws a `mermaid` fence only if it is handed a diagram plugin,
 * and that plugin drags in the whole mermaid parser — around a megabyte, for
 * something most replies never contain. So it sits behind a dynamic import,
 * and the promise is cached: a transcript full of diagrams fetches it once.
 */
let pending: Promise<DiagramPlugin> | null = null;

export function loadMermaidPlugin(): Promise<DiagramPlugin> {
  pending ??= import("@streamdown/mermaid").then(({ createMermaidPlugin }) => createMermaidPlugin());
  return pending;
}

/** A fence mermaid would draw, rather than one that merely says the word. */
export const HAS_MERMAID = /^[ \t]{0,3}(```|~~~)[ \t]*mermaid\b/im;
