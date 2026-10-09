import type { PortalEvent } from "./api";
import { unwrapCall } from "./tool-activity";
import { argsSummary } from "./tool-args";
import { toolArgsOf, toolNameOf } from "./tool-payload";
import { msg, t } from "./i18n";
import { GENERATED_PICTURE_MARK } from "../../server/src/generated-picture";

/** A picture that went with a message, by the name the server keeps it under. */
export interface SentImage {
  name: string;
  mimeType: string;
}

const sentImages = (raw: unknown): SentImage[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((i): i is SentImage => typeof i?.name === "string" && typeof i?.mimeType === "string");
  return list.length ? list : undefined;
};

/** A picture the agent put in front of the person with show_image, or made or changed for them with generate_image or edit_image: its path in the chat's folder. */
export interface ShownPicture {
  path: string;
  title?: string;
}

/**
 * The picture a show_image, generate_image or edit_image call ended with, when it succeeded.
 *
 * All answer with a path in the chat's folder and a title. generate_image and
 * edit_image are taken only with the mark the portal's own tool sets: an
 * extension may bring a tool of that name, whose path is not one in the
 * chat's folder.
 */
export function shownPicture(payload: any): ShownPicture | undefined {
  if (payload?.isError) return undefined;
  const name = toolNameOf(payload);
  const details = payload?.result?.details;
  if (name === "generate_image" || name === "edit_image" ? details?.[GENERATED_PICTURE_MARK] !== true : name !== "show_image") return undefined;
  if (typeof details?.path !== "string" || !details.path) return undefined;
  return { path: details.path, ...(typeof details.title === "string" && details.title ? { title: details.title } : {}) };
}

/**
 * What answering took, for the line under a reply: the prompt it read and the
 * tokens it wrote, from the model's usage, and how fast, where that is known.
 * llama.cpp measures both speeds itself; for another provider the answer's is
 * worked out from when its first and last tokens came, and prefill is unknown.
 */
export interface ReplyStats {
  /** The whole prompt, cached part included. */
  input?: number;
  /** Of `input`, what came from a cache rather than being read again. */
  cached?: number;
  output?: number;
  /** Tokens written per second. */
  outputPerSecond?: number;
  outputMs?: number;
  /** Of `input`, what was read (prefilled), and how fast and in how long: the cached part is not read. */
  read?: number;
  promptPerSecond?: number;
  promptMs?: number;
  /** Speculative decoding: tokens drafted and how many were kept. */
  draft?: { tokens: number; accepted: number };
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The figures an assistant message_end carries: see ReplyStats. Undefined when it carries none. */
export function replyStats(payload: any, endedAt?: number): ReplyStats | undefined {
  const usage = payload?.message?.usage;
  const timings = payload?.timings;
  const stats: ReplyStats = {};
  const prompt = (count(usage?.input) ?? 0) + (count(usage?.cacheRead) ?? 0) + (count(usage?.cacheWrite) ?? 0);
  if (prompt) stats.input = prompt;
  if (count(usage?.cacheRead)) stats.cached = usage.cacheRead;
  if (count(usage?.output)) stats.output = usage.output;
  if (timings && count(timings.outputPerSecond)) {
    stats.outputPerSecond = timings.outputPerSecond;
    stats.outputMs = count(timings.outputMs);
    // Prefill is only a speed when something was read: an answer from a prompt wholly cached read nothing.
    if (count(timings.promptTokens) && count(timings.promptPerSecond)) {
      stats.read = timings.promptTokens;
      stats.promptPerSecond = timings.promptPerSecond;
      stats.promptMs = count(timings.promptMs);
    }
    if (count(timings.draftTokens)) stats.draft = { tokens: timings.draftTokens, accepted: count(timings.draftAccepted) ?? 0 };
    // llama.cpp's own counts where pi's usage has none.
    stats.input ??= (count(timings.promptTokens) ?? 0) + (count(timings.cachedTokens) ?? 0) || undefined;
    if (!stats.cached && count(timings.cachedTokens)) stats.cached = timings.cachedTokens;
    stats.output ??= count(timings.outputTokens);
  } else if (stats.output && typeof payload?.firstTokenAt === "number" && endedAt !== undefined && endedAt > payload.firstTokenAt) {
    stats.outputMs = endedAt - payload.firstTokenAt;
    stats.outputPerSecond = stats.output / (stats.outputMs / 1000);
  }
  return Object.keys(stats).length ? stats : undefined;
}

export type Item =
  /**
   * `queued`: sent into a run, and not taken in by pi yet — after the current
   * step when `steer`, at the end of the run otherwise. `unsent`: the run was
   * stopped first, or the portal restarted, so it never reached pi — or, for
   * `unsure`, the portal restarted and could not tell whether it had.
   */
  | {
      kind: "user";
      id: string;
      seq: number;
      text: string;
      audio?: boolean;
      images?: SentImage[];
      queued?: boolean;
      steer?: boolean;
      unsent?: "stopped" | "restarted" | "unsure";
    }
  /** `thinkingSince`/`thinkingUntil`: when the reasoning started and last grew, for "Thought for 12s". */
  /** `final`: the stretch that ends an answer, where its Copy goes. */
  /** `stats`: what writing it took, from its message_end; see ReplyStats. */
  | { kind: "assistant"; id: string; text: string; thinking: string; done: boolean; audio?: boolean; final?: true; thinkingSince?: number; thinkingUntil?: number; stats?: ReplyStats }
  /**
   * `args`: what the tool was called with, whole. `output`: the text it gave
   * back — as it streams, then as it ended — kept to the last TOOL_OUTPUT_MAX.
   */
  | {
      kind: "tool";
      id: string;
      name: string;
      callId?: string;
      status: "running" | "done" | "error";
      detail?: string;
      picture?: ShownPicture;
      /** The seq of the end that showed `picture`: what versions its URL, so that every place that draws it asks for the same one (see PictureCall). */
      pictureSeq?: number;
      /** A call of the portal's own generate_image or edit_image, as its start says (see generated-picture.ts), not of a tool of that name an extension brings. */
      portalPicture?: true;
      args?: unknown;
      output?: string;
      /** How many lines `output` had before it was cut to its end. */
      outputLines?: number;
      /** What the tool reported about itself beside its text — an extension's progress, its subagent's steps. */
      details?: unknown;
      /** How many updates it streamed while it ran: a tool that reports as it goes is doing something worth watching. */
      updates?: number;
      /** The guard flagged what it returned as a suspected prompt injection: its envelope's id, the signs, and the message of the turn it is in. */
      flagged?: { id: string; signals: string[]; turnSeq?: number };
      /** The run ended with this call still open: it never said how it came out. */
      interrupted?: boolean;
      since?: number;
      until?: number;
    }
  /** The conversation summarized to make room, while that runs and after. */
  | { kind: "compaction"; id: string; status: "running" | "done" | "failed"; tokensBefore?: number; summary?: string; since?: number; until?: number }
  /** `portal`: the portal's own words, a msg() key translated where it is drawn; otherwise text as it came. */
  | { kind: "notice"; id: string; text: string; tone: "info" | "warn" | "error"; portal?: true }
  /**
   * A slash command sent, and how it went: `done` when it showed something of
   * its own, `quiet` when it ran and showed nothing, `started`/`queued` when it
   * became a run, `failed` with why.
   */
  | { kind: "command"; id: string; seq: number; text: string; state: CommandState; error?: string };

export type CommandState = "running" | "done" | "quiet" | "started" | "queued" | "failed";

/** Enough of a tool's output to read in the transcript; the whole of it is in the agent terminal. */
const TOOL_OUTPUT_MAX = 60_000;

/**
 * Where, in a text that is still being written, the end it shows starts: the
 * start so far, moved on only once the text from there has grown long, and
 * then to a line break, so the lines after it wrap as they did.
 *
 * A start that followed the newest token — the last 600 characters, say — is
 * a different text with each one: it begins at another word, so every line
 * wraps anew and what is on show jumps back and forth, which at a fast
 * model's speed read as the text racing rather than growing. The text is
 * laid out from the same start instead, and the window only cuts off its
 * top. Inside a paragraph with no line break to move on to, it is laid out
 * from the same start for much longer, `longest` characters, and only then cut
 * at a word, leaving little: that reflows what is shown, so it is rare (once
 * in about `longest`, tens of seconds of even a fast model's reasoning).
 */
export function shownFrom(text: string, from: number, most = 6000, longest = 30000): number {
  if (from > text.length) return 0;
  if (text.length - from <= most) return from;
  // The last line break that still leaves far more than the window shows.
  const lineBreak = text.lastIndexOf("\n", text.length - 600);
  if (lineBreak >= from) return lineBreak + 1;
  if (text.length - from <= longest) return from;
  const space = text.indexOf(" ", text.length - 600);
  return space >= 0 ? space + 1 : text.length - 600;
}

/** Lines in a text, not counting a newline at its very end. */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Keep the end of a tool's output on its item, and how long it was whole. */
function setToolOutput(item: Extract<Item, { kind: "tool" }>, text: string) {
  item.output = text.slice(-TOOL_OUTPUT_MAX);
  if (text.length > TOOL_OUTPUT_MAX) item.outputLines = lineCount(text);
  else delete item.outputLines;
}

/** Text without the colour and cursor codes a terminal would act on. */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * A result the guard flagged as a suspected prompt injection: the first line of
 * the envelope it put around it (server/src/pi/guard.ts, flaggedResult).
 */
export function flaggedOf(text: string): { id: string; signals: string[] } | undefined {
  const match = /^<<<untrusted:([0-9a-f]{16})>>> \(suspected prompt injection: ([a-z, -]+)\)/.exec(text);
  return match ? { id: match[1], signals: match[2].split(", ") } : undefined;
}

/** The text of a tool result, however pi shaped it. */
export function toolOutputText(result: any): string | undefined {
  if (typeof result === "string") return result;
  const content = result?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
  return text;
}

type UserItem = Extract<Item, { kind: "user" }>;
type AssistantItem = Extract<Item, { kind: "assistant" }>;

/** A message as its portal_prompt payload describes it. */
function userItem(seq: number, p: any): UserItem {
  const raw = String(p?.message ?? "");
  const tagged = raw.startsWith("[Audio mode]\n");
  const images = sentImages(p?.images);
  return {
    kind: "user",
    id: `u${seq}`,
    seq,
    text: tagged ? raw.slice("[Audio mode]\n".length) : raw,
    audio: p?.voice === true || tagged,
    ...(images ? { images } : {}),
    ...(p?.steer === true ? { steer: true } : {}),
  };
}

/** Whether two values hold the same, however deep: what an entry is made of is strings, numbers and plain objects. */
function sameValue(a: any, b: any, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || depth > 8 || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && sameValue(a[key], b[key], depth + 1));
}

/**
 * The entries as they were before wherever one has not changed.
 *
 * `buildTranscript` makes every entry anew from the events, so every row of a
 * conversation looks changed to the one drawing it, for each word of a reply.
 * Handing back the earlier entry where it says the same lets a row that is
 * drawn only when its entry changes be left alone.
 */
export function keepItems(was: Item[], next: Item[]): Item[] {
  if (!was.length) return next;
  const before = new Map<string, Item>();
  for (const item of was) before.set(item.id, item);
  return next.map((item) => {
    const old = before.get(item.id);
    return old && sameValue(old, item) ? old : item;
  });
}

/**
 * Fold pi's event stream into renderable turns.
 *
 * Deliberately tolerant: pi emits more event types than we render, and shapes
 * vary by version. Anything unrecognised is skipped rather than breaking the
 * transcript — a task that ran fine shouldn't look broken because of one
 * unexpected field.
 */
export function buildTranscript(events: PortalEvent[], options: { ended?: boolean } = {}): Item[] {
  const items: Item[] = [];
  let audioReply = false;
  let current: AssistantItem | null = null;
  // Where the answer being given ends so far, for its Copy: the last stretch
  // of it that said something and was done, with no tool call after it.
  //
  // A turn with tool calls in the middle closes the assistant item before each
  // one and opens a new one after, so a single answer can be several bubbles —
  // one per paragraph around a tool. Offering Copy on all of them is a button
  // under every paragraph; only the last has the whole of what was said.
  //
  // And only when the answer ends there. A paragraph that calls a tool is the
  // agent saying what it is about to do, not an answer — a Copy under it sat
  // between the words and the call like a stray gap — even when the call never
  // ran. So is one with the next stretch already being written, reasoning or
  // not. One an error cut off is not the answer either: pi drops it and tries
  // again, and a run that died leaves its stretch without an end at all.
  let answerEnd: AssistantItem | null = null;
  // Sent mid-run and not yet taken in. Put where pi took it in — where the
  // agent read it — rather than where it was sent, which is the middle of a
  // reply it had nothing to do with.
  const waiting = new Map<number, UserItem>();
  // A command's failure said as a notice, by the command's seq: its line says
  // it once the command ends, and the notice goes.
  const failures = new Map<number, Item>();
  // Where a message sent into a run was placed. The prompt it was sent as can
  // be older than the events loaded — a long run, and a page that loads only
  // the end — so the placing event carries it too, and it stands in.
  //
  // One sent as starting a run of its own, that pi queued into a run begun in
  // the same moment, is already in the list where it was sent, and moves.
  const placed = (seq: number, prompt: unknown): UserItem | undefined => {
    const item = waiting.get(seq);
    if (item) {
      waiting.delete(seq);
      return item;
    }
    const shown = items.findIndex((it) => it.kind === "user" && it.seq === seq);
    if (shown >= 0) return items.splice(shown, 1)[0] as UserItem;
    return prompt && typeof prompt === "object" ? userItem(seq, prompt) : undefined;
  };

  // What was last shown when the run began: see openReply.
  let sealed: Item | undefined;

  // A reply to write into. The one with this id when it is the last thing
  // shown: it was closed early — a status that said the run was over while it
  // was not — and a second item with its id would split it in two. Nor is its
  // answer over after all.
  //
  // Not one from before the run: a new run is a new message, whatever id its
  // stream has.
  const openReply = (id: string): AssistantItem => {
    answerEnd = null;
    const last = items.at(-1);
    if (last?.kind === "assistant" && last.id === id && last !== sealed) {
      last.done = false;
      delete last.final;
      return last;
    }
    const reply = { kind: "assistant" as const, id, text: "", thinking: "", done: false, audio: audioReply };
    items.push(reply);
    return reply;
  };

  const closeCurrent = () => {
    if (current) {
      current.done = true;
      current = null;
    }
  };

  // The answer so far is over: the stretch that ended it keeps its Copy.
  const closeAnswer = () => {
    if (answerEnd) answerEnd.final = true;
    answerEnd = null;
  };

  // The run is over, so nothing in it is still going. A call whose end never
  // came — the process died, the portal restarted, a stop cut it short — would
  // otherwise spin for good; it says it was cut off instead.
  const settle = () => {
    closeCurrent();
    for (const it of items) {
      if (it.kind === "tool" && it.status === "running") {
        it.status = "error";
        it.interrupted = true;
      } else if (it.kind === "compaction" && it.status === "running") it.status = "failed";
      // Not a command: it runs beside a run, and can still be waiting on a
      // dialog when the run ends. The portal writes its end, even for one a
      // restart cut off.
    }
  };

  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      case "portal_prompt": {
        const item = userItem(ev.seq, p);
        if (p.queued === true) {
          waiting.set(ev.seq, item);
          break;
        }
        closeCurrent();
        audioReply = item.audio === true;
        items.push(item);
        break;
      }

      case "portal_taken": {
        const item = placed(Number(p.seq), p.prompt);
        if (!item) break;
        closeCurrent();
        audioReply = item.audio === true;
        items.push(item);
        break;
      }

      // Stopped before pi took them in: they never reached it. Shown where the
      // run was stopped, as not sent, so the words are not simply gone.
      case "portal_unsent":
        if (!Array.isArray(p.seqs)) break;
        for (const seq of p.seqs) {
          const item = placed(Number(seq), p.prompts?.[seq]);
          if (!item) continue;
          closeCurrent();
          items.push({ ...item, unsent: p.unsure === true ? "unsure" : p.restarted === true ? "restarted" : "stopped" });
        }
        break;

      case "message_update": {
        const inner = p.assistantMessageEvent ?? {};
        const delta = typeof inner.delta === "string" ? inner.delta : "";
        if (!delta) break;
        if (!current) current = openReply(`a${p.streamId ?? ev.seq}`);
        if (inner.type === "thinking_delta") {
          current.thinking += delta;
          if (ev.at !== undefined) {
            current.thinkingSince ??= ev.at;
            current.thinkingUntil = ev.at;
          }
        }
        else if (inner.type === "text_delta") current.text += delta;
        break;
      }

      // Something said to the agent — the person's words, a command's, an
      // extension's — begins an answer to it, and so ends the one before. Here
      // rather than where the portal sent it: pi takes some in mid-run, a
      // queued command or an extension's follow-up, with nothing else to mark
      // it. A retry after an error starts a run with no message, and leaves
      // the cut-off stretch before it be.
      case "message_start":
        if (p.message?.role === "user" || p.message?.role === "custom") closeAnswer();
        break;

      case "message_snapshot":
      case "message_end": {
        const message = p.message;
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("");
          const thinking = message.content.filter((c: any) => c?.type === "thinking").map((c: any) => c.thinking ?? "").join("");
          if (!current) current = openReply(`a${p.streamId ?? ev.seq}`);
          current.text = text;
          // The server keeps when the reasoning ran: the deltas that timed it
          // are gone once the message ends, and after a reload.
          if (typeof p.thinkingSince === "number" && typeof p.thinkingUntil === "number") {
            current.thinkingSince = Math.min(current.thinkingSince ?? p.thinkingSince, p.thinkingSince);
            current.thinkingUntil = Math.max(current.thinkingUntil ?? p.thinkingUntil, p.thinkingUntil);
          } else if (ev.at !== undefined && thinking !== current.thinking) {
            current.thinkingSince ??= ev.at;
            current.thinkingUntil = ev.at;
          }
          current.thinking = thinking;
          if (ev.type === "message_end") {
            const stats = replyStats(p, ev.at);
            if (stats) current.stats = stats;
            const calls = message.content.some((c: any) => c?.type === "toolCall");
            if (calls || message.stopReason === "error") answerEnd = null;
            else if (text) answerEnd = current;
          }
        }
        // What an extension puts in the conversation for people to read —
        // pi.sendMessage with display on. pi's TUI draws it; so does this. One
        // that does not say so is for the model, as pi's TUI takes it.
        if (ev.type === "message_end" && message?.role === "custom" && message.display) {
          const text = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content) ? message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n") : "";
          if (text.trim()) items.push({ kind: "notice", id: `m${ev.seq}`, text: stripAnsi(text).trim(), tone: "info" });
          break;
        }
        if (ev.type === "message_end") closeCurrent();
        break;
      }

      case "tool_execution_start": {
        closeCurrent();
        answerEnd = null;
        const args = toolArgsOf(p);
        items.push({
          kind: "tool",
          id: `t${ev.seq}`,
          callId: typeof p.toolCallId === "string" ? p.toolCallId : undefined,
          name: toolNameOf(p, "tool"),
          status: "running",
          detail: summarizeToolInput(p),
          ...(p[GENERATED_PICTURE_MARK] === true ? { portalPicture: true as const } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(ev.at !== undefined ? { since: ev.at } : {}),
        });
        break;
      }

      case "tool_execution_update": {
        const tool = findRunningTool(items, p);
        const partial = p.partialResult ?? p.result;
        const text = toolOutputText(partial);
        if (tool && typeof text === "string") setToolOutput(tool, text);
        if (tool) {
          tool.updates = (tool.updates ?? 0) + 1;
          if (partial?.details !== undefined) tool.details = partial.details;
        }
        break;
      }

      case "compaction_start":
        items.push({ kind: "compaction", id: `c${ev.seq}`, status: "running", ...(ev.at !== undefined ? { since: ev.at } : {}) });
        break;

      case "compaction_end": {
        let open: Extract<Item, { kind: "compaction" }> | undefined;
        for (let i = items.length - 1; i >= 0 && !open; i--) {
          const it = items[i];
          if (it.kind === "compaction" && it.status === "running") open = it;
        }
        // The start can be on a page not loaded yet.
        if (!open) items.push((open = { kind: "compaction", id: `c${ev.seq}`, status: "running" }));
        const result = p.result ?? {};
        open.status = p.aborted || p.errorMessage ? "failed" : "done";
        if (ev.at !== undefined) open.until = ev.at;
        if (typeof result.tokensBefore === "number") open.tokensBefore = result.tokensBefore;
        if (typeof result.summary === "string" && result.summary) open.summary = result.summary;
        break;
      }

      case "tool_execution_end": {
        // Close the most recent still-running tool of the same name. By its id,
        // one taken for cut off too: its end is what really happened.
        const name = toolNameOf(p, "tool");
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" &&
              (p.toolCallId ? it.callId === p.toolCallId && (it.status === "running" || it.interrupted) : it.status === "running" && it.name === name)) {
            it.status = p.isError || p.error ? "error" : "done";
            delete it.interrupted;
            if (ev.at !== undefined) it.until = ev.at;
            const text = toolOutputText(p.result);
            if (typeof text === "string" && text) setToolOutput(it, text);
            const flag = typeof text === "string" ? flaggedOf(text) : undefined;
            if (flag) {
              let turn: UserItem | undefined;
              for (let j = items.length - 1; j >= 0 && !turn; j--) { const item = items[j]; if (item.kind === "user") turn = item; }
              it.flagged = { ...flag, ...(turn ? { turnSeq: turn.seq } : {}) };
            }
            if (p.result?.details !== undefined) it.details = p.result.details;
            // Its updates were live only; how many there were is kept on its end.
            if (typeof p.updates === "number") it.updates = Math.max(it.updates ?? 0, p.updates);
            const picture = shownPicture(p);
            if (picture) {
              it.picture = picture;
              it.pictureSeq = ev.seq;
            }
            break;
          }
        }
        break;
      }

      // Not closing the answer being written: a command runs beside a run, and
      // the answer goes on after it.
      case "portal_command":
        items.push({ kind: "command", id: `c${ev.seq}`, seq: ev.seq, text: String(p.text ?? ""), state: "running" });
        break;

      case "portal_command_end": {
        const it = items.find((x): x is Extract<Item, { kind: "command" }> => x.kind === "command" && x.seq === p.of);
        if (!it) break;
        if (typeof p.error === "string") {
          it.state = "failed";
          it.error = p.error;
          // Its line says it now, so its own notice need not.
          const notice = failures.get(it.seq);
          if (notice) items.splice(items.indexOf(notice), 1);
        } else it.state = p.quiet ? "quiet" : p.outcome === "started" ? "started" : p.outcome === "queued" ? "queued" : "done";
        break;
      }

      // Output from a builtin like /session or /compact — pi never saw it.
      case "portal_notice":
      {
        // A command's own failure: its line says it, with the reason, once it
        // ends. Shown until then: an end that never came must not hide it.
        const own = p.error && typeof p.of === "number" ? items.find((x) => x.kind === "command" && x.seq === p.of) : undefined;
        if (own?.kind === "command" && own.state === "failed") break;
        const notice: Item = {
          kind: "notice",
          id: `n${ev.seq}`,
          text: String(p.text ?? ""),
          tone: p.error ? "error" : p.warning ? "warn" : "info",
        };
        items.push(notice);
        if (own) failures.set(p.of, notice);
        break;
      }

      case "portal_status":
        if (p.status === "error" && p.error) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: String(p.error), tone: "error" });
        }
        if (p.status === "idle" && p.aborted) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: msg("Aborted"), tone: "info", portal: true });
        }
        if (typeof p.status === "string" && p.status !== "running") settle();
        break;

      case "agent_end":
        settle();
        break;

      // A new run: a reply or a tool still open from before it can only be one
      // whose run died without saying so (a portal restart that recorded
      // nothing). Its words are not the new run's to go on with.
      case "agent_start":
        closeCurrent();
        sealed = items.at(-1);
        for (const it of items) {
          if (it.kind === "tool" && it.status === "running") {
            it.status = "error";
            it.interrupted = true;
          }
        }
        break;

      default:
        break;
    }
  }

  // The caller knows the run is over even where no event says so: a portal
  // restarted mid-run records nothing.
  if (options.ended) settle();

  // Anything still open belongs to a run in flight, and what is waiting to go
  // into it comes after.
  for (const item of waiting.values()) items.push({ ...item, queued: true });
  // The answer being given last ends where the chat does, once it is written.
  closeAnswer();
  return items;
}

/** The call an update belongs to: by its id, or else the newest one of that name still running. */
function findRunningTool(items: Item[], p: any): Extract<Item, { kind: "tool" }> | undefined {
  const name = toolNameOf(p);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "tool") continue;
    if (p.toolCallId ? it.callId === p.toolCallId : it.status === "running" && (!name || it.name === name)) return it;
  }
  return undefined;
}

function summarizeToolInput(p: any): string | undefined {
  const raw = toolArgsOf(p);
  const call = unwrapCall(toolNameOf(p), raw);
  // Through the MCP adapter, what the tool inside was given.
  return argsSummary(call.name !== toolNameOf(p) ? call.input : raw);
}

/**
 * Which phase the agent is in. These are ids that the status line, the voice
 * stage and the progress card compare against, not wording: each of them says
 * what the phase is called to the user in its own words, so rewording one here
 * is a compile error where it is read rather than a card that quietly goes.
 */
export type ActivityLabel =
  | "compacting the conversation"
  | "loading the model"
  | "processing the prompt"
  | "retrying after an error"
  | "thinking"
  | "writing the reply"
  | "working"
  // A tool, by its name.
  | `running ${string}`;

export interface Activity {
  label: ActivityLabel;
  /** When this phase started, for the elapsed counter. */
  since?: number;
  /** Prefill, when llama.cpp is reporting it. */
  prefill?: { total: number; cache: number; processed: number };
  /** The model being loaded, while `label` is "loading the model". */
  model?: string;
}

/** "800", "6k", "20.5k": a count of tokens. */
export const formatTokens = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);

/** "12s", "2m 05s": how long a phase has been going. */
export const formatElapsed = (s: number) =>
  s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;

const PROMPT_LABELS = [msg("Reading the conversation"), msg("Reviewing the context"), msg("Preparing to respond")];

/** What reading the prompt is called `seconds` in: it moves on every few seconds, so a long one is seen to be going. */
export const promptLabel = (seconds: number) => t(PROMPT_LABELS[Math.floor(seconds / 4) % PROMPT_LABELS.length]);

/** How far prefill has got: tokens read, counting the cached prefix, and that as a percentage when there is a total. */
export function prefillShare(prefill: Activity["prefill"]): { done: number; percent?: number } {
  const total = prefill?.total ?? 0;
  const done = Math.max(0, Math.min(total, prefill?.processed ?? 0));
  return { done, ...(total > 0 ? { percent: Math.round((done / total) * 100) } : {}) };
}

/**
 * What is happening right now, read backwards from the end of the stream.
 *
 * "Working…" is true and useless: the wait that prompts the question is the one
 * before the first token, where a local server is processing the prompt and
 * nothing at all is emitted. The most recent event that means something is the
 * answer, so this stops at the first one it recognises rather than folding the
 * whole history.
 */
export function activity(events: PortalEvent[]): Activity {
  let prefill: Activity["prefill"];
  // Walking backwards, a `ready` is met before the `loading` it ends.
  let loaded = false;
  // Compaction can emit its own model events; retain its identity until it ends.
  const compact = [...events].reverse().find(ev => ['compaction_start', 'compaction_end', 'agent_end', 'portal_prompt'].includes(ev.type));
  if (compact?.type === 'compaction_start') {
    return { label: 'compacting the conversation', since: compact.at };
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const p = (ev.payload ?? {}) as Record<string, any>;
    switch (ev.type) {
      // Kept and carried down: progress arrives interleaved with the empty
      // deltas that llama.cpp sends while it works, and the newest one wins.
      case "portal_prefill":
        if (!prefill) {
          prefill = { total: p.total ?? 0, cache: p.cache ?? 0, processed: p.processed ?? 0 };

        }
        break;

      // Before any prefill: once the prompt is being read, the model is up.
      case "portal_model":
        if (p.state === "ready") loaded = true;
        else if (p.state === "loading" && !loaded && !prefill) {
          return { label: "loading the model", since: ev.at, ...(typeof p.model === "string" && p.model ? { model: p.model } : {}) };
        }
        break;

      case "tool_execution_start":
        return { label: `running ${p.toolName ?? "a tool"}`, since: ev.at };

      case "tool_execution_end":
      case "message_end":
      case "turn_end":
      case "compaction_end":
        return { label: "thinking", since: ev.at };

      case "message_snapshot": {
        const blocks = Array.isArray(p.message?.content) ? p.message.content : [];
        // A tool call being written counts: its arguments are the reply, for as long as they take.
        const last = [...blocks].reverse().find((c: any) => c?.type === 'toolCall' || c?.type === 'text' && c.text || c?.type === 'thinking' && c.thinking);
        if (last) return { label: last.type === 'thinking' ? 'thinking' : 'writing the reply', since: ev.at };
        break;
      }

      case "message_update":
        if (p.assistantMessageEvent?.delta) {
          return { label: p.assistantMessageEvent.type === 'thinking_delta' ? 'thinking' : 'writing the reply', since: ev.at };
        }
        break;
      case "message_start":
        if (p.message?.role === 'assistant') return { label: 'processing the prompt', since: ev.at, prefill };
        break;

      case "compaction_start":
        return { label: "compacting the conversation", since: ev.at };

      case "auto_retry_start":
        return { label: "retrying after an error", since: ev.at };

      // Nothing has come back yet, so the model is still reading the prompt.
      case "turn_start":
      case "agent_start":
        return { label: "processing the prompt", since: ev.at, prefill };
      // One sent into the run has not been read yet; the run goes on as it was.
      case "portal_prompt":
        if (p.queued === true) break;
        return { label: "processing the prompt", since: ev.at, prefill };
    }
  }
  return { label: "working" };
}
