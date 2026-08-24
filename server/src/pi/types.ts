import type { EventEmitter } from "node:events";

export interface PiState {
  model: { id: string; name: string; provider: string; contextWindow?: number };
  thinkingLevel: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
}

export interface PiStats {
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
  cost: number;
  contextUsage: { tokens: number; contextWindow: number; percent: number };
  toolCalls: number;
  totalMessages: number;
}

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
   * pi's session file for this conversation, once it exists. Recorded by the
   * portal so the same conversation is reopened after a restart instead of a
   * new one being started. Undefined for executors that cannot report it.
   */
  readonly sessionFile?: string;

  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  /**
   * Whether the agent has stopped for good — not merely between turns.
   * Optional: an executor that cannot see inside pi leaves it out, and
   * the run's own lifecycle events are then the only signal.
   */
  isIdle?(): boolean;
  dispose(): void;

  getState(): Promise<PiState>;
  getStats(): Promise<PiStats>;
  getThinkingLevels(): Promise<string[]>;
  getModels(): Promise<PiState["model"][]>;
  getCommands(): Promise<PiCommand[]>;

  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** Re-read pi's settings file. Optional: not every executor can. */
  refreshSettings?(): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
  compact(): Promise<void>;
  reload(): Promise<void>;
  /** Write the session to disk; returns the file path. */
  exportSession(target?: string): Promise<string>;

  /** Answer an extension dialog. Returns false if the request is unknown/expired. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean;
}
