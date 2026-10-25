/**
 * `subagent`: hand a task to a second agent, and let the person watch it and
 * talk to it from the portal. The pi half of the subagent extension: its server
 * half (server.ts) registers it in every chat's pi but a child chat's
 * (`portal.chats.extend`), and hands it the settings it keeps (settings.ts).
 *
 * The subagent works in a child chat of the chat that calls it
 * (`portal.chats.create`): a chat of the portal's like any other, in the same
 * folder, under the guard and the sandbox as the person the chat works for,
 * with the chat's mode and tools and a transcript of its own. Its id is the
 * chat's, and every result names it.
 *
 * The reference for the subagent protocol (`subagent:v1:*`, typed in
 * @pithagoras/extension-api/server). Its start names the child chat (`chat`),
 * whose own transcript is the subagent's run: the portal draws it from there,
 * so nothing of it goes on the bus. What the person types for it arrives as
 * `subagent:v1:input`, and is sent into its run after the step it is on.
 *
 * Two ways to run, set by the mode in its settings:
 *
 * - "interrupt" (the default): the tool call waits for the child's answer, so
 *   the parent does nothing meanwhile. With one subagent at a time, only one
 *   agent works at once, which is what a single GPU wants.
 * - "background": the tool call returns at once and the parent goes on; the
 *   child's answer arrives later as a message, and starts a turn if the parent
 *   is idle. Two agents run at the same time.
 *
 * What a subagent says after it read outside content (`ChildRun.marked`) goes to its chat in the form of a flagged
 * result (flagged.ts), as the tool's result and as the background message alike: the portal has marked the chat, and the
 * form in its history keeps the mark when the guard is made again.
 *
 * Kept or not, as the settings say ("Keep subagent chats", off by default): a
 * kept child is a sub-chat listed under its chat, and the agent gives it a
 * further task by its id once it has finished; one that is not kept is found by
 * its id alone and is not continued, though its transcript stays to be read
 * beside the chat. Either goes when its chat is deleted.
 *
 * The model a child runs on: the one its parent is on now, unless the chat
 * says otherwise (its model menu, kept by the server half: per-chat.ts) or the
 * settings name one ("provider/model"; "auto" is the parent's). The model
 * already loaded is the one to use: a second one is a second model in memory.
 *
 * The limit (default 1) is how many children run at once, across every
 * conversation in the process — the portal runs them all in one. One asked
 * for beyond it waits for a free slot: in interrupt mode its tool call waits,
 * in the background it starts once one of the others has finished. The tool's
 * description names the mode and the limit, and its results say how many are
 * running and how long a call waited: nothing is added to the system prompt,
 * so its cache holds.
 */
import type { Chat, SubagentProtocol } from "@pithagoras/extension-api/server";
import { flagged } from "./flagged";
import { startRunner, type ChildChats, type Hear, type Runner, type Status } from "./runner";
import { MAX_PARALLEL, type Mode, type Settings } from "./settings";

export { MAX_PARALLEL, type Mode };

// The protocol's channels, as @pithagoras/extension-api/server types them: names as text, as the portal has them too.
const START = "subagent:v1:start" satisfies keyof SubagentProtocol;
const END = "subagent:v1:end" satisfies keyof SubagentProtocol;
const INPUT = "subagent:v1:input" satisfies keyof SubagentProtocol;
const STOP = "subagent:v1:stop" satisfies keyof SubagentProtocol;

/** "provider/model" as a model to hand the child, or undefined for pi's own default. */
export function parseModel(choice: unknown): { provider: string; id: string } | undefined {
  if (typeof choice !== "string") return undefined;
  const at = choice.indexOf("/");
  return at > 0 && at < choice.length - 1 ? { provider: choice.slice(0, at), id: choice.slice(at + 1) } : undefined;
}

/**
 * The model a child runs on: the chat's choice, else the settings' (`given`),
 * else — "auto" — the one the parent is on now.
 */
export function childModel(chat: string | undefined, parent: { provider?: string; id?: string } | undefined, given = "auto"): { provider: string; id: string } | undefined {
  const choice = chat ?? given;
  if (choice !== "auto") return parseModel(choice);
  return parent?.provider && parent.id ? { provider: parent.provider, id: parent.id } : undefined;
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
async function takeSlot(limit: () => number, givenUp: () => boolean, onGiveUp: (wake: () => void) => (() => void) | void): Promise<(() => void) | undefined> {
  let waiting: (() => void) | undefined;
  const cancel = () => waiting?.();
  const unlisten = onGiveUp(cancel);
  try {
    while (slots.running >= limit()) {
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

/**
 * The child chats busy with a task here: made or continued, and not over yet. Shared as the slots are, for every chat
 * in the process: one that is busy is not given a second task by a chat's pi loaded again meanwhile.
 */
const busy: Set<string> = ((globalThis as any)[Symbol.for("pithagoras-subagent:busy")] ??= new Set<string>());

/**
 * What the tool tells the model: the mode it runs in and how many run at
 * once, so it does not ask for more than will start, and, where the chats are
 * kept, that one can be given more.
 */
export function describe(mode: Mode, limit: number, keep = false): string {
  const room = limit === 1 ? "One runs at a time: further calls wait for it to finish." : `At most ${limit} run at once; further calls wait for a free one.`;
  const again = keep ? " Pass id to continue a finished one, with its context." : "";
  return mode === "background"
    ? `Hand a self-contained task to a separate agent with its own context. It runs in the background: this call returns at once and its final answer arrives later as a message. For research that would fill this chat. The person can watch and steer it. ${room}${again}`
    : `Hand a self-contained task to a separate agent with its own context and get its final answer back. For research that would fill this chat. The person can watch and steer it. ${room}${again}`;
}

/** A wait as a person says it: "under a second", "12 s", "3 min 5 s". */
export function waited(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** What the server half gives the tool of a chat's pi. */
export interface Given {
  /** The chat whose pi it is: the parent of the chats its subagents work in. */
  chat: Pick<Chat, "id">;
  /** The portal's child chats (`portal.chats`). */
  chats: ChildChats;
  /** What the extension keeps now (settings.ts), asked as a subagent starts. */
  settings: () => Settings;
  /** What this chat says its subagents run on, when it says (per-chat.ts), asked as a subagent starts. */
  chatModel?: () => string | undefined;
  /** What a child chat's pi says, for the card of the call that waits on it. */
  hear?: Hear;
}

/** How a result names the subagent: by its id, and, where its chat is kept, how to give it more. */
const named = (id: string, kept: boolean) => (kept ? `Its chat is kept as ${id}: pass that id to continue it.` : `Subagent ${id}.`);

/**
 * Registers the `subagent` tool in a chat's pi. A change to the settings needs
 * no reload for the model and the limit, which are asked as each starts.
 */
export default function subagentTool(pi: any, given: Given) {
  const { chat, chats, settings } = given;
  const chatModel = given.chatModel ?? (() => undefined);
  // Read once, as it is loaded: what the tool tells the model and what it
  // does must agree. A change reaches a chat when it is reloaded. The limit
  // is also read live where it is enforced, so a change never lets more run
  // than the settings say.
  const { mode, maxParallel: limit, keep } = settings();
  const liveLimit = () => settings().maxParallel;
  /** Says something on the chat's bus, as the protocol has it. */
  const say = <C extends keyof SubagentProtocol>(channel: C, data: SubagentProtocol[C]) => pi.events.emit(channel, data);
  // Background children still running, stopped with the session that started them.
  const detached = new Set<Runner>();
  // Set once the session is over: what still waits for a slot does not start.
  let shutDown = false;

  pi.on?.("session_shutdown", () => {
    shutDown = true;
    // Nobody is left to hear their answers: their chats stop, and their slots are every chat's.
    for (const run of detached) run.stop();
    wakeAll();
  });

  /**
   * The child chat `id` names, to be given another task: one this chat's subagent worked in, that was kept, and that
   * is not at work. Throws, saying why, for any other.
   */
  function toContinue(id: string): Chat {
    const child = chats.children(chat.id).find((c) => c.id === id);
    if (!child) throw new Error(`There is no subagent ${id} in this chat.`);
    if (child.listed === false) throw new Error(`Subagent "${child.title}" (${id}) was not kept, so it cannot be continued: start a new one with the whole task.`);
    if (busy.has(id) || child.status === "running") throw new Error(`Subagent "${child.title}" (${id}) is still working: wait for its answer before you give it more.`);
    return child;
  }

  /**
   * Gives the task to the child chat, says so on the bus, and says how it ended once it has; the slot is the
   * caller's. `progress` is the call's own card, for one that waits on it.
   */
  function run(id: string, task: string, label: string, toolCallId: string, detail: string, background: boolean, progress?: (answer: string, phase: string) => void): Runner {
    say(START, { id, label, toolCallId, input: true, stop: true, detail, chat: id, ...(background ? { detached: true } : {}) });
    const runner = startRunner(chats, id, task, given.hear, progress);
    const off = [
      pi.events.on(INPUT, (d: any) => d?.id === id && typeof d.text === "string" && runner.send(d.text)),
      pi.events.on(STOP, (d: any) => d?.id === id && runner.stop()),
    ];
    const finished = runner.finished.then((ended) => {
      off.forEach((f: () => void) => f());
      say(END, { id, status: ended.status, ...(ended.failure ? { error: ended.failure } : {}) });
      return ended;
    });
    return { ...runner, finished };
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: describe(mode, limit, keep),
    // As JSON schema: a server half is plain Node, with no typebox of pi's to write it with.
    parameters: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "The whole task with all it needs: it sees nothing of this chat" },
        label: { type: "string", description: "Short name, e.g. Research: vector DBs" },
        // Said in the description: a description of its own would cost as much again.
        ...(keep ? { id: { type: "string" } } : {}),
      },
    },
    // What it hands on goes to a chat that has not read what this one read: after a suspected prompt injection, a call
    // waits for the person, as the guard's rule for a tool of this name says too.
    guard: { acts: ["delegate"] },

    async execute(toolCallId: string, params: { task: string; label?: string; id?: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      // One to continue is looked at before anything is made or a slot is taken: one that cannot be is refused at once.
      const again = typeof params.id === "string" && params.id.trim() ? toContinue(params.id.trim()) : undefined;
      const label = params.label?.trim() || again?.title || "Subagent";
      const model = again ? undefined : childModel(chatModel(), ctx?.model, settings().model);
      const child = again ?? chats.create({ parent: chat.id, title: label, listed: keep, ...(model ? { model } : {}) });
      const id = child.id;
      const kept = again ? true : keep;
      const detail = again ? "Continuing" : model ? `Starting on ${model.provider}/${model.id}` : "Starting";
      busy.add(id);
      /** A chat made for a task that never started holds nothing: it goes, rather than be left as an empty sub-chat. */
      const unmade = () => {
        if (!again) void chats.remove(id).catch(() => undefined);
      };

      if (mode === "background") {
        // Whether it starts now or waits for one of the others: said now, since the call does not wait.
        const waiting = slots.running >= liveLimit() ? slots.running : 0;
        // One that waits is announced at once: counted as running, so its chat
        // is not reloaded from under it, and it can be stopped before it starts.
        let cancelled = false;
        const offWait = waiting
          ? pi.events.on(STOP, (d: any) => {
              if (d?.id !== id) return;
              cancelled = true;
              wakeAll();
            })
          : () => {};
        if (waiting) say(START, { id, label, toolCallId, input: false, stop: true, detail: "Waiting for a free slot", detached: true, chat: id });
        /** What the parent is told when it is over: its answer starts a turn; a stop waits for the person. */
        const tell = (status: Status, said: string, marked?: true) => {
          try {
            pi.sendMessage(
              { customType: "subagent", content: marked ? flagged(said) : said, display: true, details: { id, status } },
              status === "stopped" ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true },
            );
          } catch {
            // The session it belonged to is gone: nobody is left to tell.
          }
        };
        void (async () => {
          let release: (() => void) | undefined;
          let runner: Runner | undefined;
          try {
            release = await takeSlot(liveLimit, () => shutDown || cancelled, () => {});
            offWait();
            if (!release) {
              if (waiting) say(END, { id, status: "stopped" });
              unmade();
              if (cancelled && !shutDown) tell("stopped", `Subagent "${label}" was stopped before it started.`);
              return;
            }
            runner = run(id, params.task, label, toolCallId, detail, true);
            detached.add(runner);
            const { status, answer, failure, marked } = await runner.finished;
            tell(
              status,
              (status === "done"
                ? `Subagent "${label}" finished:\n\n${answer || "(it gave no answer)"}`
                : status === "stopped"
                  ? `Subagent "${label}" was stopped before it finished.${answer ? ` What it had so far:\n\n${answer}` : ""}`
                  : `Subagent "${label}" failed: ${failure ?? "it ended early"}${answer ? `\n\nWhat it had so far:\n\n${answer}` : ""}`) + `\n\n(${named(id, kept)})`,
              marked,
            );
          } catch (e) {
            // Whatever went wrong, the slot is given back below and the parent is told.
            const why = (e as Error)?.message ?? String(e);
            if (waiting && !runner) say(END, { id, status: "error", error: why });
            // Failed before its chat was given the task: it holds nothing, and is not left as an empty sub-chat.
            if (!runner) unmade();
            tell("error", `Subagent "${label}" failed: ${why}`);
          } finally {
            offWait();
            release?.();
            if (runner) detached.delete(runner);
            busy.delete(id);
          }
        })();
        // The takeSlot above has taken its place by now: a free slot is counted as running, a full one as waiting.
        // More can run than the limit now says when it was lowered meanwhile, and that is what is reported.
        const counts = `${slots.running} of ${liveLimit()} running${waiting ? `, ${slots.waiting.length} waiting, this one included` : ""}`;
        return {
          content: [{
            type: "text",
            text: (waiting
              ? `Queued subagent "${label}" in the background (${counts}); it starts when a slot is free. Its answer will arrive as a message when it is done; go on with other work meanwhile.`
              : `Started subagent "${label}" in the background (${counts}). Its answer will arrive as a message when it is done; go on with other work meanwhile.`) + ` ${named(id, kept)}`,
          }],
          details: { phase: waiting ? "queued" : "background", id },
        };
      }

      let release: (() => void) | undefined;
      let runner: Runner | undefined;
      try {
        // At most as many at once as allowed, even when the model asks for more
        // in one turn: each is a model running. Waits for a slot, unless the
        // parent is stopped meanwhile.
        const hadToWait = slots.running >= liveLimit();
        const queuedAt = Date.now();
        // Said through the protocol as well, so the chat lists it while it waits;
        // the start that follows merges into this one.
        if (hadToWait) {
          say(START, { id, label, toolCallId, input: false, stop: false, detail: "Waiting for a free slot", chat: id });
          onUpdate?.({ content: [{ type: "text", text: "" }], details: { phase: "waiting for another subagent to finish" } });
        }
        release = await takeSlot(
          liveLimit,
          () => signal?.aborted === true || shutDown,
          (wake) => {
            signal?.addEventListener("abort", wake, { once: true });
            return () => signal?.removeEventListener("abort", wake);
          },
        );
        if (!release) {
          if (hadToWait) say(END, { id, status: "stopped" });
          unmade();
          return { content: [{ type: "text", text: "(stopped before the subagent started)" }], details: { phase: "stopped", id } };
        }
        const startedAt = Date.now();
        runner = run(id, params.task, label, toolCallId, detail, false, (answer, phase) => onUpdate?.({ content: [{ type: "text", text: answer }], details: { phase } }));
        const running = runner;
        const stopped = () => running.stop();
        signal?.addEventListener("abort", stopped, { once: true });
        const { status, answer, failure, marked } = await runner.finished;
        signal?.removeEventListener("abort", stopped);
        if (status === "error" && !answer) {
          const failed = `The subagent failed: ${failure ?? "it ended early"} (${named(id, kept)})`;
          throw new Error(marked ? flagged(failed) : failed);
        }
        // Said at the end, so the model can tell the wait from the subagent's own work time when it judges how long the task took.
        const note = hadToWait ? `\n\n(It waited ${waited(startedAt - queuedAt)} for a free subagent slot before it started.)` : "";
        const said = `${answer || "(the subagent gave no answer)"}${note}\n\n(${named(id, kept)})`;
        return { content: [{ type: "text", text: marked ? flagged(said) : said }], details: { phase: status, id } };
      } catch (e) {
        // Failed before its chat was given the task (its start could not be said, say): no empty sub-chat is left.
        if (!runner) unmade();
        throw e;
      } finally {
        release?.();
        busy.delete(id);
      }
    },
  });
}
