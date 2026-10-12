import type { EventEmitter } from "node:events";
import type { ImageContent } from "../prompt-images.js";

export interface PiState {
  model: {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    /** What the model takes: "text", and "image" if it can see pictures. Unknown when left out. */
    input?: string[];
  };
  thinkingLevel: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
}

export interface PiStats {
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
  cost: number;
  /**
   * `tokens` and `percent` are null just after a compaction: the last count
   * was taken before it, and pi will not guess until the next reply.
   */
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null };
  toolCalls: number;
  totalMessages: number;
}

/** A tool a session could use, and where it came from. */
export interface PiTool {
  name: string;
  description?: string;
  /** The package or file that registered it, for grouping. */
  source: string;
  /** The entry in pi's settings that brought it, where a package of the user's did. */
  package?: string;
  /** One of the portal's own, from an inline extension: no file or package of anyone's has a path like that, so it is not mistaken for an extension's of the same name. */
  inline?: true;
  /** An MCP server's tool listed from the adapter's cache, its server not started until the tool is first used. */
  cached?: true;
  /** False when this conversation has it switched off. */
  enabled: boolean;
  /** Whether it is on by default, so the page can say where a chat disagrees. */
  defaultOn?: boolean;
}

/**
 * What pi did with a message it took: queued it into the run that is going —
 * `text` is the words as pi queued them, a template or skill expanded and an
 * input handler's rewrite applied, which is what the message is when the agent
 * reads it — started a run with it, or had an extension handle it outright.
 */
export type PromptTaken =
  | { outcome: "queued"; lane: "steering" | "followUp"; text: string }
  | { outcome: "started" }
  | { outcome: "handled" };

export interface PiCommand {
  name: string;
  description?: string;
  source: string;
}

/**
 * What the portal needs from a pi session, regardless of how it is reached.
 *
 * Two implementations exist because the two executors are genuinely different
 * situations: the host executor runs pi in this process via the SDK, while the
 * container executor talks to pi inside another container, where only the RPC
 * protocol can reach.
 */
export interface PiClient extends EventEmitter {
  readonly running: boolean;
  /**
   * Speak to a subagent an extension announced over the subagent protocol
   * (see subagent-protocol.ts). False when this executor cannot reach the
   * extensions' event bus. Optional: only the in-process client can.
   */
  subagentInput?(id: string, text: string): boolean;
  subagentStop?(id: string): boolean;
  /** How many subagents it announced are still running: a background one outlives the turn that started it. */
  subagentsRunning?(): number;
  /** How many dialogs an extension has open, waiting on a person: its pi is not one to stop. */
  dialogsOpen?(): number;
  /** Says each subagent still running has stopped: its pi is about to go. */
  endSubagents?(why: string): void;
  /**
   * Where the chat box's text is kept — by the portal, one copy for the page
   * and pi alike — for an extension's getEditorText, and for what it puts in
   * the box. Optional: pi's RPC mode answers that itself, with nothing.
   */
  useDrafts?(drafts: DraftStore): void;
  /**
   * pi's session file for this conversation, once it exists. Recorded by the
   * portal so the same conversation is reopened after a restart instead of a
   * new one being started. Undefined for executors that cannot report it.
   */
  readonly sessionFile?: string;

  /**
   * `steer` delivers a message sent mid-run into that run instead of after it.
   * Resolves once pi has taken the message, with what it did with it where the
   * executor can tell: see PromptTaken.
   */
  prompt(
    message: string,
    options?: { voice?: boolean; images?: ImageContent[]; steer?: boolean },
  ): Promise<PromptTaken | void>;
  abort(): Promise<void>;
  /**
   * Whether the agent has stopped for good — not merely between turns.
   * Optional: an executor that cannot see inside pi leaves it out, and
   * the run's own lifecycle events are then the only signal.
   */
  isIdle?(): boolean;
  /**
   * Drops the messages sent mid-run that the agent has not taken in yet.
   * Stopping a run leaves them queued otherwise, and they are slipped into
   * whatever runs next. Optional, like isIdle. Returns the words of what it
   * dropped, as pi had queued them.
   */
  clearQueue?(): string[];
  /**
   * Tells the extensions their pi is being let go, as pi's own runtime does
   * before it disposes one: that is where they stop their timers and the
   * processes they started. Settles when they have, or have said they cannot.
   * Optional: a pi in a process of its own does this as it exits.
   */
  shutdown?(): Promise<void>;
  dispose(): void;

  getState(): Promise<PiState>;
  getStats(): Promise<PiStats>;
  getThinkingLevels(): Promise<string[]>;
  getModels(): Promise<PiState["model"][]>;
  getCommands(): Promise<PiCommand[]>;
  /**
   * Every tool this session could use, and whether it is on.
   * Optional: an executor that cannot ask pi leaves it out.
   */
  getTools?(): Promise<PiTool[]>;
  /** Switch tools off by name. Everything not named is on. */
  setToolsOff?(names: string[]): Promise<void>;

  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** Re-read pi's settings file. Optional: not every executor can. */
  refreshSettings?(): Promise<void>;
  /** Take up a changed context limit for the current model. Optional, like the above. */
  applyContextLimit?(): void;
  setAutoRetry(enabled: boolean): Promise<void>;
  compact(): Promise<void>;
  reload(): Promise<void>;
  /** Write the session to disk; returns the file path. */
  exportSession(target?: string): Promise<string>;

  /** Answer an extension dialog. Returns false if the request is unknown/expired. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean;
  /** The dialogs (confirm, select, input, editor, questions) still waiting, as sent, for a page that opens meanwhile. Only where the portal draws them. */
  openDialogRequests?(): Record<string, unknown>[];
}

/** What is in a chat's box, and what is selected in it: where a paste goes. */
export type Draft = { text: string; caret?: { start: number; end: number } };
export interface DraftStore {
  get(): Draft | undefined;
  set(text: string, caret?: { start: number; end: number }): void;
}
