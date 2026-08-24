import { EventEmitter } from "node:events";
import type { PersonRow, Role } from "./people.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PiClient } from "./pi/types.js";
import { findServerBuiltin, runBuiltin } from "./pi/builtins.js";
import { buildExecutor, type Executor, type ExecutorKind } from "./executors/index.js";
import {
  appendEvent,
  getSession,
  getSettings,
  markOrphanedSessionsInterrupted,
  browserAllowed,
  browserAllowlist,
  routineGuards,
  updateSession,
} from "./db.js";

/**
 * Thinking markers that escape into the answer.
 *
 * A reasoning model sometimes closes a thought inside the text it means to say,
 * and a stray </think> then travels to whoever is reading — a chat window, a
 * Telegram message. Stripped where the text leaves the portal rather than in
 * the stored events, so the record of what the model actually produced stays
 * intact.
 */
export const stripThinkingMarkers = (text: string): string =>
  text.replace(/<\/?think(ing)?>/gi, "").trim();

/** Mirrors what the web transcript shows, so a chat and the UI agree. */
function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  const trim = (v: string) => (v.length > 80 ? `${v.slice(0, 79)}…` : v);
  if (typeof input === "string") return trim(input);
  if (typeof input === "object") {
    const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof first === "string") return trim(first);
    return trim(JSON.stringify(input));
  }
  return undefined;
}

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
const EXECUTOR_KIND = (process.env.EXECUTOR || "host") as ExecutorKind;

/**
 * Events that must not be persisted.
 *
 * Beyond noise, extension dialogs are strictly live: a stored
 * extension_ui_request would be replayed to every future reader, so reloading
 * the page reopened a dialog whose extension had long since stopped waiting.
 */
const EPHEMERAL_EVENTS = new Set([
  "queue_update",
  "extension_ui_request",
  "extension_ui_cancel",
  // Prefill progress: a hundred rows per long prompt, and meaningless once the
  // answer has arrived. Delivered to whoever is watching, never stored.
  "portal_prefill",
]);

interface LiveSession {
  client: PiClient;
  executor: Executor;
}

/**
 * Owns every running pi process.
 *
 * The important property: a run is tied to this manager, not to any HTTP
 * request. Once a prompt is accepted the browser can disappear — output keeps
 * streaming into the event log, and a later reconnect replays it.
 */
class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  /** In-flight ask() per session, so messages in one chat are answered in turn. */
  private asking = new Map<string, Promise<string>>();
  /**
   * Who sent the message being handled, per session.
   *
   * Per message rather than per session because a group conversation has many
   * senders: the guard asks this at tool-call time so capability follows whoever
   * is actually speaking, not whoever spoke first.
   */
  private speaker = new Map<string, PersonRow>();

  constructor() {
    super();
    this.setMaxListeners(0);
    mkdirSync(SESSION_ROOT, { recursive: true });
    const orphaned = markOrphanedSessionsInterrupted();
    if (orphaned > 0) {
      console.log(`[portal] marked ${orphaned} session(s) interrupted (server restarted mid-run)`);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.client.running ?? false;
  }

  /** Record an event: persist it, then fan out to any attached SSE clients. */
  private record(sessionId: string, type: string, payload: unknown): void {
    if (EPHEMERAL_EVENTS.has(type)) {
      // Still deliver it to anyone attached right now, with a negative seq so
      // it can never be confused with a stored event during replay.
      this.emit(`session:${sessionId}`, {
        seq: -Date.now(),
        session_id: sessionId,
        type,
        payload: JSON.stringify(payload),
      });
      return;
    }
    const row = appendEvent(sessionId, type, payload);
    this.emit(`session:${sessionId}`, row);
  }

  /**
   * Compact on request.
   *
   * Marked running for the same reason a prompt is: it takes a model call and
   * a minute, and without it the composer showed nothing, the transcript
   * showed nothing, and there was no Stop to press — a long compaction was
   * indistinguishable from a hung portal.
   */
  async compact(sessionId: string): Promise<void> {
    // One at a time. A second request used to overwrite the tracked promise,
    // and whichever finished first then cleared it and published idle while
    // the other was still going — which is exactly the state prompt() checks
    // for before deciding it is safe to start.
    const inFlight = this.compacting.get(sessionId);
    if (inFlight) return inFlight;

    // Before starting pi, not after: on a cold session that takes seconds, and
    // those are exactly the seconds with no activity line and no Stop.
    this.mark(sessionId, "running");
    const run = (async () => {
      const client = await this.ensureClient(sessionId);
      // Stop pressed while pi was still starting. There was nothing to abort
      // at the time, so it is honoured here instead of starting a compaction
      // that the user has already asked not to happen.
      if (this.cancelPending.delete(sessionId)) return;
      await client.compact();
    })();
    // Held so a Stop, and the next prompt, can wait for it — see abort().
    this.compacting.set(sessionId, run);
    try {
      await run;
    } finally {
      this.compacting.delete(sessionId);
      this.cancelPending.delete(sessionId);
      // No agent run, so no agent_settled arrives to clear it.
      this.mark(sessionId, "idle");
    }
  }

  /**
   * Push a change to pi's settings file into every session already open.
   *
   * Without this, tuning compaction would apply to sessions started later and
   * to nothing you can currently see. Failures are swallowed per session: one
   * client that cannot reload is not a reason to fail the save.
   */
  async refreshSettings(): Promise<number> {
    const live = [...this.live.values()];
    const done = await Promise.all(
      live.map((s) =>
        s.client
          .refreshSettings?.()
          .then(() => true)
          .catch(() => false) ?? Promise.resolve(false),
      ),
    );
    return done.filter(Boolean).length;
  }

  /** How far llama.cpp has got through the prompt. Straight out to the browser. */
  reportPrefill(sessionId: string, prefill: unknown): void {
    this.record(sessionId, "portal_prefill", prefill);
  }

  /**
   * Start pi for a session, once.
   *
   * Two callers arriving on a cold session both used to get past the check
   * below and both launch. The later `live.set()` then dropped the first on
   * the floor: a pi session still running, still subscribed to its own events,
   * with an executor nobody would ever clean up — and a Stop that reached
   * whichever one happened to be in the map.
   *
   * askNow() makes it easy to hit, because it starts a client of its own
   * before it prompts, and any two requests landing together on a session
   * nobody has opened yet will do it.
   */
  private ensureClient(sessionId: string): Promise<PiClient> {
    const existing = this.live.get(sessionId);
    if (existing?.client.running) return Promise.resolve(existing.client);

    const starting = this.starting.get(sessionId);
    if (starting) return starting;

    // Cleared whether it worked or not, so a failed start does not leave the
    // session unable to try again.
    const launch = this.startClient(sessionId).finally(() => this.starting.delete(sessionId));
    this.starting.set(sessionId, launch);
    return launch;
  }

  private async startClient(sessionId: string): Promise<PiClient> {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    const executor = buildExecutor(EXECUTOR_KIND, SESSION_ROOT);
    mkdirSync(path.join(SESSION_ROOT, sessionId), { recursive: true });

    // The session's own choices win over the portal defaults. Without this a
    // restart relaunched pi on the default model, quietly undoing the pick.
    const settings = getSettings();
    const client = await executor.launch({
      sessionId,
      workspacePath: session.workspace,
      provider: session.provider || settings.provider,
      model: session.model || settings.model || undefined,
      thinkingLevel: session.thinking_level || settings.thinkingLevel || undefined,
      sessionFile: session.pi_session_file || undefined,
      // Channels only. A task session works inside somebody's repository and
      // has no business rescheduling anything; a routine run is excluded too,
      // since a routine that can create routines can build a chain unwatched.
      routineTools: session.kind === "agent",
      // A routine run gets the report tool instead: it is the one kind of
      // session with nobody on the other end to read what it found.
      routineSlug: session.kind === "routine" ? session.routine_slug : undefined,
      // A routine may be exempted from the taint rules; nothing else can be.
      enforceTaint: session.kind === "routine" ? routineGuards(session.routine_slug) : true,
      // Re-read per call: the row is what the UI toggles, and a session that
      // has to be restarted to notice is a switch that looks broken.
      browserNow: () => {
        const row = getSession(sessionId) ?? session;
        return { allowed: browserAllowed(row), allowlist: browserAllowlist() };
      },
      // The session's settled role picks the context files; the live one gates
      // each tool call, so a group conversation follows whoever is speaking.
      role: session.role,
      whoNow: () => ({ role: this.speakerRole(sessionId), key: this.speakerKey(sessionId) }),
    });

    // pi writes the file lazily, so it usually does not exist yet at launch.
    // Recorded the first time it appears; from then on this exact conversation
    // is what gets reopened.
    let recordedFile = session.pi_session_file;
    const rememberSessionFile = () => {
      if (recordedFile) return;
      const file = client.sessionFile;
      if (!file) return;
      recordedFile = file;
      updateSession(sessionId, { pi_session_file: file });
    };
    rememberSessionFile();

    client.on("event", (msg) => {
      rememberSessionFile();
      this.record(sessionId, msg.type, msg);
      // Status follows pi's own run state rather than being guessed at the
      // moments the portal happens to know about. agent_start covers a run
      // nobody here asked for — a queued follow-up picked up on its own, a
      // routine, a message that arrived through a channel.
      if (msg.type === "agent_start") this.mark(sessionId, "running");
      // agent_settled, not agent_end: agent_end fires once per agent run, and
      // a run is followed by retries, auto-compaction and any queued message,
      // all of it still the model working. Settling on agent_end is what made
      // the Stop button disappear halfway through.
      if (msg.type === "agent_settled") this.mark(sessionId, "idle");
    });

    client.on("stderr", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.record(sessionId, "stderr", { text });
    });

    client.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.live.delete(sessionId);
      const current = getSession(sessionId);
      // A clean exit after a finished run is normal; anything else is a failure
      // worth surfacing in the UI rather than leaving as a silent stall.
      if (current?.status === "running") {
        const message = `pi exited unexpectedly (code=${code} signal=${signal})`;
        updateSession(sessionId, { status: "error", last_error: message });
        this.record(sessionId, "portal_status", { status: "error", error: message });
      }
      executor.cleanup?.(sessionId).catch(() => {});
    });

    this.live.set(sessionId, { client, executor });

    return client;
  }

  /**
   * Compaction in flight, per session. A cancelled one is still running until
   * pi has unwound it, and both Stop and the next prompt have to wait.
   */
  private compacting = new Map<string, Promise<void>>();

  /** A Stop that arrived before there was anything to stop. */
  private cancelPending = new Set<string>();

  /** Client startup in flight, so two callers cannot launch two of them. */
  private starting = new Map<string, Promise<PiClient>>();

  /** Move a session's status and tell whoever is watching, in that order. */
  private mark(sessionId: string, status: "running" | "idle"): void {
    if (getSession(sessionId)?.status === status) return;
    updateSession(sessionId, status === "running" ? { status, last_error: null } : { status });
    this.record(sessionId, "portal_status", { status });
  }

  /**
   * Submit a prompt.
   *
   * The session is marked running before anything else, because starting pi
   * for the first message in a session takes seconds and the composer has
   * nothing to show for them otherwise.
   */
  async prompt(sessionId: string, message: string): Promise<void> {
    this.mark(sessionId, "running");
    // Same reason as in abort(): a session mid-compaction is detached from
    // agent events, and a prompt started there is invisible.
    await this.settleCompaction(sessionId);
    // The compaction published idle on its way out, after this prompt had
    // already claimed the session. Without this the composer loses its Stop
    // and isBusy() reads false for however long pi takes to answer.
    this.mark(sessionId, "running");
    try {
      await this.submit(sessionId, message);
    } catch (e) {
      const failure = (e as Error).message;
      updateSession(sessionId, { status: "error", last_error: failure });
      this.record(sessionId, "portal_status", { status: "error", error: failure });
      throw e;
    }
  }

  private async submit(sessionId: string, message: string): Promise<void> {
    const client = await this.ensureClient(sessionId);

    // A slash command is an instruction to the agent, not something said in the
    // conversation, so it should not appear as a chat message — its dialog or
    // output is the feedback. Matched against the real command list rather than
    // a bare leading slash, so a message that merely starts with a path like
    // "/etc/hosts is wrong" is still shown.
    const isCommand = await this.looksLikeCommand(client, message);

    // Portal builtins never reach the model — they act on the session itself.
    const builtin = /^\/([\w-]+)\s*(.*)$/.exec(message.trim());
    const serverBuiltin = builtin ? await findServerBuiltin(builtin[1]) : undefined;
    if (serverBuiltin) {
      // Not awaited: /compact is a model call and would hold the request open.
      // Same contract as a prompt — accept it, report through the event stream.
      void (async () => {
        try {
          const text = await runBuiltin(serverBuiltin.name, builtin![2], client);
          this.record(sessionId, "portal_notice", { text });
        } catch (e) {
          this.record(sessionId, "portal_notice", { text: (e as Error).message, error: true });
        } finally {
          this.mark(sessionId, "idle");
        }
      })();
      return;
    }

    if (!isCommand) this.record(sessionId, "portal_prompt", { message });
    await client.prompt(message);
    // A slash command completes inside prompt() without ever starting an agent
    // turn, so no agent_settled arrives to clear the status. Settle it here
    // rather than leaving "working" on screen forever. Asking pi rather than
    // assuming: a message sent mid-run is queued and returns from prompt()
    // immediately, with the model still going.
    if (client.isIdle?.()) this.mark(sessionId, "idle");
  }

  /**
   * Prompt and wait for the answer.
   *
   * The inverse of prompt(), which returns the moment pi accepts a message —
   * the property the whole portal is built on. A channel needs the opposite:
   * somebody is sitting in a chat waiting for a reply, so this blocks until the
   * turn finishes and hands back what the agent said.
   *
   * Serialised per session. Two messages arriving in the same chat while the
   * agent is still working would otherwise interleave, and both callers would
   * see whichever agent_end came first.
   */
  ask(
    sessionId: string,
    message: string,
    opts: {
      timeoutMs?: number;
      /**
       * Relays what happens during the run — assistant prose as each stretch
       * completes, and the name of every tool as it starts.
       */
      onReply?: (text: string) => void | Promise<void>;
      /**
       * Whether prose goes through onReply as well as tool lines.
       *
       * When it does, ask() resolves with "" — it has all been handed over, and
       * returning it too would post everything twice. When it does not, only
       * tool lines are relayed and the prose comes back at the end, which is
       * what a channel showing activity but not partial answers wants.
       */
      streamText?: boolean;
      /**
       * An extension asking the user something mid-run. The browser draws a
       * modal for these; a channel has to ask in the chat and wait for the
       * next message, so it needs to know one is open.
       */
      onUi?: (request: any) => void;
    } = {}
  ): Promise<string> {
    const previous = this.asking.get(sessionId) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(() =>
        this.askNow(
          sessionId,
          message,
          opts.timeoutMs ?? 15 * 60_000,
          opts.onReply,
          opts.streamText,
          opts.onUi
        )
      );
    // Kept only while it is the newest, so a finished chain is not held forever.
    this.asking.set(sessionId, next);
    void next.catch(() => {}).finally(() => {
      if (this.asking.get(sessionId) === next) this.asking.delete(sessionId);
    });
    return next;
  }

  private async askNow(
    sessionId: string,
    message: string,
    timeoutMs: number,
    onReply?: (text: string) => void | Promise<void>,
    streamText = true,
    onUi?: (request: any) => void
  ): Promise<string> {
    await this.ensureClient(sessionId);

    // pi emits one assistant message per stretch of talking, broken up by tool
    // calls. Each is flushed as it closes so a channel can relay progress
    // rather than sitting silent while a long task runs.
    let current = "";
    const all: string[] = [];
    let settle: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;

    // Delivery is the channel's problem; a failure there must not take down the
    // run that produced it.
    const relay = (line: string) => void Promise.resolve(onReply?.(line)).catch(() => {});

    const flush = () => {
      const done = current.trim();
      current = "";
      if (!done) return;
      all.push(done);
      if (streamText) relay(done);
    };

    const onEvent = (row: { type: string; payload: string }) => {
      let payload: any = {};
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return;
      }
      switch (row.type) {
        case "message_update": {
          const inner = payload.assistantMessageEvent ?? {};
          // Thinking deltas are not the answer, and nobody in a chat wants them.
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            current += inner.delta;
          }
          break;
        }
        case "message_end":
          flush();
          break;

        case "tool_execution_start": {
          if (!onReply) break;
          // Prose first: a tool line landing mid-sentence reads badly.
          flush();
          const name = String(payload.toolName ?? payload.name ?? "tool");
          const detail = summarizeToolInput(payload);
          relay(detail ? `⚙ ${name} · ${detail}` : `⚙ ${name}`);
          break;
        }
        // Output from a builtin like /session or /compact. It is the answer as
        // far as whoever asked is concerned, so it goes back like any other.
        case "portal_notice":
          flush();
          if (typeof payload.text === "string" && payload.text.trim()) {
            all.push(payload.text.trim());
            if (streamText) relay(payload.text.trim());
          }
          break;

        // An extension is blocking on an answer. Handed straight over: whoever
        // is asking has to put the question somewhere a human will see it.
        case "extension_ui_request":
          flush();
          onUi?.(payload);
          break;

        // The dialog gave up waiting.
        case "extension_ui_cancel":
          onUi?.({ ...payload, cancelled: true });
          break;

        // Anything not closed by a message_end still belongs to the answer.
        // Not the end of the work, though — a retry, a compaction or a queued
        // message all come after it, and answering here cut them off.
        case "agent_end":
          flush();
          break;

        case "agent_settled":
          flush();
          settle?.();
          break;

        case "portal_status":
          if (payload.status === "error") fail?.(new Error(String(payload.error ?? "run failed")));
          // Settled on idle, not only on agent_end. A slash command completes
          // without ever starting an agent turn, so waiting for agent_end hung
          // until the timeout — and because asks are serialised per session,
          // every later message in that chat queued behind it.
          if (payload.status === "idle") {
            flush();
            settle?.();
          }
          break;
      }
    };

    // Attached before prompting: a fast reply would otherwise finish before
    // anyone was listening.
    this.on(`session:${sessionId}`, onEvent);
    const timer = setTimeout(
      () => fail?.(new Error(`The agent did not finish within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );

    try {
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      await this.prompt(sessionId, message);
      await finished;
      // Already relayed piece by piece; handing it back would post it twice.
      // Streamed already, so handing it back would post it twice.
      return onReply && streamText ? "" : all.join("\n\n").trim();
    } finally {
      clearTimeout(timer);
      this.off(`session:${sessionId}`, onEvent);
    }
  }

  /**
   * Whether a run is in flight. Checked before queueing an interrupt, which
   * would otherwise wait politely behind the very task it means to stop.
   */
  setSpeaker(sessionId: string, person: PersonRow): void {
    this.speaker.set(sessionId, person);
  }

  /**
   * The role in force right now.
   *
   * Falls back to the conversation's own role, never to "primary". Only channel
   * messages identify a speaker; a message sent through the portal's prompt
   * endpoint identifies nobody, and defaulting to primary there handed a
   * colleague's conversation full privileges — the conversation is still theirs,
   * and they still read whatever comes back.
   */
  speakerRole(sessionId: string): Role {
    const live = this.speaker.get(sessionId);
    if (live) return live.role;
    const row = getSession(sessionId);
    return (row?.role as Role) ?? "guest";
  }

  /** Who is speaking, surviving a restart via the session's own record. */
  speakerKey(sessionId: string): string | undefined {
    return this.speaker.get(sessionId)?.key ?? getSession(sessionId)?.last_person_key ?? undefined;
  }

  currentSpeaker(sessionId: string): PersonRow | undefined {
    return this.speaker.get(sessionId);
  }

  isBusy(sessionId: string): boolean {
    if (this.asking.has(sessionId)) return true;
    return getSession(sessionId)?.status === "running";
  }

  /** Access the live client for config reads and writes, starting pi if needed. */
  client(sessionId: string): Promise<PiClient> {
    return this.ensureClient(sessionId);
  }

  /** True when the message invokes a command pi actually knows about. */
  private async looksLikeCommand(client: PiClient, message: string): Promise<boolean> {
    const match = /^\/([\w:-]+)/.exec(message.trim());
    if (!match) return false;
    try {
      const commands = await client.getCommands();
      return commands.some((c) => c.name === match[1]);
    } catch {
      return false;
    }
  }

  /** Answer an extension dialog for a live session. */
  respondUi(sessionId: string, id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    return this.live.get(sessionId)?.client.respondUi(id, response) ?? false;
  }

  async abort(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.client.running) {
      // Nothing to abort yet — but a compaction waiting on pi to start is
      // still going to run, and the session already shows as working with a
      // Stop button. Remembered so it is cancelled the moment it could begin.
      if (this.compacting.has(sessionId)) this.cancelPending.add(sessionId);
      // Then waited for, like the path below. Returning here reported the Stop
      // as done while the session went on showing itself as compacting until pi
      // had finished starting — the same bounded wait, so the answer arrives
      // when the thing it describes is actually over.
      await this.settleCompaction(sessionId);
      return;
    }
    await live.client.abort().catch(() => {});
    // Cancelling a compaction does not end it. pi detaches the session from
    // agent events for the whole of compact() and reattaches in its own
    // finally, so between abortCompaction() returning and that finally running
    // the session is deaf. Publishing idle there lets the next prompt start
    // against a detached session — it would run with nothing reaching the
    // transcript, which is the failure this whole area keeps producing.
    await this.settleCompaction(sessionId);
    updateSession(sessionId, { status: "idle" });
    this.record(sessionId, "portal_status", { status: "idle", aborted: true });
  }

  /**
   * Resolves once any in-flight compaction has finished unwinding.
   *
   * Bounded, and it gives up by failing rather than by carrying on. A race
   * does not cancel what it lost to: the compaction is still running, the
   * session is still detached from agent events, and proceeding anyway would
   * start a turn that reaches nobody — which is the thing this wait exists to
   * prevent. Saying so leaves the session honestly busy, and the cancellation
   * Stop already issued still lands when the compaction finally unwinds.
   */
  private async settleCompaction(sessionId: string, timeoutMs = 60_000): Promise<void> {
    const inFlight = this.compacting.get(sessionId);
    if (!inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      // Waiting for it to be over, not for it to have worked. The failure
      // belongs to whoever asked for the compaction.
      inFlight.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      throw new Error(
        "The conversation is still being compacted. Nothing else can run until it finishes.",
      );
    }
  }

  async stop(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.client.dispose();
    this.live.delete(sessionId);
    await live.executor.cleanup?.(sessionId).catch(() => {});
  }

  /** Drop the running process so the next turn rebuilds it — used when a
   * session's role changes and its context files must be reloaded. */
  async shutdownSession(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
export { SESSION_ROOT, EXECUTOR_KIND };
