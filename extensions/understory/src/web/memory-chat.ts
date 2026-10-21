/**
 * The librarian chat on the Memory page: Understory's agent, talked to the way
 * its own web UI does — the AI SDK's UI messages go up whole, and the answer
 * comes back as a stream of chunks (server-sent events) that build the next
 * message. Only the chunks that matter here are read; the rest are skipped.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  /** `tool-<name>`, as the AI SDK names a tool's part. */
  type: `tool-${string}`;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export interface StepPart {
  type: "step-start";
}

export type ChatPart = TextPart | ToolPart | StepPart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
}

/** What a stream says when it fails, besides the chunks: a turn that ends in an error. */
export interface Turn {
  message: ChatMessage;
  error?: string;
}

const isTool = (part: ChatPart): part is ToolPart => part.type.startsWith("tool-");

/** The name of the tool a part is of. */
export const toolName = (part: ToolPart): string => part.type.slice("tool-".length);

/**
 * One chunk of the stream applied to the turn. The parts are copied, never
 * changed in place, so that a page can hold each state as it was.
 */
export function applyChunk(turn: Turn, chunk: unknown): Turn {
  if (!chunk || typeof chunk !== "object") return turn;
  const c = chunk as Record<string, unknown>;
  const parts = turn.message.parts;
  const withParts = (next: ChatPart[]): Turn => ({ ...turn, message: { ...turn.message, parts: next } });
  const toolIndex = () => parts.findIndex((p) => isTool(p) && p.toolCallId === c.toolCallId);
  const changeTool = (change: Partial<ToolPart>): Turn => {
    const i = toolIndex();
    if (i < 0) return turn;
    return withParts(parts.map((p, n) => (n === i ? ({ ...p, ...change } as ToolPart) : p)));
  };
  switch (c.type) {
    case "start-step":
      return withParts([...parts, { type: "step-start" }]);
    case "text-start":
      return withParts([...parts, { type: "text", text: "" }]);
    case "text-delta": {
      if (typeof c.delta !== "string") return turn;
      const last = parts.at(-1);
      // A delta without its start (a server that skips it) opens the text itself.
      if (last?.type !== "text") return withParts([...parts, { type: "text", text: c.delta }]);
      return withParts([...parts.slice(0, -1), { type: "text", text: last.text + c.delta }]);
    }
    case "tool-input-start":
    case "tool-input-available": {
      if (typeof c.toolCallId !== "string" || typeof c.toolName !== "string") return turn;
      if (toolIndex() >= 0) return changeTool({ state: "input-available", input: c.input });
      return withParts([
        ...parts,
        { type: `tool-${c.toolName}`, toolCallId: c.toolCallId, state: c.type === "tool-input-start" ? "input-streaming" : "input-available", input: c.input },
      ]);
    }
    case "tool-output-available":
      return changeTool({ state: "output-available", output: c.output });
    case "tool-output-error":
    case "tool-input-error":
      return changeTool({ state: "output-error", errorText: typeof c.errorText === "string" ? c.errorText : "" });
    case "error":
      return { ...turn, error: typeof c.errorText === "string" && c.errorText ? c.errorText : "An error occurred." };
    default:
      return turn;
  }
}

/**
 * The data lines of a server-sent event stream as they complete: `feed` takes
 * the text as it arrives, in any pieces, and returns the chunks it finished.
 * `[DONE]` is the stream's last line, not a chunk.
 */
export function eventReader(): { feed: (text: string) => unknown[] } {
  let rest = "";
  return {
    feed(text) {
      rest += text;
      const chunks: unknown[] = [];
      let end: number;
      // An event ends at an empty line; what follows the last one is still arriving.
      while ((end = rest.search(/\r?\n\r?\n/)) >= 0) {
        const event = rest.slice(0, end);
        rest = rest.slice(end).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          chunks.push(JSON.parse(data));
        } catch {
          // A line that is not JSON is no chunk of this protocol.
        }
      }
      return chunks;
    },
  };
}

/** Whether a turn changed anything: it called a tool, and the memory may be different. */
export const usedTools = (message: ChatMessage): boolean => message.parts.some(isTool);

/** What the conversation shows of a message: its words, or nothing yet. */
export const textOf = (message: ChatMessage): string =>
  message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");

/** About how much of a conversation is sent each time, in bytes: the server takes 2 MB, and a tool's answer can be a whole note. */
const HISTORY_BYTES = 1_000_000;

/** The most messages sent each time: the server refuses a conversation of more than 200 (MAX_CHAT_MESSAGES), a ceiling this stays well under. */
const HISTORY_MESSAGES = 100;

/** What a value takes on the wire: UTF-8 bytes, which the server's limit counts, not the UTF-16 units `.length` counts. */
const wireBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The conversation as it goes up: only what the model can be given back. A
 * tool call that never got its answer (the turn was stopped, or failed) would
 * make the model's API refuse the whole conversation, so it stays out, and so
 * does an assistant turn left with nothing in it. The oldest messages are
 * dropped when it grows past what is sent, in messages or in bytes.
 */
export function history(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const m of messages) {
    const parts = m.parts.filter((p) => (isTool(p) ? p.state === "output-available" || p.state === "output-error" : p.type === "text" ? p.text !== "" : true));
    // Steps with nothing between them are no step.
    const cleaned = parts.filter((p, i) => p.type !== "step-start" || (parts[i + 1] && parts[i + 1].type !== "step-start"));
    if (m.role === "user" ? cleaned.length : cleaned.some((p) => p.type !== "step-start")) kept.push({ ...m, parts: cleaned });
  }
  let size = wireBytes(kept);
  const dropOldest = () => {
    size -= wireBytes(kept.shift());
    // A conversation must start with the user.
    while (kept.length > 1 && kept[0].role !== "user") size -= wireBytes(kept.shift());
  };
  // The last message is the question: it always goes.
  while (kept.length > 1 && (size > HISTORY_BYTES || kept.length > HISTORY_MESSAGES)) dropOldest();
  return kept;
}
