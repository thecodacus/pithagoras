import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiClient, PiCommand, PiState, PiStats } from "./types.js";
import type { ImageContent } from "../prompt-images.js";
import { isDialog } from "./ui-requests.js";

/** A message pi emits on stdout. `type: 'response'` replies to a command; everything else is an event. */
export interface PiMessage {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * How long a command that does its work before it answers may take: pi replies to `compact` once the summary
 * is written, and to `reload` once everything is read again. The default would give up on a local model
 * that needs minutes, while pi goes on and the chat is already shown idle.
 */
const LONG_COMMAND_MS = 30 * 60_000;

/**
 * Client for `pi --mode rpc`: newline-delimited JSON over the child's stdio.
 *
 * Framing note from pi's docs: records are separated by LF only. Node's
 * `readline` also splits on U+2028/U+2029, which would corrupt any payload
 * containing those characters, so the buffer is split manually.
 */
export class PiRpcClient extends EventEmitter implements PiClient {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (m: PiMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  /** See PiClient.reloadDue. pi in its container reloads only between runs: the portal does that once the run is over. */
  reloadDue = false;

  /**
   * `dialogs` is false where nobody can answer a dialog an extension opens (see showsDialogs): pi's RPC mode
   * sends each as a request and waits for the answer, so it is answered here at once with "cancelled", which
   * pi turns into the no-answer value, and the request goes to no page. As the SDK client does on the host.
   */
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly dialogs = true) {
    super();
    this.setMaxListeners(0);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    child.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`pi exited (code=${code} signal=${signal}) before replying`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    child.on("error", (err) => this.emit("error", err));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    // Split on LF only — see framing note above.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: PiMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // A non-JSON line is pi logging to stdout; surface it rather than crash.
        this.emit("stderr", trimmed + "\n");
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: PiMessage): void {
    if (msg.type === "response" && msg.id) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
    }
    if (!this.dialogs && msg.type === "extension_ui_request" && isDialog(msg.method) && typeof msg.id === "string") {
      this.respondUi(msg.id, { cancelled: true });
      return;
    }
    this.emit("event", msg);
  }

  /** Send a command and wait for its matching `response`. */
  send(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<PiMessage> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, type, ...params }) + "\n";

    return new Promise<PiMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Submit a prompt. Resolves as soon as pi accepts it — the actual work streams
   * back as events, which is what lets a task keep running after the browser
   * that started it has gone away.
   */
  async prompt(message: string, options?: { images?: ImageContent[]; steer?: boolean }): Promise<void> {
    const res = await this.send("prompt", {
      message,
      ...(options?.images?.length ? { images: options.images } : {}),
      // pi refuses a prompt during a run unless told how to queue it.
      streamingBehavior: options?.steer ? "steer" : "followUp",
    });
    if (res.success === false) throw new Error(res.error || "pi rejected the prompt");
  }

  async abort(): Promise<void> {
    await this.send("abort");
  }

  dispose(): void {
    if (!this.closed) this.child.kill("SIGTERM");
  }

  // --- config, expressed as RPC commands ---

  private async data<T>(type: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const res = await this.send(type, params, timeoutMs);
    if (res.success === false) throw new Error(res.error || `pi rejected '${type}'`);
    return res.data as T;
  }

  async getState(): Promise<PiState> {
    return this.data<PiState>("get_state");
  }

  async getStats(): Promise<PiStats> {
    const d = await this.data<Partial<PiStats> | undefined>("get_session_stats");
    // pi leaves the usage out with no model, or a window of 0; the readers of the stats take it to be there, as the SDK client's always is.
    return { ...d, contextUsage: d?.contextUsage ?? { tokens: null, contextWindow: 0, percent: null } } as PiStats;
  }

  async getThinkingLevels(): Promise<string[]> {
    const d = await this.data<{ levels: string[] }>("get_available_thinking_levels");
    return d?.levels ?? [];
  }

  async getModels(): Promise<PiState["model"][]> {
    const d = await this.data<{ models: PiState["model"][] }>("get_available_models");
    return d?.models ?? [];
  }

  async getCommands(): Promise<PiCommand[]> {
    const d = await this.data<{ commands: PiCommand[] }>("get_commands");
    return d?.commands ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    // pi resolves the pair as `${provider}/${modelId}`; both are required.
    await this.data("set_model", { provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.data("set_thinking_level", { level });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.data("set_auto_compaction", { enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.data("set_auto_retry", { enabled });
  }

  async compact(): Promise<void> {
    await this.data("compact", {}, LONG_COMMAND_MS);
  }

  async reload(): Promise<void> {
    this.reloadDue = false;
    try {
      await this.data("reload", {}, LONG_COMMAND_MS);
    } catch (e) {
      // Not reloaded, so due still: see PiClient.reloadDue.
      this.reloadDue = true;
      throw e;
    }
  }

  async exportSession(): Promise<string> {
    throw new Error("Export is not available for container sessions");
  }

  /** RPC mode answers dialogs with its own message type. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    this.child.stdin.write(
      JSON.stringify({ type: "extension_ui_response", id, ...response }) + "\n"
    );
    return true;
  }

  get running(): boolean {
    return !this.closed;
  }
}
