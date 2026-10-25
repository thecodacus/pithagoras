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
 * result (flagged.ts), as the tool's result, the background message and what `subagents` stop says it had alike: the
 * portal has marked the chat, and the form in its history keeps the mark when the guard is made again.
 *
 * Kept or not, as the settings say ("Keep subagent chats", off by default): a
 * kept child is a sub-chat listed under its chat, and the agent gives it a
 * further task by its id once it has finished; one that is not kept is found by
 * its id alone and is not continued, though its transcript stays to be read
 * beside the chat. Either goes when its chat is deleted.
 *
 * Where the agent can do anything while a subagent works (in the background,
 * or with kept chats), it can also talk to its subagents: `subagent` with the
 * id of one at work sends it a message, as the person's would be, and a second
 * tool, `subagents`, lists them and stops one, or takes one off the queue.
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
  const again = keep
    ? ` Pass id to continue a finished one, with its context${mode === "background" ? ", or to message a running one" : ""}.`
    : mode === "background"
      ? " Pass id to message a running one."
      : "";
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

/** How many ended subagents `subagents` lists, the latest ones: those at work are all listed. */
export const LISTED_ENDED = 20;

/**
 * How long a message from the agent waits to be refused before it is said to be sent: a refusal comes at once, and one
 * that is taken in is not heard of again before the run it went into ends.
 */
export const REFUSAL_WAIT_MS = 1_000;

/**
 * One task given to a subagent of this chat, from the call that gives it to its end: waiting for a slot ("queued"),
 * at work ("running"), or how it ended. Once it has ended it stays so: a kept one given more is a new task.
 */
interface Task {
  id: string;
  label: string;
  kept: boolean;
  background: boolean;
  state: "queued" | "running" | Status;
  /** When it was asked for, when it started and when it ended. */
  at: number;
  started?: number;
  ended?: number;
  /** Its run, from its start until it has ended. */
  runner?: Runner;
  /** Said by the agent while it waited: given with its task as it starts. */
  more: string[];
  /** Taken off the queue before it started. */
  cancelled: boolean;
  /** Stopped by the agent, which was told what it had then: its end is not said again. */
  stoppedByAgent: boolean;
}

/**
 * Registers the `subagent` tool in a chat's pi, and, where the agent can do anything while a subagent works,
 * `subagents` beside it. A change to the settings needs no reload for the model and the limit, which are asked as
 * each starts.
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
  // The tasks this chat's pi gave its subagents, by the child chat's id, in the order they were given: what
  // `subagents` lists and stops, and what a message by id reaches.
  const tasks = new Map<string, Task>();
  // Set once the session is over: what still waits for a slot does not start.
  let shutDown = false;
  // In interrupt mode the agent waits for each subagent, so there is nothing to talk to while one works; kept chats
  // are still there to be listed.
  const talks = mode === "background" || keep;

  pi.on?.("session_shutdown", () => {
    shutDown = true;
    // Nobody is left to hear the background ones' answers: their chats stop, and their slots are every chat's.
    for (const task of tasks.values()) if (task.background && task.state === "running") task.runner?.stop();
    wakeAll();
  });

  /** Stops it at work, or takes it off the queue; nothing for one that has ended. */
  function stop(task: Task): void {
    if (task.state === "running") task.runner?.stop();
    else if (task.state === "queued") {
      task.cancelled = true;
      wakeAll();
    }
  }

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
   * Whether the child chat `id` is at work on something this chat's pi did not give it: the person working with a kept
   * one in its own chat, or the chat's pi loaded before winding one down. Neither is this pi's to list as ended or to stop.
   */
  function atWorkElsewhere(id: string): boolean {
    const task = tasks.get(id);
    if (task && (task.state === "queued" || task.state === "running")) return false;
    return (!task && busy.has(id)) || chats.get(id)?.status === "running";
  }

  /**
   * A message from the agent for one of its subagents at work: into its run after the step it is on, or with its task.
   * One the portal refuses (the chat is going, the run has just ended) throws, saying why, so the agent does not wait for
   * a reaction that will not come.
   */
  async function message(task: Task, text: string) {
    if (task.state === "queued") {
      task.more.push(text);
      return {
        content: [{ type: "text", text: `Subagent "${task.label}" (${task.id}) has not started yet: it gets this with its task.` }],
        details: { phase: "queued", id: task.id },
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refused = await Promise.race([
      task.runner ? task.runner.send(text) : Promise.resolve("it has ended"),
      new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), REFUSAL_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (refused) throw new Error(`Subagent "${task.label}" (${task.id}) did not get the message: ${refused}`);
    return {
      content: [{ type: "text", text: `Sent to subagent "${task.label}" (${task.id}), which reads it after the step it is on. Its answer comes as before.` }],
      details: { phase: "sent", id: task.id },
    };
  }

  /**
   * Gives the task to the child chat, says so on the bus, and says how it ended once it has; the slot is the
   * caller's. `progress` is the call's own card, for one that waits on it.
   */
  function run(task: Task, text: string, toolCallId: string, detail: string, progress?: (answer: string, phase: string) => void): Runner {
    const { id, label } = task;
    say(START, { id, label, toolCallId, input: true, stop: true, detail, chat: id, ...(task.background ? { detached: true } : {}) });
    const runner = startRunner(chats, id, [text, ...task.more.splice(0)].join("\n\n"), given.hear, progress);
    task.runner = runner;
    task.state = "running";
    task.started = Date.now();
    const off = [
      pi.events.on(INPUT, (d: any) => d?.id === id && typeof d.text === "string" && runner.send(d.text)),
      pi.events.on(STOP, (d: any) => d?.id === id && runner.stop()),
    ];
    const finished = runner.finished.then((ended) => {
      off.forEach((f: () => void) => f());
      task.state = ended.status;
      task.ended = Date.now();
      // What it said is with whoever waits on its end: an ended task holds on to nothing more than its line in the list.
      task.runner = undefined;
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
        ...(talks ? { id: { type: "string" } } : {}),
      },
    },
    // What it hands on goes to a chat that has not read what this one read: after a suspected prompt injection, a call
    // waits for the person, as the guard's rule for a tool of this name says too. A message to one at work as well.
    guard: { acts: ["delegate"] },

    async execute(toolCallId: string, params: { task: string; label?: string; id?: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const asked = typeof params.id === "string" ? params.id.trim() : "";
      // One of this chat's at work, or waiting to be: the task is a message for it.
      const atWork = asked ? tasks.get(asked) : undefined;
      if (atWork && (atWork.state === "queued" || atWork.state === "running")) return message(atWork, params.task);
      // One to continue is looked at before anything is made or a slot is taken: one that cannot be is refused at once.
      const again = asked ? toContinue(asked) : undefined;
      const label = params.label?.trim() || again?.title || "Subagent";
      const model = again ? undefined : childModel(chatModel(), ctx?.model, settings().model);
      const child = again ?? chats.create({ parent: chat.id, title: label, listed: keep, ...(model ? { model } : {}) });
      const id = child.id;
      const kept = again ? true : keep;
      const detail = again ? "Continuing" : model ? `Starting on ${model.provider}/${model.id}` : "Starting";
      busy.add(id);
      const background = mode === "background";
      const task: Task = { id, label, kept, background, state: "queued", at: Date.now(), more: [], cancelled: false, stoppedByAgent: false };
      // A kept one given more goes to the end of the list, as the latest.
      tasks.delete(id);
      tasks.set(id, task);
      /** A chat made for a task that never started holds nothing: it goes, rather than be left as an empty sub-chat. */
      const unmade = () => {
        if (!again) void chats.remove(id).catch(() => undefined);
      };
      /** Over before it started: stopped, or failed with `failure`. */
      const neverStarted = (failure?: string) => {
        task.state = failure === undefined ? "stopped" : "error";
        // Its chat goes (unmade): nothing is left to continue.
        if (!again) task.kept = false;
        task.ended = Date.now();
      };

      if (background) {
        // Whether it starts now or waits for one of the others: said now, since the call does not wait.
        const waiting = slots.running >= liveLimit() ? slots.running : 0;
        // One that waits is announced at once: counted as running, so its chat
        // is not reloaded from under it, and it can be stopped before it starts.
        const offWait = waiting ? pi.events.on(STOP, (d: any) => d?.id === id && stop(task)) : () => {};
        if (waiting) say(START, { id, label, toolCallId, input: false, stop: true, detail: "Waiting for a free slot", detached: true, chat: id });
        /**
         * What the parent is told when it is over: its answer starts a turn; a stop waits for the person. One the agent
         * stopped itself is not told again: its stop said what it had.
         */
        const tell = (status: Status, said: string, marked?: true) => {
          if (status === "stopped" && task.stoppedByAgent) return;
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
            release = await takeSlot(liveLimit, () => shutDown || task.cancelled, () => {});
            offWait();
            if (!release) {
              neverStarted();
              if (waiting) say(END, { id, status: "stopped" });
              unmade();
              if (task.cancelled && !shutDown) tell("stopped", `Subagent "${label}" was stopped before it started.`);
              return;
            }
            runner = run(task, params.task, toolCallId, detail);
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
            if (!runner) {
              neverStarted(why);
              if (waiting) say(END, { id, status: "error", error: why });
              // Failed before its chat was given the task: it holds nothing, and is not left as an empty sub-chat.
              unmade();
            }
            tell("error", `Subagent "${label}" failed: ${why}`);
          } finally {
            offWait();
            release?.();
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
          () => signal?.aborted === true || shutDown || task.cancelled,
          (wake) => {
            signal?.addEventListener("abort", wake, { once: true });
            return () => signal?.removeEventListener("abort", wake);
          },
        );
        if (!release) {
          neverStarted();
          if (hadToWait) say(END, { id, status: "stopped" });
          unmade();
          return { content: [{ type: "text", text: "(stopped before the subagent started)" }], details: { phase: "stopped", id } };
        }
        const startedAt = Date.now();
        runner = run(task, params.task, toolCallId, detail, (answer, phase) => onUpdate?.({ content: [{ type: "text", text: answer }], details: { phase } }));
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
        if (!runner) {
          neverStarted((e as Error)?.message ?? String(e));
          unmade();
        }
        throw e;
      } finally {
        release?.();
        busy.delete(id);
      }
    },
  });

  if (!talks) return;

  /**
   * One line of the list: what it is, where it is and for how long. Nothing of what one at work has said: it may have
   * read outside content, and the portal marks this chat with that only as its run ends, before its words come back.
   */
  const line = (task: Task, now: number) => {
    const head = `- ${task.id} "${task.label}"`;
    if (task.state === "queued") return `${head}: waiting for a free slot for ${waited(now - task.at)}`;
    if (task.state === "running") return `${head}: running for ${waited(now - (task.started ?? task.at))}`;
    const how = task.state === "done" ? "finished" : task.state === "stopped" ? "stopped" : "failed";
    const when = task.started ? `after ${waited((task.ended ?? now) - task.started)}` : "before it started";
    return `${head}: ${how} ${when}${task.kept ? ", kept" : ""}`;
  };

  /** One at work on something this pi did not give it (atWorkElsewhere). */
  const elsewhere = (id: string, title: string) => `- ${id} "${title}": at work in its own chat, not on a task from you`;

  /** This chat's subagents: those it gave a task since it was loaded, then the kept chats of earlier ones. */
  function list(): string {
    const now = Date.now();
    const all = [...tasks.values()];
    const atWork = all.filter((t) => t.state === "queued" || t.state === "running");
    const kids = chats.children(chat.id);
    const busyElsewhere = kids.filter((c) => (c.listed !== false || tasks.has(c.id)) && atWorkElsewhere(c.id));
    const ended = all.filter((t) => !atWork.includes(t) && !busyElsewhere.some((c) => c.id === t.id));
    const earlier = kids.filter((c) => c.listed !== false && !tasks.has(c.id) && !busyElsewhere.includes(c));
    const left = ended.length + earlier.length - LISTED_ENDED;
    const lines = [
      ...atWork.map((t) => line(t, now)),
      ...busyElsewhere.map((c) => elsewhere(c.id, tasks.get(c.id)?.label ?? c.title)),
      // The latest of those that have ended: kept ones from before this chat was loaded are the oldest.
      ...[
        ...earlier.map((c) => `- ${c.id} "${c.title}": kept${c.status === "interrupted" ? ", cut off by a restart" : ""}`),
        ...ended.map((t) => line(t, now)),
      ].slice(Math.max(0, left)),
    ];
    if (!lines.length) return "This chat has no subagents.";
    return (left > 0 ? `(${left} earlier ones that have ended are left out.)\n` : "") + lines.join("\n");
  }

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: "List this chat's subagents (id, status, time), or stop one by id.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: { action: { type: "string", enum: ["list", "stop"] }, id: { type: "string" } },
    },
    // No guard of its own: it reads what this chat's subagents did, and stops them. What it sends one goes through
    // `subagent`, which the guard holds as a delegation.

    async execute(_toolCallId: string, params: { action: "list" | "stop"; id?: string }) {
      if (params.action !== "stop") return { content: [{ type: "text", text: list() }], details: { action: "list" } };
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) throw new Error("Name the subagent to stop by its id.");
      const task = tasks.get(id);
      const child = chats.children(chat.id).find((c) => c.id === id);
      if (!task && !child) throw new Error(`There is no subagent ${id} in this chat.`);
      const label = task?.label ?? child!.title;
      // Not one this pi set going: the person may be working with it in its chat, which is theirs to stop.
      if (atWorkElsewhere(id)) throw new Error(`Subagent "${label}" (${id}) is at work in its own chat, not on a task from you: it is not stopped from here.`);
      if (!task || (task.state !== "queued" && task.state !== "running")) throw new Error(`Subagent "${label}" (${id}) has ended already: there is nothing to stop.`);
      if (task.state === "queued") {
        task.stoppedByAgent = true;
        stop(task);
        return { content: [{ type: "text", text: `Took subagent "${label}" (${id}) off the queue before it started.` }], details: { action: "stop", id } };
      }
      const ending = task.runner!.finished;
      task.stoppedByAgent = true;
      stop(task);
      // What it had comes back once its run is over: a subagent that read outside content has marked this chat by then
      // (the portal does as the run ends), so its words are held as what they are, and are handed on as a flagged result
      // so that the mark is found again when the guard is made again, as with its answer.
      const { status, answer, marked } = await ending;
      if (status !== "stopped") {
        return { content: [{ type: "text", text: `Subagent "${label}" (${id}) ended before it could be stopped: its answer comes as it would have.` }], details: { action: "stop", id } };
      }
      const said = `Stopped subagent "${label}" (${id}).${answer ? ` What it had so far:\n\n${answer}` : " It had said nothing yet."}`;
      return { content: [{ type: "text", text: marked ? flagged(said) : said }], details: { action: "stop", id } };
    },
  });
}
