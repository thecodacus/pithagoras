import { nanoid } from "nanoid";

/**
 * What an extension's server half tells the pages that listen to a topic of its
 * own, on any page of the portal, with or without a chat open on it
 * (`portal.push` and `portal.onListen` in extension-host.ts).
 *
 * A page opens one stream for all its extensions (`GET /api/pushes`), and asks to
 * listen to a topic on it (`POST /api/pushes/:stream/listen`): the stream is the
 * page's, the topics are the extension's. A topic is only ever the extension's
 * own: what is sent, and what is listened to, is looked up by the extension's
 * name and the topic together, so one extension cannot hear another's, nor send
 * under its name. Who may listen to a topic is the extension's to say
 * (`onListen`), and what a page is not allowed to hear it is not sent, not even
 * for the moment its handler is still deciding.
 */

/** What an extension's `onListen` is handed to tell the one page that began to listen. */
export interface PageListener {
  send(data: unknown): void;
}
/** Refuses (`false`), or lets listen and says what to do when the page stops (a function). */
export type ListenHandler = (topic: string, page: PageListener) => void | false | (() => void) | Promise<void | false | (() => void)>;

/** The longest topic: a topic is a name, and it is kept in every page's table. */
export const MAX_TOPIC = 200;
/** How many topics one page may listen to, and how many pages there may be: nothing here is for an unbounded number. */
const MAX_LISTENING = 500;
const MAX_STREAMS = 200;
/** How much a topic holds for a page whose handler has not answered yet. */
const HELD_MOST = 200;
/** How long an extension's handler may take to say whether a page may listen. */
const DECIDE_MS = 10_000;

export const validTopic = (topic: unknown): topic is string =>
  typeof topic === "string" && topic.length > 0 && topic.length <= MAX_TOPIC && !/[\u0000-\u001f\u007f]/.test(topic);

interface Listening {
  extension: string;
  topic: string;
  /** Before its extension has said yes, what is pushed is held: a page that is refused hears none of it. */
  held: string[] | null;
  /** What the extension's handlers returned to be called when the page stops. */
  leave: (() => void)[];
  ended: boolean;
  /** The decision, for a second ask for the same topic while the first is being decided. */
  decided: Promise<boolean>;
  /** The page's name for this ask: a leave that names another one is for a listening that was already replaced. */
  token?: string;
}

interface Stream {
  id: string;
  write(text: string): void;
  listening: Map<string, Listening>;
}

const streams = new Map<string, Stream>();
/** What each extension said about who may listen, by its name. */
const gates = new Map<string, ListenHandler[]>();

const keyOf = (extension: string, topic: string) => JSON.stringify([extension, topic]);

function wire(extension: string, topic: string, data: unknown): string | undefined {
  try {
    return `event: push\ndata: ${JSON.stringify({ extension, topic, data: data ?? null })}\n\n`;
  } catch (e) {
    console.error(`[extension ${extension}] what it said to the pages listening to "${topic}" could not be sent:`, e);
    return undefined;
  }
}

/** Something to the one page `entry` belongs to: held while it is not yet allowed to hear it. */
function toPage(stream: Stream, entry: Listening, text: string): void {
  if (entry.ended) return;
  if (entry.held) {
    if (entry.held.length < HELD_MOST) entry.held.push(text);
    return;
  }
  stream.write(text);
}

/** Every page that listens to `topic` of `extension` is told `data`. */
export function pushToPages(extension: string, topic: string, data: unknown): void {
  const text = wire(extension, topic, data);
  if (!text) return;
  const key = keyOf(extension, topic);
  for (const stream of [...streams.values()]) {
    const entry = stream.listening.get(key);
    if (entry) toPage(stream, entry, text);
  }
}

/** Another rule about who may listen to the topics of `extension`. */
export function addGate(extension: string, handler: ListenHandler): void {
  const list = gates.get(extension) ?? [];
  list.push(handler);
  gates.set(extension, list);
}

/** A page's stream is open. Undefined where there are too many already. */
export function openStream(write: (text: string) => void): { id: string; close: () => void } | undefined {
  if (streams.size >= MAX_STREAMS) return undefined;
  const stream: Stream = { id: nanoid(16), write, listening: new Map() };
  streams.set(stream.id, stream);
  return {
    id: stream.id,
    close: () => {
      streams.delete(stream.id);
      for (const entry of stream.listening.values()) end(entry);
      stream.listening.clear();
    },
  };
}

const quietly = (extension: string, what: string, fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error(`[extension ${extension}] ${what} failed:`, e);
  }
};

const STOPPING = "stopping what it did for a page that listened";

/** A listening is over: what its extension asked to be done then is done, once each (a handler that answers late is seen to as well). */
function end(entry: Listening): void {
  entry.ended = true;
  entry.held = null;
  for (const leave of entry.leave.splice(0)) quietly(entry.extension, STOPPING, leave);
}

/** What a handler gave back to be done when the page stops: kept for that, or done at once when the listening is over already. */
function keepCleanup(entry: Listening, cleanup: unknown): void {
  if (typeof cleanup !== "function") return;
  if (entry.ended) quietly(entry.extension, STOPPING, cleanup as () => void);
  else entry.leave.push(cleanup as () => void);
}

/** `work`, or false once it has taken longer than DECIDE_MS. */
function inTime<T>(work: Promise<T>): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(resolve, DECIDE_MS, "late");
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** `lost`: the extension stopped while the page was being let in, so it asks again. */
export type Listened = "listening" | "refused" | "no-stream" | "too-many" | "lost";

/**
 * The page on stream `id` asks to listen to `topic` of `extension`. The extension's handlers decide (none: any page
 * may, for the portal has one login and a topic is the extension's own to name); they are given a way to tell this page
 * alone, which is how it hears where things stand first. Whatever is pushed meanwhile follows once they have answered.
 *
 * The page names each ask (`token`). The same one asked again is the one listening, as it was. Another one is a page
 * that stopped listening and began again, whose two requests came in the wrong order: it replaces the listening, which
 * is ended, and the handlers are asked anew, so the page is told where things stand again.
 */
export async function listen(id: string, extension: string, topic: string, token?: string): Promise<Listened> {
  const stream = streams.get(id);
  if (!stream) return "no-stream";
  const key = keyOf(extension, topic);
  const known = stream.listening.get(key);
  if (known && (token === undefined || token === known.token)) return (await known.decided) ? "listening" : "refused";
  if (known) {
    stream.listening.delete(key);
    end(known);
  } else if (stream.listening.size >= MAX_LISTENING) {
    return "too-many";
  }
  const entry: Listening = { extension, topic, held: [], leave: [], ended: false, decided: Promise.resolve(false), token };
  const page: PageListener = {
    send(data) {
      const text = wire(extension, topic, data);
      if (!text || entry.ended) return;
      // Straight to the page, ahead of what was held: it is what the extension says first.
      stream.write(text);
    },
  };
  entry.decided = (async () => {
    for (const handler of gates.get(extension) ?? []) {
      let verdict: void | false | (() => void) | "late";
      try {
        const work = Promise.resolve(handler(topic, page));
        verdict = await inTime(work);
        // It may still answer, and what it then asks to be undone is: the listening is over by then, so at once.
        if (verdict === "late") work.then((cleanup) => keepCleanup(entry, cleanup), () => {});
      } catch (e) {
        console.error(`[extension ${extension}] hearing a page listen to "${topic}" failed:`, e);
        verdict = false;
      }
      if (typeof verdict === "function") entry.leave.push(verdict);
      if (verdict === false || verdict === "late") {
        if (verdict === "late") console.error(`[extension ${extension}] had not said whether a page may listen to "${topic}" after ${DECIDE_MS / 1000} seconds`);
        end(entry);
        return false;
      }
      // The page left, or the extension stopped, while it was deciding: what it asked to be undone is, and the ask is answered as lost.
      if (entry.ended) {
        end(entry);
        return true;
      }
    }
    return true;
  })();
  stream.listening.set(key, entry);
  const allowed = await entry.decided;
  if (!allowed || entry.ended) {
    if (stream.listening.get(key) === entry) stream.listening.delete(key);
    end(entry);
    return allowed ? "lost" : "refused";
  }
  const held = entry.held ?? [];
  entry.held = null;
  for (const text of held) stream.write(text);
  return "listening";
}

/**
 * The page on stream `id` listens to `topic` of `extension` no more. With the `token` of the ask it ends, which a
 * listening that replaced it is not: a leave that comes in after the page has begun again does not end the new one.
 */
export function leave(id: string, extension: string, topic: string, token?: string): void {
  const stream = streams.get(id);
  const key = keyOf(extension, topic);
  const entry = stream?.listening.get(key);
  if (!stream || !entry) return;
  if (token !== undefined && entry.token !== undefined && token !== entry.token) return;
  stream.listening.delete(key);
  end(entry);
}

/**
 * An extension's server half stopped: what it did for the pages that listened is undone, and the pages are told the
 * topics are lost, so that they ask again (the extension may be started again, or be another version).
 */
export function dropExtension(extension: string): void {
  gates.delete(extension);
  for (const stream of streams.values()) {
    for (const [key, entry] of [...stream.listening]) {
      if (entry.extension !== extension) continue;
      stream.listening.delete(key);
      // A page that was let in is told; one still being decided is told by the answer to its own ask.
      const told = entry.held === null && !entry.ended;
      end(entry);
      if (told) stream.write(`event: lost\ndata: ${JSON.stringify({ extension, topic: entry.topic })}\n\n`);
    }
  }
}

/** Streams that are open now: for a test. */
export const openStreams = (): number => streams.size;
