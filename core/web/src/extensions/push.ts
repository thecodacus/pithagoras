import { ApiError, json } from "../api";

/**
 * What an extension's server half tells the pages that listen to a topic of its
 * own (`portal.server.on(topic, handler)`), on any page of the portal. The
 * server's side of it is extension-push.ts.
 *
 * One stream for the whole page, however many extensions and topics: a browser
 * keeps few connections to a server. The stream says which it is (`ready`), and
 * each topic is asked for on it; a topic the server refuses is not heard. The
 * stream is kept for as long as something listens, opened again after a while,
 * longer each time, when it drops, and every topic is asked for again on the
 * new one: the server half tells a page where things stand as it begins to
 * listen, so nothing that happened meanwhile is missed. A topic whose
 * extension stopped (it is being updated, or switched off and on) is asked for
 * again the same way.
 */

type Handler = (data: unknown) => void;

interface Topic {
  extension: string;
  topic: string;
  handlers: Set<Handler>;
  /** `idle`: to be asked for; `asking`: the server is deciding; `on`: it is heard; `refused`: it is not for this page. */
  state: "idle" | "asking" | "on" | "refused";
  failures: number;
  retry?: ReturnType<typeof setTimeout>;
}

const topics = new Map<string, Topic>();
let source: EventSource | null = null;
let stream: string | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

const keyOf = (extension: string, topic: string) => JSON.stringify([extension, topic]);
const wait = (count: number) => Math.min(2000 * 2 ** count, 30_000);

function connect(): void {
  if (source || reconnect !== undefined || typeof EventSource === "undefined") return;
  const opened = new EventSource("/api/pushes");
  source = opened;
  opened.addEventListener("ready", (e) => {
    try {
      stream = JSON.parse((e as MessageEvent).data).stream;
    } catch {
      return;
    }
    failures = 0;
    for (const topic of topics.values()) {
      topic.state = "idle";
      ask(topic);
    }
  });
  opened.addEventListener("push", (e) => {
    let message: { extension?: unknown; topic?: unknown; data?: unknown };
    try {
      message = JSON.parse((e as MessageEvent).data);
    } catch {
      // A message that is not one of ours: nothing to take from it.
      return;
    }
    if (typeof message.extension !== "string" || typeof message.topic !== "string") return;
    const topic = topics.get(keyOf(message.extension, message.topic));
    if (!topic) return;
    for (const handler of [...topic.handlers]) {
      try {
        handler(message.data);
      } catch (error) {
        console.error(`[extensions] ${topic.extension} failed on hearing "${topic.topic}" from its server half:`, error);
      }
    }
  });
  // The server half stopped (it may be started again): asked for again until it is.
  opened.addEventListener("lost", (e) => {
    try {
      const { extension, topic } = JSON.parse((e as MessageEvent).data);
      const found = topics.get(keyOf(extension, topic));
      if (found) again(found);
    } catch {
      // Not one of ours.
    }
  });
  opened.addEventListener("error", () => {
    if (source !== opened) return;
    opened.close();
    source = null;
    stream = null;
    for (const topic of topics.values()) {
      clearTimeout(topic.retry);
      topic.state = "idle";
    }
    if (!topics.size) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, wait(failures++));
  });
}

function disconnect(): void {
  clearTimeout(reconnect);
  reconnect = undefined;
  source?.close();
  source = null;
  stream = null;
  failures = 0;
}

/** Asked for again after a while, longer each time. */
function again(topic: Topic): void {
  topic.state = "idle";
  clearTimeout(topic.retry);
  topic.retry = setTimeout(() => {
    if (topics.get(keyOf(topic.extension, topic.topic)) === topic) ask(topic);
  }, wait(topic.failures++));
}

function ask(topic: Topic): void {
  if (!stream || topic.state !== "idle") return;
  const on = stream;
  topic.state = "asking";
  json(`/api/pushes/${on}/listen`, { method: "POST", body: JSON.stringify({ extension: topic.extension, topic: topic.topic }) }).then(
    () => {
      if (stream !== on || topic.state !== "asking") return;
      topic.state = "on";
      topic.failures = 0;
    },
    (error: unknown) => {
      if (stream !== on || topic.state !== "asking") return;
      const code = error instanceof ApiError ? error.body.code : undefined;
      if (code === "refused" || code === "too-many") {
        topic.state = "refused";
        console.warn(`[extensions] ${topic.extension} may not listen to "${topic.topic}": ${(error as Error).message}`);
      } else if (code === "no-stream") {
        // The server let the stream go (a login ended and began again): a new one, with every topic asked for anew.
        source?.close();
        source = null;
        stream = null;
        for (const other of topics.values()) other.state = "idle";
        connect();
      } else {
        // Its extension is not running yet, or the portal could not be reached: asked for again.
        again(topic);
      }
    },
  );
}

/**
 * Hears what an extension's server half pushes to `topic`, and is told where things stand when it begins to listen.
 * Returns the unsubscribe.
 */
export function listenTopic(extension: string, topic: string, handler: Handler): () => void {
  const key = keyOf(extension, topic);
  let held = topics.get(key);
  if (!held) topics.set(key, (held = { extension, topic, handlers: new Set(), state: "idle", failures: 0 }));
  const mine = held;
  mine.handlers.add(handler);
  connect();
  ask(mine);
  return () => {
    if (!mine.handlers.delete(handler) || mine.handlers.size) return;
    if (topics.get(key) === mine) forget(mine);
  };
}

/** Nothing listens to this topic any more: the server is told, and the stream goes when no topic is left. */
function forget(topic: Topic): void {
  clearTimeout(topic.retry);
  topics.delete(keyOf(topic.extension, topic.topic));
  if (stream && (topic.state === "on" || topic.state === "asking")) {
    json(`/api/pushes/${stream}/leave`, { method: "POST", body: JSON.stringify({ extension: topic.extension, topic: topic.topic }) }).catch(() => {});
  }
  if (!topics.size) disconnect();
}

/** An extension was taken out of the page: it listens to nothing any more. */
export function forgetPushes(extension: string): void {
  for (const topic of [...topics.values()]) {
    if (topic.extension !== extension) continue;
    topic.handlers.clear();
    forget(topic);
  }
}
