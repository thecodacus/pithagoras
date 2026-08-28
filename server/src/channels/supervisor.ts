import {
  addGrant,
  addNote,
  addToolRule,
  findChannelSession,
  getDb,
  getDefaultReportTo,
  listToolRules,
  takeDeliveries,
  takeNotes,
} from "../db.js";
import { resolveChannelSession, scopeKey } from "../agent.js";
import { sessions, EXECUTOR_KIND, stripThinkingMarkers } from "../session-manager.js";
import { readAnswer, recordAnswer, type QuestionRow } from "../questions.js";
import { nanoid } from "nanoid";
import {
  getPerson,
  hasPrimary,
  lower,
  markAnnounced,
  personKey,
  primaryName,
  seen,
  senderFraming,
  type PersonRow,
} from "../people.js";
import { loadChannels, type LoadedChannel } from "./loader.js";

/**
 * Runs the enabled channels.
 *
 * This is the piece that turns a configured channel into a working one: it
 * calls the package's start(), hands it the context it needs, and turns each
 * ask() into a real session and a real reply.
 */

export type ChannelState = "running" | "stopped" | "starting" | "error";

interface ChannelRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  instructions: string;
  relay_progress: number;
  relay_tools: number;
  updated_at: string;
}

interface Running {
  /** Restarted when this changes, so an edited token takes effect. */
  signature: string;
  slug: string;
  state: ChannelState;
  error?: string;
  since: string;
  controller: AbortController;
  stop?: () => Promise<void> | void;
  /** Optional: not every transport can speak first. A webhook cannot. */
  send?: (
    target: string,
    text: string,
    options?: { label: string; reply: string }[]
  ) => Promise<void> | void;
  /** Optional: platform-native question rendering, with a text fallback. */
  prompt?: (
    target: string,
    request: { id: string; method: string; question: string; options?: string[] }
  ) => Promise<{ value?: unknown; cancelled?: boolean } | null>;
  log: { at: string; text: string }[];
}

/** Kept per channel and shown on its page — enough to see what happened. */
const MAX_LOG = 50;

/**
 * Said on its own, these stop whatever the agent is doing.
 *
 * Matched only when the message is the word and nothing else: "stop" halts the
 * run, "stop using the staging bucket" is an instruction and must reach the
 * agent intact.
 */
const INTERRUPTS = new Set([
  "wait",
  "stop",
  "halt",
  "cancel",
  "abort",
  "hold on",
  "nevermind",
  "never mind",
]);

const isInterrupt = (text: string) =>
  INTERRUPTS.has(text.trim().toLowerCase().replace(/[.!?]+$/, ""));

/** An extension dialog waiting on a reply from the chat. */
interface PendingUi {
  id: string;
  method: string;
  options?: string[];
}

class ChannelSupervisor {
  private running = new Map<string, Running>();
  private syncing: Promise<void> | null = null;
  /** Open dialogs, by session. The next message in that chat answers one. */
  private pendingUi = new Map<string, PendingUi>();

  private rows(): ChannelRow[] {
    return getDb().prepare("SELECT * FROM channels").all() as ChannelRow[];
  }

  status(id: string): { state: ChannelState; error?: string; since?: string; log: Running["log"] } {
    const live = this.running.get(id);
    if (!live) return { state: "stopped", log: [] };
    return { state: live.state, error: live.error, since: live.since, log: live.log };
  }

  /** Serialised: two overlapping syncs would start the same channel twice. */
  sync(): Promise<void> {
    const next = (this.syncing ?? Promise.resolve()).catch(() => {}).then(() => this.syncNow());
    this.syncing = next;
    return next;
  }

  private async syncNow(): Promise<void> {
    const { channels: kinds } = await loadChannels();
    const byKind = new Map(kinds.map((k) => [k.id, k]));
    const rows = this.rows();
    const wanted = new Map(rows.filter((r) => r.enabled).map((r) => [r.id, r]));

    // Anything running that should not be, or whose configuration moved.
    for (const [id, live] of [...this.running]) {
      const row = wanted.get(id);
      if (!row || signature(row) !== live.signature) {
        await this.stopChannel(id);
      }
    }

    for (const [id, row] of wanted) {
      if (this.running.has(id)) continue;
      const kind = byKind.get(row.kind);
      if (!kind?.start) {
        // Enabled but unrunnable — say so rather than looking healthy.
        this.running.set(id, {
          signature: signature(row),
          slug: row.slug,
          state: "error",
          error: kind
            ? `${kind.packageName} has no start(), so it cannot run`
            : `No installed package provides "${row.kind}"`,
          since: new Date().toISOString(),
          controller: new AbortController(),
          log: [],
        });
        continue;
      }
      await this.startChannel(row, kind);
    }
  }

  private async startChannel(row: ChannelRow, kind: LoadedChannel): Promise<void> {
    const controller = new AbortController();
    const live: Running = {
      signature: signature(row),
      slug: row.slug,
      state: "starting",
      since: new Date().toISOString(),
      controller,
      log: [],
    };
    this.running.set(row.id, live);

    const log = (text: string) => {
      live.log.push({ at: new Date().toISOString(), text: String(text) });
      if (live.log.length > MAX_LOG) live.log.shift();
      console.log(`[channel ${row.slug}] ${text}`);
    };

    try {
      const handle = await kind.start!({
        config: parseConfig(row.config),
        log,
        signal: controller.signal,
        ask: (text: string, meta: Record<string, unknown> = {}) =>
          this.ask(row.id, text, meta),
      });
      live.stop = handle?.stop;
      live.send = handle?.send;
      live.prompt = handle?.prompt;
      live.state = "running";
      log("started");
    } catch (e) {
      live.state = "error";
      live.error = (e as Error).message;
      log(`failed to start: ${live.error}`);
    }
  }

  /** Can this channel speak first? Only running channels that implement send. */
  canSend(slug: string): boolean {
    return Boolean(this.liveBySlug(slug)?.send);
  }

  /**
   * Say something nobody asked for — a routine reporting back.
   *
   * Deliberately not routed through a session: this is the portal talking, not
   * the agent mid-conversation, and pushing it through the channel's session
   * would leave a message in the transcript that nobody sent.
   */
  async send(
    slug: string,
    target: string,
    text: string,
    options?: { label: string; reply: string }[]
  ): Promise<"sent" | "queued"> {
    if (!text.trim()) return "sent";
    const live = this.liveBySlug(slug);
    const session = findChannelSession(scopeKey(slug, target));

    // A transport that cannot be spoken to is not a dead end, only a slower
    // one: the message waits and goes out with the reply to whatever they say
    // next. The alternative — refusing to carry it — loses the message
    // entirely, which is worse than delivering it late.
    if (!live?.send) {
      if (!session) {
        throw new Error(
          live
            ? `"${slug}" cannot be spoken to, and there is no conversation to hold this for`
            : `Channel "${slug}" is not running`
        );
      }
      addNote(session.id, text, true);
      return "queued";
    }

    await live.send(target, text, options);
    // The agent said this, so its conversation has to know it said it. Without
    // this, a routine reports into a chat and the follow-up question — "what did
    // you mean by that?" — reaches an agent with no idea what "that" is.
    if (session) addNote(session.id, text);
    return "sent";
  }

  /**
   * Pick a conversation back up after its question was answered.
   *
   * Runs as that conversation, so a colleague's session is still a colleague's
   * session: the grant permits the one action that was approved and nothing
   * else. Not awaited by the answer path — the person who answered should not
   * be left holding a chat window while somebody else's work runs.
   */
  private async resume(
    sessionId: string,
    question: QuestionRow,
    answer: string,
    approves: boolean
  ): Promise<void> {
    const who = primaryName();
    const prompt = [
      "<answer-from-primary>",
      `${who} has answered the question you put to them: ${answer}`,
      approves && question.action
        ? `That is an approval. You may run \`${question.action}\` once, now — exactly as ` +
          `written. Do it, then tell ${question.person_name} what came of it.`
        : approves
          ? `Carry on with what you were asked, then tell ${question.person_name}.`
          : `That is not an approval. Tell ${question.person_name} what ${who} said and do not ` +
            `attempt it. Do not ask again.`,
      `Reply to ${question.person_name}, not to ${who} — this is their conversation.`,
      "</answer-from-primary>",
    ].join("\n");

    // Wrapped, not appended. Loose in the prompt they read as the other person
    // speaking, and the agent answered its own last message back to them.
    const pending = takeNotes(sessionId);
    const full = pending.length
      ? `${prompt}\n\n<sent-since-you-last-spoke>\n${pending.join("\n\n---\n\n")}\n</sent-since-you-last-spoke>`
      : prompt;

    try {
      const reply = stripThinkingMarkers((await sessions.ask(sessionId, full)) ?? "");
      if (reply) await this.send(question.channel_slug, question.channel_key, reply);
    } catch (e) {
      console.error(`[portal] could not resume ${sessionId}: ${(e as Error).message}`);
    }
  }

  /** Tell the primary user that somebody new turned up — once per person. */
  private async announce(person: PersonRow, slug: string): Promise<void> {
    if (person.announced_at) return;
    markAnnounced(person.key);
    const to = getDefaultReportTo();
    if (!to) return;
    try {
      await this.send(
        to.channel,
        to.target,
        `${person.name} messaged me on ${slug} and I do not know them, so I said no. ` +
          `Add them in Settings → People if they should get through.`
      );
    } catch {
      // Nothing to do about it here; they are recorded either way.
    }
  }

  private liveBySlug(slug: string): Running | undefined {
    for (const live of this.running.values()) {
      if (live.slug === slug && live.state === "running") return live;
    }
    return undefined;
  }

  private async stopChannel(id: string): Promise<void> {
    const live = this.running.get(id);
    if (!live) return;
    this.running.delete(id);
    try {
      live.controller.abort();
      await live.stop?.();
    } catch (e) {
      console.error(`[channel ${live.slug}] stop failed: ${(e as Error).message}`);
    }
  }

  /**
   * A message arriving on a channel.
   *
   * The package decided what conversation it belongs to; this turns that key
   * into a session and waits for the agent's reply, because somebody is sitting
   * in a chat expecting one.
   */
  private async ask(
    channelId: string,
    text: string,
    meta: Record<string, unknown>
  ): Promise<string> {
    const row = getDb().prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as
      | ChannelRow
      | undefined;
    if (!row) throw new Error("This channel has been removed");

    // Who is speaking, as opposed to which conversation this is. A package that
    // cannot tell says so, and an anonymous sender is a stranger by definition.
    const from = (meta.from ?? null) as { id?: unknown; name?: unknown } | null;
    const senderId = from && typeof from.id === "string" && from.id ? from.id : null;
    const person = senderId
      ? seen(personKey(row.slug, senderId), typeof from?.name === "string" ? from.name : "")
      : null;

    if (person && person.role === "unknown" && hasPrimary()) {
      // Refused before a session exists: an unclassified sender never reaches
      // the agent at all, so there is nothing for them to talk it into.
      await this.announce(person, row.slug);
      return (
        "I only talk to people I have been introduced to. I have let my primary user know you " +
        "got in touch — if they add you, try again."
      );
    }

    // The primary user answering a question a colleague's session raised. Handled
    // before anything else: it is not a turn in this conversation, it is a reply
    // destined for a different one, and routing it through the agent would have
    // it answering itself.
    if (person?.role === "primary") {
      const pending = readAnswer(text);
      if (pending) {
        const { question, answer, approves, always } = pending;

        // An approval is a permission, not a sentence. Bound to the exact action
        // that was shown, the conversation that asked, one use, fifteen minutes
        // — so "yes" cannot be stretched into a standing role change.
        const asking = findChannelSession(scopeKey(question.channel_slug, question.channel_key));
        if (approves && question.action && asking) {
          addGrant(nanoid(10), asking.id, question.action_tool || "bash", question.action);
        }
        // Standing permission, narrowed to the person who asked. Recorded as an
        // ordinary rule so it shows up in Settings → People beside the ones
        // written by hand, and is revoked the same way.
        if (always && question.action) {
          addToolRule({
            id: nanoid(10),
            role: getPerson(question.person_key)?.role || "colleague",
            tool: question.action_tool || "bash",
            pattern: question.action,
            person_key: question.person_key,
            note: `Approved for ${question.person_name}`,
          });
        }
        let how: "sent" | "queued";
        try {
          how = await this.send(
            question.channel_slug,
            question.channel_key,
            `${primaryName()} says: ${answer}` +
              (approves && question.action
                ? `\n\n(Approved: you may now run \`${question.action}\` once.)`
                : "")
          );
        } catch (e) {
          return `Could not get that back to ${question.person_name}: ${(e as Error).message}`;
        }
        recordAnswer(question.id, answer);

        // Carry on where it left off. Without this the answer lands in a
        // conversation nobody is looking at and the work waits for the person
        // who asked to say something again — having already been told it would
        // be handled.
        if (asking) void this.resume(asking.id, question, answer, approves);

        if (approves && question.action) {
          const scope = always
            ? `${question.person_name} may run that from now on — revoke it in Settings → People.`
            : "it may run that once.";
          return how === "sent"
            ? `Approved — passed to ${question.person_name}, and ${scope}`
            : `Approved. ${question.person_name} will see it the next time they write.`;
        }
        return how === "sent"
          ? `Passed on to ${question.person_name}.`
          : `Saved for ${question.person_name} — they will see it the next time they write.`;
      }
    }

    const key = typeof meta.session === "string" ? meta.session : "";
    if (!key) {
      // Loud on purpose: silently lumping every chat into one session is the
      // failure this whole design exists to prevent.
      throw new Error(
        "ask() needs meta.session — the key identifying which conversation this message belongs to"
      );
    }

    const { session } = resolveChannelSession({
      channelSlug: row.slug,
      key,
      title: typeof meta.title === "string" ? meta.title : undefined,
      executor: EXECUTOR_KIND,
    });

    // A conversation is only ever as trusted as its least trusted participant,
    // and it does not recover: a group where a guest has spoken keeps serving
    // guest-level context even when the next message is from the primary user.
    // Before a primary is named nobody is a stranger, so nothing is downgraded
    // either — otherwise the upgrade itself would quietly strip context from
    // every existing conversation.
    if (person && hasPrimary()) {
      const settled = lower(session.role, person.role);
      if (settled !== session.role) {
        getDb().prepare("UPDATE sessions SET role = ? WHERE id = ?").run(settled, session.id);
        // The running pi process loaded context for the old role, so it has to
        // go before the next turn rather than after.
        await sessions.shutdownSession(session.id);
      }
      sessions.setSpeaker(session.id, person);
      // Persisted as well as held in memory: the in-memory speaker is empty
      // after a restart, and a question raised then was attributed to "Someone".
      getDb()
        .prepare("UPDATE sessions SET last_person_key = ? WHERE id = ?")
        .run(person.key, session.id);
    }

    // Everything below jumps the queue on purpose. ask() serialises per
    // session, so anything meant to affect the run in progress has to be
    // handled before it, or it waits behind the thing it is answering.

    const open = this.pendingUi.get(session.id);

    if (isInterrupt(text)) {
      if (open) {
        this.pendingUi.delete(session.id);
        sessions.respondUi(session.id, open.id, { cancelled: true });
        return "Cancelled.";
      }
      if (!sessions.isBusy(session.id)) return "Nothing running.";
      await sessions.abort(session.id);
      return "Stopped.";
    }

    // Answering an extension's question, not starting a new turn. The reply
    // travels back through the ask that is still running.
    if (open) {
      // Anything that is not a valid answer cancels. Re-asking would trap the
      // conversation in a question nobody meant to be in — the run stays
      // blocked, and every attempt to talk about something else gets the same
      // prompt back.
      this.pendingUi.delete(session.id);
      const answer = interpretAnswer(open, text);
      if (!sessions.respondUi(session.id, open.id, answer ?? { cancelled: true })) {
        return "That question had already expired.";
      }
      return answer ? "" : "Cancelled.";
    }

    const packageReply =
      typeof meta.onReply === "function"
        ? (meta.onReply as (text: string) => void | Promise<void>)
        : undefined;

    // Both off and nothing is relayed: the package gets one reply at the end,
    // which is also what a package that never passed onReply gets.
    const wantsProgress = Boolean(row.relay_progress);
    const wantsTools = Boolean(row.relay_tools);
    const relaying = packageReply && (wantsProgress || wantsTools);

    // Anything that could not be delivered when it was written goes out now,
    // ahead of the answer to whatever they have just said.
    const owed = takeDeliveries(session.id);
    if (owed.length && packageReply) void packageReply(owed.join("\n\n"));

    const reply = await sessions.ask(session.id, withInstructions(text, row.instructions, person, takeNotes(session.id)), {
      onReply:
        relaying && packageReply
          ? (chunk: string) => packageReply(stripThinkingMarkers(chunk))
          : undefined,
      streamText: wantsProgress,
      // Dialogs are relayed whatever the toggles say. They are not progress
      // chatter — the run is stopped until somebody answers, and silence here
      // means the command hangs until it times out.
      onUi: (request) => {
        if (request?.cancelled) {
          this.pendingUi.delete(session.id);
          void packageReply?.("That question timed out.");
          return;
        }
        const question = describeUi(request);
        if (!question) return; // notify/setStatus/setWidget are one-way

        // A channel with no way to send an unprompted message — a webhook has
        // one response to fill — cannot ask. Answering it is impossible, so
        // decline immediately instead of holding the run until it times out.
        if (!packageReply) {
          sessions.respondUi(session.id, request.id, { cancelled: true });
          return;
        }

        // Let the channel present it natively first — buttons where a platform
        // has buttons. Numbered text is the fallback, which is what a channel
        // without the affordance gets, and what any channel gets for a question
        // that does not fit one.
        const native = this.running.get(row.id)?.prompt;
        if (native && typeof meta.session === "string") {
          // The package's own key, as it supplied it — the scoped form is the
          // portal's business, not the transport's.
          void native(meta.session, {
            id: request.id,
            method: request.method,
            question,
            options: request.options,
          })
            .then((answer) => {
              if (!answer) {
                // Declined it: fall back to asking in words.
                this.pendingUi.set(session.id, {
                  id: request.id,
                  method: request.method,
                  options: request.options,
                });
                void packageReply?.(question);
                return;
              }
              sessions.respondUi(session.id, request.id, answer);
            })
            .catch(() => {
              this.pendingUi.set(session.id, {
                id: request.id,
                method: request.method,
                options: request.options,
              });
              void packageReply?.(question);
            });
          return;
        }

        this.pendingUi.set(session.id, {
          id: request.id,
          method: request.method,
          options: request.options,
        });
        void packageReply?.(question);
      },
    });

    // A channel with no way to relay mid-run had nowhere to put these, so they
    // ride out with the answer instead.
    const clean = stripThinkingMarkers(reply ?? "");
    return owed.length && !packageReply ? [...owed, clean].join("\n\n") : clean;
  }

  /** One line for the boot log. */
  summary(): string {
    const all = [...this.running.values()];
    if (!all.length) return "none enabled";
    const running = all.filter((c) => c.state === "running").length;
    const failed = all.filter((c) => c.state === "error");
    const parts = [`${running} running`];
    if (failed.length) parts.push(`${failed.length} failed (${failed.map((f) => f.slug).join(", ")})`);
    return parts.join(", ");
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopChannel(id)));
  }
}

/**
 * An extension's question, as something you can answer in a chat.
 *
 * The browser draws a modal with buttons; here the options are numbered and the
 * next message picks one. Returns undefined for the one-way calls — notify,
 * setStatus, setWidget — which are not questions and must not block anything.
 */
function describeUi(request: any): string | undefined {
  const title = String(request?.title ?? "").trim();
  const message = String(request?.message ?? "").trim();
  const head = [title, message].filter(Boolean).join("\n");

  switch (request?.method) {
    case "select": {
      const options: string[] = Array.isArray(request.options) ? request.options : [];
      if (!options.length) return `${head || "Choose"}\n(no options offered)`;
      const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      return `${head || "Choose one"}\n${list}\n\nReply with a number. Anything else cancels.`;
    }
    case "confirm":
      return `${head || "Confirm"}\n\nReply "yes" or "no". Anything else cancels.`;
    case "input":
    case "editor": {
      const hint = String(request.placeholder ?? request.defaultValue ?? "").trim();
      return `${head || "Enter a value"}${hint ? `\n(${hint})` : ""}\n\nReply with the value, or "cancel".`;
    }
    default:
      return undefined;
  }
}

/**
 * Turn a chat reply into the answer the extension is waiting for, or undefined
 * if it is not one — in which case the question is cancelled rather than asked
 * again.
 */
function interpretAnswer(
  open: PendingUi,
  text: string
): { value?: unknown; cancelled?: boolean } | undefined {
  const answer = text.trim();

  if (open.method === "select") {
    const options = open.options ?? [];
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return { value: options[n - 1] };
    // Typing the option itself is the obvious thing to try, so accept it.
    const exact = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    return exact ? { value: exact } : undefined;
  }

  if (open.method === "confirm") {
    if (/^(y|yes|ok|okay|sure|do it)$/i.test(answer)) return { value: true };
    if (/^(n|no|nope|don't|dont)$/i.test(answer)) return { value: false };
    return undefined;
  }

  // input and editor take whatever was typed; an empty message is not an answer.
  return answer ? { value: answer } : undefined;
}

/**
 * The channel's standing instructions, attached to each incoming message.
 *
 * Appended per message rather than set once as a system prompt: pi exposes
 * systemPrompt as a getter with no setter, and editing the instructions should
 * take effect on the next message rather than the next restart.
 */
/**
 * The message, plus what the agent needs to know to answer it properly.
 *
 * Who is speaking is attached to every message rather than stated once at
 * session start, because in a group the sender changes between turns and an
 * agent working from the first one answers the wrong person.
 */
function withInstructions(
  text: string,
  instructions: string,
  person?: PersonRow | null,
  notes: string[] = []
): string {
  const parts = [text];
  if (notes.length) {
    parts.push(
      "<sent-since-you-last-spoke>\n" +
        "You sent these into this conversation while it was idle — a routine's report, or an " +
        "answer passed back. They are yours and the other person has already read them.\n\n" +
        notes.join("\n\n---\n\n") +
        "\n</sent-since-you-last-spoke>"
    );
  }
  const who = person
    ? senderFraming(
        person,
        primaryName(),
        Boolean(getDefaultReportTo()),
        listToolRules()
          .filter((r) => r.role === person.role || r.role === "all")
          .map((r) => `${r.tool}: ${r.pattern}`)
      )
    : "";
  if (who) parts.push(`<speaker>\n${who}\n</speaker>`);
  const extra = (instructions ?? "").trim();
  if (extra) parts.push(`<channel-instructions>\n${extra}\n</channel-instructions>`);
  return parts.join("\n\n");
}

const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** Config or identity changing means the running channel is stale. */
const signature = (row: ChannelRow) =>
  `${row.slug}|${row.kind}|${row.config}|${row.updated_at}`;

export const channelSupervisor = new ChannelSupervisor();
