import {
  addNote,
  recordAudit,
  findChannelSession,
  getDb,
  getSession,
  getDefaultReportTo,
  listToolRules,
  takeDeliveries,
  pendingNotes,
  consumeNotes,
} from "../db.js";
import { resolveChannelSession, scopeKey, unscopeKey } from "../agent.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { sessions, CommandFailed, IMAGE_ROOT, stripThinkingMarkers, type SentFile } from "../session-manager.js";
import { ImageError, parseImages, saveImages } from "../prompt-images.js";
import { picturesRefused } from "../pi/builtins.js";
import { ruleApplies } from "../pi/guard.js";
import { readAnswer, recordAnswer, type QuestionRow } from "../questions.js";
import { recordApproval } from "../approvals.js";
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
import { neutralise, notesBlock } from "./framing.js";
import { parseConfig, type ChannelRow } from "./row.js";
import { readChannelState, removeChannelState, writeChannelState } from "./state.js";

/**
 * Runs the enabled channels.
 *
 * This is the piece that turns a configured channel into a working one: it
 * calls the package's start(), hands it the context it needs, and turns each
 * ask() into a real session and a real reply.
 */

export type ChannelState = "running" | "stopped" | "starting" | "error";

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
    request: {
      id: string;
      method: string;
      question: string;
      options?: string[];
      /**
       * Whether the sender with this platform id may answer: the person it was
       * asked of, or the primary user. For a transport whose answers are taps
       * that any member of a group can make.
       */
      canAnswer: (senderId: string) => boolean;
    }
  ) => Promise<{ value?: unknown; cancelled?: boolean } | null>;
  log: { at: string; text: string }[];
  /** What the package asks to be scanned or typed in to finish setting it up: see ctx.showPairing. */
  pairing?: Pairing;
}

/**
 * A code a channel needs somebody to take to their phone — Signal's link to a
 * new device, say — and a line on what to do with it. Shown on the channel's
 * page as a QR code, and as text for one that is typed in.
 */
export interface Pairing {
  code: string;
  hint: string;
}

/** Long enough for any link a QR code can hold, which is all this is for. */
const MAX_PAIRING = 2000;

/** Kept per channel and shown on its page — enough to see what happened. */
const MAX_LOG = 50;

/**
 * How long before a channel that failed to start is tried again, by attempt.
 *
 * A token that is wrong stays wrong, but a network that was not up yet when the
 * portal booted, or a platform having a bad minute, are the usual causes — and
 * each used to leave the channel dead until somebody saved it again.
 */
const retryDelay = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);

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
  /** Whose message raised it: only they, or the primary user, answer it. */
  asker?: string;
}

/** May this sender answer the dialog? Anybody may where nobody was told apart. */
const mayAnswer = (open: PendingUi, who: { key: string; role: string } | null | undefined): boolean =>
  !open.asker || who?.key === open.asker || who?.role === "primary";

class ChannelSupervisor {
  private running = new Map<string, Running>();
  private syncing: Promise<void> | null = null;
  /** Open dialogs, by session. The next message in that chat answers one. */
  private pendingUi = new Map<string, PendingUi>();
  /** How long a package gets to stop before the portal goes on without it. */
  stopGraceMs = 5000;
  /** Channels waiting to try starting again, with how many times they have failed. */
  private retries = new Map<string, { attempt: number; timer: NodeJS.Timeout }>();

  private rows(): ChannelRow[] {
    return getDb().prepare("SELECT * FROM channels").all() as ChannelRow[];
  }

  status(id: string): { state: ChannelState; error?: string; since?: string; log: Running["log"]; pairing?: Pairing } {
    const live = this.running.get(id);
    if (!live) return { state: "stopped", log: [] };
    return { state: live.state, error: live.error, since: live.since, log: live.log, ...(live.pairing ? { pairing: live.pairing } : {}) };
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

    // Anything running that should not be, or whose configuration moved. One
    // that could not run is looked at again: a sync is the moment something
    // may have changed — its package installed, or somebody pressing save.
    // One that failed to start and is waiting on its own retry is left to it,
    // or every other channel's sync would restart it early.
    for (const [id, live] of [...this.running]) {
      const row = wanted.get(id);
      // A changed configuration is a fresh start, not another failure.
      if (row && signature(row) !== live.signature) this.clearRetry(id);
      if (!row || signature(row) !== live.signature || (live.state === "error" && !this.retries.has(id))) {
        await this.stopChannel(id);
      }
    }
    for (const id of [...this.retries.keys()]) {
      if (!wanted.has(id)) this.clearRetry(id);
    }
    // A channel switched off forgets where it was: switched on again, it starts
    // from now rather than answering everything said while it was off.
    for (const row of rows) if (!row.enabled) removeChannelState(row.id);

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

  private async startChannel(row: ChannelRow, kind: LoadedChannel, history: Running["log"] = []): Promise<void> {
    const controller = new AbortController();
    const live: Running = {
      signature: signature(row),
      slug: row.slug,
      state: "starting",
      since: new Date().toISOString(),
      controller,
      log: history,
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
        // Not through log: a code to scan is not something that happened, it
        // is wanted until it is scanned, and the next code replaces it.
        // Only while this start of the channel is the one running: one that
        // was stopped does not put its code on the next one's page.
        showPairing: (pairing: unknown) => {
          if (this.running.get(row.id) !== live) return;
          const code = typeof (pairing as Pairing | null)?.code === "string" ? (pairing as Pairing).code.trim() : "";
          const hint = typeof (pairing as Pairing | null)?.hint === "string" ? (pairing as Pairing).hint.trim() : "";
          live.pairing = code && code.length <= MAX_PAIRING ? { code, hint } : undefined;
        },
        // Kept across starts, for a package that has to know where it left off.
        // Not by a start that has been stopped: it would write over what the
        // one after it keeps.
        state: {
          get: () => readChannelState(row.id),
          set: (value: unknown) => {
            if (this.running.get(row.id) !== live) return;
            writeChannelState(row.id, value);
          },
        },
      });
      live.stop = handle?.stop;
      live.send = handle?.send;
      live.prompt = handle?.prompt;
      live.state = "running";
      log("started");
      this.clearRetry(row.id);
    } catch (e) {
      live.state = "error";
      live.error = (e as Error).message;
      const attempt = (this.retries.get(row.id)?.attempt ?? 0) + 1;
      const delay = retryDelay(attempt);
      log(`failed to start: ${live.error} — trying again in ${Math.round(delay / 1000)}s`);
      this.clearRetry(row.id);
      const timer = setTimeout(() => void this.retry(row.id).catch(() => {}), delay);
      timer.unref();
      this.retries.set(row.id, { attempt, timer });
    }
  }

  /**
   * Another try at starting one channel that failed, and only that one.
   * Queued behind any sync, for the same reason syncs are.
   */
  private retry(id: string): Promise<void> {
    const next = (this.syncing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const live = this.running.get(id);
        const row = this.rows().find((r) => r.id === id && r.enabled);
        const kind = row && (await loadChannels()).channels.find((k) => k.id === row.kind);
        if (!live || !row || live.state !== "error" || signature(row) !== live.signature || !kind?.start) {
          // Switched off, edited or uninstalled since: sorting that out is a sync's job.
          this.clearRetry(id);
          return this.syncNow();
        }
        await this.stopChannel(id);
        // Keeps its count, so the wait before the next try grows, and its log,
        // so what happened on the tries before can still be read.
        await this.startChannel(row, kind, live.log);
      });
    this.syncing = next;
    return next;
  }

  private clearRetry(id: string): void {
    const retry = this.retries.get(id);
    if (!retry) return;
    clearTimeout(retry.timer);
    this.retries.delete(id);
  }

  /**
   * Tell the people whose conversation a restart cut off.
   *
   * The channel acknowledged what they said before the portal went down, and
   * will not hand it over again: a run that was going is gone, and so is what
   * they sent meanwhile. Without a word they would wait for an answer that
   * never comes. Only a channel that can speak first is written to — what is
   * left for one that cannot would go out with the answer to their next
   * message, long after they had given up.
   */
  async tellRestart(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) {
      const session = getSession(id);
      const live = session?.channel_slug ? this.liveBySlug(session.channel_slug) : undefined;
      if (!session?.channel_slug || !session.channel_key || !live?.send) continue;
      try {
        // Not through send(): that keeps what it says as a note for the agent,
        // and a note taints the conversation for good (see notesBlock) — which
        // this sentence of the portal's own, with nothing from outside in it,
        // would do to the primary user's. They will say it again anyway.
        await live.send(
          unscopeKey(session.channel_slug, session.channel_key),
          "The portal restarted while I was working on this, so my answer was cut off. Please send your message again.",
        );
      } catch (e) {
        console.error(`[portal] could not tell ${session.channel_key} about the restart: ${(e as Error).message}`);
      }
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
   *
   * What it says is kept as a note for the conversation it lands in, unless
   * `note` is off. Words an outsider got into it — a guest's question to the
   * primary user — are not for the agent: a note taints the conversation for
   * good (see notesBlock), and the answer reaches the one who asked without it.
   * Nor are the answer that is relayed back and the reply of the turn it
   * resumes: the first is the primary user's own, the second the agent's.
   */
  async send(
    slug: string,
    target: string,
    text: string,
    options?: { label: string; reply: string }[],
    note = true
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
      addNote(session.id, text, true, note);
      return "queued";
    }

    await live.send(target, text, options);
    // The agent said this, so its conversation has to know it said it. Without
    // this, a routine reports into a chat and the follow-up question — "what did
    // you mean by that?" — reaches an agent with no idea what "that" is.
    if (session && note) addNote(session.id, text);
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
    const asker = question.person_name;
    // A question without an action asked for a decision, not permission: nothing was held back, so the answer is an
    // answer, whatever words it is in. One about an action is a permission, and only its words give it.
    const verdict = !question.action
      ? `Tell ${asker} what ${who} said, and go on as that answer says, within what you may do for them: ` +
        `it allows nothing more than before.`
      : approves
        ? `That is an approval. You may run \`${question.action}\` once, now — exactly as ` +
          `written. Do it, then tell ${asker} what came of it.`
        : /^no\b/i.test(answer)
          ? `That is a no. Tell ${asker} what ${who} said and do not attempt it. Do not ask again.`
          : `That is not an approval: only "approve" and "always" are, so nothing ran and nothing is allowed. ` +
            `Tell ${asker} what ${who} said. If you still need it, you may ask again, and ${who} has to answer ` +
            `with approve or always (or no).`;
    const prompt = [
      "<answer-from-primary>",
      `${who} has answered the question you put to them: ${answer}`,
      verdict,
      `Reply to ${asker}, not to ${who} — this is their conversation.`,
      "</answer-from-primary>",
    ].join("\n");

    try {
      const reply = stripThinkingMarkers((await sessions.ask(sessionId, () => {
        const pending = pendingNotes(sessionId);
        const full = pending.length ? `${prompt}\n\n${notesBlock(pending.map((n) => n.text))}` : prompt;
        return { message: full, onAccepted: () => consumeNotes(sessionId, pending.map(n => n.id)) };
      })) ?? "");
      // Not a note: the agent wrote it, so it is in its own transcript, and kept as a note it would
      // taint the conversation at the next message and refuse the pushes it was just allowed.
      if (reply) await this.send(question.channel_slug, question.channel_key, reply, undefined, false);
    } catch (e) {
      console.error(`[portal] could not resume ${sessionId}: ${(e as Error).message}`);
    }
  }

  /**
   * Tell the primary user that somebody new turned up — once per person, once it
   * got through. Whether they know: a person not announced yet is tried again
   * with their next message, so that a report target set later, or a channel that
   * is back, still brings the word.
   *
   * Not through send(): that keeps what it says as a note for the agent, and a note
   * taints the conversation for good (see notesBlock) — here with the stranger's
   * own name in it, which an outsider can set to anything and trigger as often as
   * they have accounts. The agent has no need of it to answer the primary user.
   */
  private announce(person: PersonRow, slug: string): Promise<boolean> {
    if (person.announced_at) return Promise.resolve(true);
    // Two messages together are one announcement.
    const going = this.announcing.get(person.key);
    if (going) return going;
    const attempt = (async () => {
      const to = getDefaultReportTo();
      const live = to ? this.liveBySlug(to.channel) : undefined;
      if (!to || !live?.send) return false;
      try {
        await live.send(
          to.target,
          `${person.name} messaged me on ${slug} and I do not know them, so I said no. ` +
            `Add them in Settings → People if they should get through.`
        );
      } catch (e) {
        console.error(`[portal] could not tell ${to.channel} about ${person.key}: ${(e as Error).message}`);
        return false;
      }
      markAnnounced(person.key);
      return true;
    })().finally(() => this.announcing.delete(person.key));
    this.announcing.set(person.key, attempt);
    return attempt;
  }
  private announcing = new Map<string, Promise<boolean>>();

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
    let timer: NodeJS.Timeout | undefined;
    try {
      live.controller.abort();
      // A package that waits for something to end (a webhook with a request open
      // for the length of an agent turn) must not hold every later sync and the
      // shutdown with it.
      await Promise.race([
        live.stop?.(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error(`[channel ${live.slug}] did not stop within ${this.stopGraceMs / 1000}s; carrying on without it`);
            resolve();
          }, this.stopGraceMs);
        }),
      ]);
    } catch (e) {
      console.error(`[channel ${live.slug}] stop failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
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

    if (!person && hasPrimary()) {
      // Once somebody is named, nobody is let in unknown, and a message that says
      // nothing of who sent it cannot be told from a stranger's. Said so, so that
      // whoever set the channel up knows what to give it.
      recordAudit({
        kind: "stranger",
        reason: `Turned away on ${row.slug}: the message named no sender`,
        subject: text.slice(0, 200),
      });
      return (
        "I only talk to people I have been introduced to, and this message did not say who " +
        "sent it. If this channel is yours, have it name its sender."
      );
    }

    if (person && person.role === "unknown" && hasPrimary()) {
      recordAudit({
        kind: "stranger",
        reason: `Turned away on ${row.slug}`,
        subject: text.slice(0, 200),
        personKey: person.key,
      });
      // Refused before a session exists: an unclassified sender never reaches
      // the agent at all, so there is nothing for them to talk it into.
      // Said as it is: with nobody to tell, "I have let them know" would have them wait for it.
      return (await this.announce(person, row.slug))
        ? "I only talk to people I have been introduced to. I have let my primary user know you " +
            "got in touch — if they add you, try again."
        : "I only talk to people I have been introduced to, and I could not reach my primary user " +
            "about you. Ask them to add you, then try again.";
    }

    // The primary user answering a question a colleague's session raised. Handled
    // before anything else: it is not a turn in this conversation, it is a reply
    // destined for a different one, and routing it through the agent would have
    // it answering itself.
    if (person?.role === "primary") {
      const pending = readAnswer(text);
      if (pending) {
        const { question, answer, approves, always } = pending;

        const asking = findChannelSession(scopeKey(question.channel_slug, question.channel_key));
        let how: "sent" | "queued";
        try {
          // Not a note either: the primary user's own words are not somebody else's, and the resumed
          // turn below hands the agent the answer. A note taints the conversation for good, and an
          // approved push is refused in a tainted one after the approval has been spent on it.
          how = await this.send(
            question.channel_slug,
            question.channel_key,
            `${primaryName()} says: ${answer}` +
              (approves && question.action
                ? `\n\n(Approved: you may now run \`${question.action}\` once.)`
                : ""),
            undefined,
            false
          );
        } catch (e) {
          // Nothing was written down, and the question is still open: answered again, it is passed on once it can be.
          return `Could not get that back to ${question.person_name}: ${(e as Error).message}`;
        }
        // Only once the answer is on its way, so that an approval is never left standing for a refusal the
        // primary user was told of. The relay is awaited and the grant follows it at once, before the person
        // it is for can have read the answer.
        recordApproval(question, asking, approves, always);
        recordAudit({
          kind: "answered",
          tool: question.action_tool || "",
          subject: question.action || question.question.slice(0, 200),
          // Only a question about an action can be refused: one for a decision was answered, whatever the answer was.
          reason: !question.action
            ? `Answered for ${question.person_name}`
            : always
              ? `Always allowed for ${question.person_name}`
              : approves
                ? `Approved once for ${question.person_name}`
                : `Refused for ${question.person_name}`,
          personKey: question.person_key,
          sessionId: asking?.id ?? null,
        });
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
        // An answer to a question about an action that is neither of the words that approve it nor a no: said, so that
        // they do not think it ran. The question is answered, so the agent has to ask again.
        const unclear = question.action && !/^no\b/i.test(answer) ? ` It was not an approval (only "approve" and "always" are), so nothing will run.` : "";
        return how === "sent"
          ? `Passed on to ${question.person_name}.${unclear}`
          : `Saved for ${question.person_name} — they will see it the next time they write.${unclear}`;
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

    // Pictures that came with it, held to the rules a browser's are: what their
    // bytes say they are, five megabytes and eight at most. Said as the answer
    // when they are not, since somebody sent them and is waiting.
    let pictures: ReturnType<typeof parseImages>;
    try {
      pictures = parseImages(meta.images);
    } catch (e) {
      if (e instanceof ImageError) return e.message;
      throw e;
    }

    const { session } = resolveChannelSession({
      channelSlug: row.slug,
      key,
      title: typeof meta.title === "string" ? meta.title : undefined,
      executor: EXECUTOR_KIND,
    });

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
    // travels back through the ask that is still running. Only by the one it
    // was asked of, or the primary user: in a group the next message is
    // anybody's, and a dialog that asks the owner to confirm something is not
    // for a guest to say yes to.
    if (open && !mayAnswer(open, person)) {
      return `That question is waiting for ${getPerson(open.asker!)?.name ?? "somebody else"}. Your message was not taken as the answer.`;
    }
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

    // A command acts on the session and never reaches the model: pictures sent
    // with one would be lost without a word.
    const refused = pictures.length ? await picturesRefused(text) : undefined;
    if (refused) return refused;

    const packageReply =
      typeof meta.onReply === "function"
        ? (meta.onReply as (text: string) => void | Promise<void>)
        : undefined;
    // Optional too: a package that cannot send a picture or a clip leaves it
    // out, and the file is named among the agent's words instead.
    const packagePicture =
      typeof meta.onPicture === "function"
        ? (meta.onPicture as (picture: SentFile) => void | Promise<void>)
        : undefined;
    const packageVideo =
      typeof meta.onVideo === "function"
        ? (meta.onVideo as (video: SentFile) => void | Promise<void>)
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

    const reply = await sessions.ask(session.id, () => {
      const pending = pendingNotes(session.id);
      return {
        message: withInstructions(text, row.instructions, person, pending.map(n => n.text)),
        // Kept only now that it is this message's turn: one that never gets
        // there leaves no files behind.
        images: saveImages(IMAGE_ROOT, session.id, pictures),
        onAccepted: () => consumeNotes(session.id, pending.map(n => n.id)),
      };
    }, {
      beforeTurn: async () => {
        // A conversation is only ever as trusted as its least trusted participant,
        // and it does not recover: a group where a guest has spoken keeps serving
        // guest-level context even when the next message is from the primary user.
        // Before a primary is named nobody is a stranger, so nothing is downgraded
        // either — otherwise the upgrade itself would quietly strip context from
        // every existing conversation.
        if (person && hasPrimary()) {
          const current = getSession(session.id);
          if (!current) throw new Error("Session no longer exists");
          const settled = lower(current.role, person.role);
          if (settled !== current.role) {
            getDb().prepare("UPDATE sessions SET role = ? WHERE id = ?").run(settled, session.id);
            // The previous turn has finished; reload its context before this one.
            await sessions.shutdownSession(session.id);
          }
          sessions.setSpeaker(session.id, person);
          getDb().prepare("UPDATE sessions SET last_person_key = ? WHERE id = ?")
            .run(person.key, session.id);
        }
      },
      onReply:
        relaying && packageReply
          ? (chunk: string) => packageReply(stripThinkingMarkers(chunk))
          : undefined,
      streamText: wantsProgress,
      onPicture: packagePicture,
      onVideo: packageVideo,
      // Dialogs are relayed whatever the toggles say. They are not progress
      // chatter — the run is stopped until somebody answers, and silence here
      // means the command hangs until it times out.
      onUi: (request) => {
        if (request?.cancelled) {
          if (this.pendingUi.get(session.id)?.id !== request.id) return;
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
            canAnswer: (senderId) => mayAnswer({ id: request.id, method: request.method, asker: person?.key }, getPerson(personKey(row.slug, senderId))),
          })
            .then((answer) => {
              if (!answer) {
                // Declined it: fall back to asking in words.
                this.pendingUi.set(session.id, { id: request.id, method: request.method, options: request.options, asker: person?.key });
                void packageReply?.(question);
                return;
              }
              sessions.respondUi(session.id, request.id, answer);
            })
            .catch(() => {
              this.pendingUi.set(session.id, { id: request.id, method: request.method, options: request.options, asker: person?.key });
              void packageReply?.(question);
            });
          return;
        }

        this.pendingUi.set(session.id, { id: request.id, method: request.method, options: request.options, asker: person?.key });
        void packageReply?.(question);
      },
    }).catch((e) => {
      // A command that was refused, said as the answer: it is what the sender asked for.
      if (e instanceof CommandFailed) return e.message;
      throw e;
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
    for (const id of [...this.retries.keys()]) this.clearRetry(id);
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
 * The message, plus what the agent needs to know to answer it properly.
 *
 * Who is speaking is attached to every message rather than stated once at
 * session start, because in a group the sender changes between turns and an
 * agent working from the first one answers the wrong person.
 *
 * The channel's standing instructions go with each message rather than being
 * set once as a system prompt: pi exposes systemPrompt as a getter with no
 * setter, and editing the instructions should take effect on the next message
 * rather than the next restart.
 *
 * Somebody who is not the primary user speaks after the portal has said who
 * they are, never first: a message that began with their words could begin
 * with a command. And their words cannot make one of the portal's blocks.
 */
function withInstructions(
  text: string,
  instructions: string,
  person?: PersonRow | null,
  notes: string[] = []
): string {
  const who = person
    ? senderFraming(
        person,
        primaryName(),
        Boolean(getDefaultReportTo()),
        listToolRules()
          .filter((r) => ruleApplies(r, person.role, person.key))
          .map((r) => `${r.tool}: ${r.pattern}`)
      )
    : "";
  const extra = (instructions ?? "").trim();
  return [
    ...(who ? [`<speaker>\n${who}\n</speaker>`] : []),
    neutralise(text),
    ...(notes.length ? [notesBlock(notes)] : []),
    ...(extra ? [`<channel-instructions>\n${extra}\n</channel-instructions>`] : []),
  ].join("\n\n");
}

/** Config or identity changing means the running channel is stale. */
const signature = (row: ChannelRow) =>
  `${row.slug}|${row.kind}|${row.config}|${row.updated_at}`;

export const channelSupervisor = new ChannelSupervisor();
