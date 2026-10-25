/**
 * `subagent`: hand a task to a second pi, and let the person watch it and
 * talk to it from the portal.
 *
 * The reference for the subagent protocol (core/server/src/subagent-protocol.ts in
 * the portal). The child runs `pi --mode rpc`, so it can be steered while it
 * works: what the person types for it arrives as an RPC `steer`. Every event
 * the child prints is passed on unchanged, and the portal draws it like the
 * main conversation. Outside the portal nobody listens on those channels and
 * the tool is simply a subagent.
 *
 * Two ways to run, set by `subagentMode` in pi's settings.json:
 *
 * - "interrupt" (the default): the tool call waits for the child's answer, so
 *   the parent does nothing meanwhile. With one subagent at a time, only one
 *   agent works at once, which is what a single GPU wants.
 * - "background": the tool call returns at once and the parent goes on; the
 *   child's answer arrives later as a message, and starts a turn if the parent
 *   is idle. Two agents run at the same time.
 *
 * The model a child runs on: the one its parent is on now, unless the chat
 * says otherwise (the portal answers `subagent:v1:config` with the chat's
 * choice) or `subagentModel` in pi's settings names one ("provider/model";
 * "auto" or absent is the parent's). The model already loaded is the one to
 * use: a second one is a second model in memory.
 *
 * `subagentMaxParallel` (default 1) is how many children run at once, across
 * every conversation in the process — the portal runs them all in one. One
 * asked for beyond it waits for a free slot: in interrupt mode its tool call
 * waits, in the background it starts once one of the others has finished.
 * The tool's description names the mode and the limit, and its results say
 * how many are running and how long a call waited: nothing is added to the
 * system prompt, so its cache holds.
 *
 * PI_SUBAGENT_BIN picks the pi to run (default: `pi` on PATH).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";

const START = "subagent:v1:start";
const EVENT = "subagent:v1:event";
const END = "subagent:v1:end";
const INPUT = "subagent:v1:input";
const STOP = "subagent:v1:stop";
/** Asked by the extension, answered at once by whoever runs it: `{ reply({ model? }) }`. */
const CONFIG = "subagent:v1:config";

export type Mode = "interrupt" | "background";

/** pi's settings, read each time so a change needs no restart. */
function settings(): Record<string, unknown> {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** How a subagent runs against its parent. */
export const subagentMode = (): Mode => (settings().subagentMode === "background" ? "background" : "interrupt");

/** "provider/model" as a model to hand the child, or undefined for pi's own default. */
export function parseModel(choice: unknown): { provider: string; id: string } | undefined {
  if (typeof choice !== "string") return undefined;
  const at = choice.indexOf("/");
  return at > 0 && at < choice.length - 1 ? { provider: choice.slice(0, at), id: choice.slice(at + 1) } : undefined;
}

/**
 * The model a child runs on: the chat's choice, else the settings', else —
 * "auto" — the one the parent is on now.
 */
export function childModel(chat: string | undefined, parent: { provider?: string; id?: string } | undefined): { provider: string; id: string } | undefined {
  const choice = chat ?? (typeof settings().subagentModel === "string" ? (settings().subagentModel as string) : "auto");
  if (choice !== "auto") return parseModel(choice);
  return parent?.provider && parent.id ? { provider: parent.provider, id: parent.id } : undefined;
}

export const MAX_PARALLEL = 16;

/** How many subagents may run at once: 1 unless the settings say more. */
export function subagentLimit(): number {
  const n = Number(settings().subagentMaxParallel);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PARALLEL) : 1;
}

/**
 * The slots, shared by every copy of this extension in the process: pi loads
 * it once per conversation, and the limit is on how many models run, not on
 * how many run in one chat.
 */
const slots: { running: number; waiting: (() => void)[] } = ((globalThis as any)[Symbol.for("pithagoras-subagent:slots")] ??= {
  running: 0,
  waiting: [],
});

/**
 * A slot, once one is free; its release hands it on. Undefined when `given
 * up` said so first — the parent stopped, the session ended. `onGiveUp` is
 * given, once, what wakes it to look again, and may hand back how to stop
 * listening: the wait leaves nothing behind in the shared list or on the signal.
 */
async function takeSlot(givenUp: () => boolean, onGiveUp: (wake: () => void) => (() => void) | void): Promise<(() => void) | undefined> {
  let waiting: (() => void) | undefined;
  const cancel = () => waiting?.();
  const unlisten = onGiveUp(cancel);
  try {
    while (slots.running >= subagentLimit()) {
      if (givenUp()) return undefined;
      await new Promise<void>((wake) => {
        waiting = wake;
        slots.waiting.push(wake);
      });
      // Woken by a release, the list was emptied; by giving up, this one is still in it.
      const at = waiting ? slots.waiting.indexOf(waiting) : -1;
      if (at >= 0) slots.waiting.splice(at, 1);
      waiting = undefined;
    }
    if (givenUp()) return undefined;
  } finally {
    unlisten?.();
  }
  slots.running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.running--;
    // All of them look again, in the order they came: the limit may have
    // been raised meanwhile, and one woken for nothing waits again.
    slots.waiting.splice(0).forEach((wake) => wake());
  };
}

/** Everyone waiting looks again: one of them has given up. */
const wakeAll = () => slots.waiting.splice(0).forEach((wake) => wake());

type Status = "done" | "error" | "stopped";
interface Run {
  id: string;
  /** Settles once the child has, with what it said last. */
  finished: Promise<{ status: Status; answer: string; failure?: string }>;
  stop(): void;
  /** Stopped, and killed if it has not ended a little later: for when nobody is left to wait on it. */
  end(): void;
}

/** How long a child told to stop is given before it is killed. */
const GRACE_MS = () => Number(process.env.PI_SUBAGENT_GRACE_MS) || 5000;

/**
 * What the tool tells the model: the mode it runs in and how many run at
 * once, so it does not ask for more than will start.
 */
export function describe(mode: Mode, limit: number): string {
  const room = limit === 1 ? "One runs at a time: further calls wait for it to finish." : `At most ${limit} run at once; further calls wait for a free one.`;
  return mode === "background"
    ? `Hand a self-contained task to a separate agent with its own context. It runs in the background: this call returns at once and its final answer arrives later as a message. For research that would fill this chat. The person can watch and steer it. ${room}`
    : `Hand a self-contained task to a separate agent with its own context and get its final answer back. For research that would fill this chat. The person can watch and steer it. ${room}`;
}

/** A wait as a person says it: "under a second", "12 s", "3 min 5 s". */
export function waited(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/**
 * Set for the pi a subagent runs in. It gets no subagent tool of its own: its
 * children would have slots of their own, in their own process, and the
 * limit on models running at once would not reach them.
 */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";

export default function (pi: any) {
  if (process.env[CHILD_ENV] === "1") return;
  // Read once, as it is loaded: what the tool tells the model and what it
  // does must agree. A change reaches a chat when it is reloaded. The limit
  // is also read live where it is enforced, so a change never lets more run
  // than the settings say.
  const mode = subagentMode();
  const limit = subagentLimit();
  // Background children still running, stopped with the session that started them.
  const detached = new Set<Run>();
  // Set once the session is over: what still waits for a slot does not start.
  let shutDown = false;

  pi.on?.("session_shutdown", () => {
    shutDown = true;
    // Ended for sure: a child that does not stop keeps its slot, which is every chat's.
    for (const run of detached) run.end();
    wakeAll();
  });

  /** What the chat says its subagents run on, when something answers for it. */
  function chatChoice(): string | undefined {
    let said: string | undefined;
    pi.events.emit(CONFIG, { reply: (config: any) => typeof config?.model === "string" && (said = config.model) });
    return said;
  }

  /**
   * Starts a child for the task and hands over what watching it needs.
   * `announced`: the id it was announced under while it waited for a slot.
   */
  function start(task: string, label: string, toolCallId: string, ctx: any, background: boolean, onUpdate?: any, announced?: string): Run {
    const id = announced ?? randomUUID();
    const model = childModel(chatChoice(), ctx?.model);
    // Its stderr goes nowhere: a pipe nobody reads fills, and the child
    // blocks on its next warning for good.
    const child = spawn(process.env.PI_SUBAGENT_BIN || "pi", ["--mode", "rpc", "--no-session", ...(model ? ["--provider", model.provider, "--model", model.id] : [])], {
      cwd: ctx.cwd,
      env: { ...process.env, [CHILD_ENV]: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    // A child that died, or never started, closes the pipe under the next
    // write. Unheard, that error takes down whatever runs this extension —
    // the portal, for everyone. As pi's own bash tool does: heard, and let go.
    child.stdin.on("error", () => {});
    const send = (command: Record<string, unknown>) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(command) + "\n");
    };
    // Why it failed, when the child said.
    let failure: string | undefined;
    let answer = "";
    let steps = 0;
    // Stopped by the person in the portal, or by the parent's own stop: either
    // way what it has is not its whole answer.
    let stopped = false;
    const stop = () => {
      stopped = true;
      send({ type: "abort" });
    };
    const off = [
      pi.events.on(INPUT, (d: any) => d?.id === id && typeof d.text === "string" && send({ type: "steer", message: d.text })),
      pi.events.on(STOP, (d: any) => d?.id === id && stop()),
    ];
    pi.events.emit(START, {
      id,
      label,
      toolCallId,
      input: true,
      stop: true,
      detail: model ? `Starting on ${model.provider}/${model.id}` : "Starting",
      ...(background ? { detached: true } : {}),
    });

    const status = new Promise<Status>((resolve) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        // The task refused — no model, no key: no run follows, so nothing
        // would ever settle it, and the child would wait on its input for good.
        if (event.type === "response") {
          if (event.command === "prompt" && event.success === false) {
            failure = String(event.error ?? "The subagent refused the task");
            resolve("error");
          }
          return;
        }
        pi.events.emit(EVENT, { id, event });
        if (event.type === "tool_execution_start") {
          steps++;
          onUpdate?.({ content: [{ type: "text", text: answer }], details: { phase: `${event.toolName} (${steps} steps)` } });
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = (event.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          if (text) answer = text;
          onUpdate?.({ content: [{ type: "text", text: answer }], details: { phase: "thinking" } });
        }
        // Settled, not ended: pi ends a run and then retries it, or compacts
        // and goes on, and only settles once it has nothing left to do.
        if (event.type === "agent_settled") resolve(stopped ? "stopped" : "done");
      });
      child.on("exit", (code) => resolve(stopped ? "stopped" : code === 0 ? "done" : "error"));
      child.on("error", () => resolve("error"));
      send({ type: "prompt", message: task });
    });

    const finished = status.then((status) => {
      child.kill();
      off.forEach((f: () => void) => f());
      pi.events.emit(END, { id, status, ...(failure ? { error: failure } : {}) });
      return { status, answer, ...(failure ? { failure } : {}) };
    });
    const end = () => {
      stop();
      const kill = setTimeout(() => child.kill("SIGKILL"), GRACE_MS());
      kill.unref?.();
      void finished.finally(() => clearTimeout(kill));
    };
    return { id, finished, stop, end };
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: describe(mode, limit),
    parameters: Type.Object({
      task: Type.String({ description: "The whole task with all it needs: it sees nothing of this chat" }),
      label: Type.Optional(Type.String({ description: "Short name, e.g. Research: vector DBs" })),
    }),

    async execute(toolCallId: string, params: { task: string; label?: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const label = params.label?.trim() || "Subagent";

      if (mode === "background") {
        // Whether it starts now or waits for one of the others: said now, since the call does not wait.
        const waiting = slots.running >= subagentLimit() ? slots.running : 0;
        // One that waits is announced at once: counted as running, so its chat
        // is not reloaded from under it, and it can be stopped before it starts.
        const id = randomUUID();
        let cancelled = false;
        const offWait = waiting
          ? pi.events.on(STOP, (d: any) => {
              if (d?.id !== id) return;
              cancelled = true;
              wakeAll();
            })
          : () => {};
        if (waiting) pi.events.emit(START, { id, label, toolCallId, input: true, stop: true, detail: "Waiting for a free slot", detached: true });
        /** What the parent is told when it is over: its answer starts a turn; a stop waits for the person. */
        const tell = (status: Status, said: string) => {
          try {
            pi.sendMessage(
              { customType: "subagent", content: said, display: true, details: { id, status } },
              status === "stopped" ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true },
            );
          } catch {
            // The session it belonged to is gone: nobody is left to tell.
          }
        };
        void (async () => {
          let release: (() => void) | undefined;
          let run: Run | undefined;
          try {
            release = await takeSlot(() => shutDown || cancelled, () => {});
            offWait();
            if (!release) {
              if (waiting) pi.events.emit(END, { id, status: "stopped" });
              if (cancelled && !shutDown) tell("stopped", `Subagent "${label}" was stopped before it started.`);
              return;
            }
            run = start(params.task, label, toolCallId, ctx, true, undefined, id);
            detached.add(run);
            const { status, answer, failure } = await run.finished;
            tell(
              status,
              status === "done"
                ? `Subagent "${label}" finished:\n\n${answer || "(it gave no answer)"}`
                : status === "stopped"
                  ? `Subagent "${label}" was stopped before it finished.${answer ? ` What it had so far:\n\n${answer}` : ""}`
                  : `Subagent "${label}" failed: ${failure ?? (answer ? "it ended early" : "it could not run — is `pi` on PATH? (PI_SUBAGENT_BIN)")}${answer ? `\n\nWhat it had so far:\n\n${answer}` : ""}`,
            );
          } catch (e) {
            // Whatever went wrong, the slot is given back below and the parent is told.
            const why = (e as Error)?.message ?? String(e);
            if (waiting && !run) pi.events.emit(END, { id, status: "error", error: why });
            tell("error", `Subagent "${label}" failed: ${why}`);
          } finally {
            offWait();
            release?.();
            if (run) detached.delete(run);
          }
        })();
        // The takeSlot above has taken its place by now: a free slot is counted as running, a full one as waiting.
        // More can run than the limit now says when it was lowered meanwhile, and that is what is reported.
        const counts = `${slots.running} of ${subagentLimit()} running${waiting ? `, ${slots.waiting.length} waiting, this one included` : ""}`;
        return {
          content: [{
            type: "text",
            text: waiting
              ? `Queued subagent "${label}" in the background (${counts}); it starts when a slot is free. Its answer will arrive as a message when it is done; go on with other work meanwhile.`
              : `Started subagent "${label}" in the background (${counts}). Its answer will arrive as a message when it is done; go on with other work meanwhile.`,
          }],
          details: { phase: waiting ? "queued" : "background" },
        };
      }

      // At most as many at once as allowed, even when the model asks for more
      // in one turn: each is a model running. Waits for a slot, unless the
      // parent is stopped meanwhile.
      const hadToWait = slots.running >= subagentLimit();
      const queuedAt = Date.now();
      if (hadToWait) onUpdate?.({ content: [{ type: "text", text: "" }], details: { phase: "waiting for another subagent to finish" } });
      const release = await takeSlot(
        () => signal?.aborted === true || shutDown,
        (wake) => {
          signal?.addEventListener("abort", wake, { once: true });
          return () => signal?.removeEventListener("abort", wake);
        },
      );
      if (!release) return { content: [{ type: "text", text: "(stopped before the subagent started)" }], details: { phase: "stopped" } };
      try {
        const startedAt = Date.now();
        const run = start(params.task, label, toolCallId, ctx, false, onUpdate);
        const stopped = () => run.stop();
        signal?.addEventListener("abort", stopped, { once: true });
        const { status, answer, failure } = await run.finished;
        signal?.removeEventListener("abort", stopped);
        if (failure) throw new Error(`The subagent could not start: ${failure}`);
        if (status === "error" && !answer) throw new Error("The subagent could not run — is `pi` on PATH? (PI_SUBAGENT_BIN)");
        // Said at the end, so the model can tell the wait from the subagent's own work time when it judges how long the task took.
        const note = hadToWait ? `\n\n(It waited ${waited(startedAt - queuedAt)} for a free subagent slot before it started.)` : "";
        return { content: [{ type: "text", text: (answer || "(the subagent gave no answer)") + note }], details: { phase: status } };
      } finally {
        release();
      }
    },
  });
}
