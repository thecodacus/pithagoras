import express, { type Router } from "express";
import { isServing } from "../extension-host.js";
import { leave, listen, openStream, validTopic } from "../extension-push.js";
import { validName } from "../extension-ui.js";
import { watchStream } from "../login-streams.js";

/**
 * What the installed extensions' server halves tell the pages that listen to
 * their topics (see extension-push.ts). The page opens one stream, then asks
 * on it for each topic its extensions listen to: a stream is not told of
 * anything it did not ask for. Behind the login like everything under /api, and
 * ended with it when the password changes.
 */

/** A page that does not read what it is sent is let go of rather than held in memory. */
const MOST_UNREAD = 8 * 1024 * 1024;
/** The longest name a page gives its ask. */
const MAX_TOKEN = 64;

export function pushesRouter(): Router {
  const router = express.Router();

  router.get("/pushes", (_req, res) => {
    let write: (text: string) => void = () => {};
    const opened = openStream((text) => write(text));
    if (!opened) return void res.status(503).json({ error: "Too many pages are listening" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    write = (text) => {
      if (res.destroyed) return;
      if (res.writableLength > MOST_UNREAD) return void res.destroy();
      res.write(text);
    };
    write(`event: ready\ndata: ${JSON.stringify({ stream: opened.id })}\n\n`);
    const heartbeat = setInterval(() => write(": ping\n\n"), 25_000);
    // Ended when the password changes: this login is not the portal's any more.
    const unwatch = watchStream(() => res.destroy());
    res.on("close", () => {
      clearInterval(heartbeat);
      unwatch();
      opened.close();
    });
  });

  /** The extension and topic a request names, with the page's name for its ask if it gave one, or a 400. */
  const named = (body: unknown): { extension: string; topic: string; token?: string } | undefined => {
    const { extension, topic, token } = (body ?? {}) as { extension?: unknown; topic?: unknown; token?: unknown };
    if (!validName(extension) || !validTopic(topic)) return undefined;
    if (token === undefined) return { extension, topic };
    return typeof token === "string" && token.length > 0 && token.length <= MAX_TOKEN ? { extension, topic, token } : undefined;
  };

  router.post("/pushes/:stream/listen", async (req, res) => {
    const asked = named(req.body);
    if (!asked) return void res.status(400).json({ error: "An extension and a topic are needed" });
    // Its handlers are its server half's: with none running nothing is decided, and the page asks again when it is.
    if (!isServing(asked.extension)) return void res.status(404).json({ error: `${asked.extension} has no server half running`, code: "not-running" });
    const result = await listen(String(req.params.stream), asked.extension, asked.topic, asked.token);
    switch (result) {
      case "listening":
        return void res.json({ ok: true });
      case "refused":
        return void res.status(403).json({ error: "That topic is not for this page", code: "refused" });
      case "too-many":
        return void res.status(429).json({ error: "This page listens to too many topics", code: "too-many" });
      case "lost":
        return void res.status(404).json({ error: `${asked.extension} stopped meanwhile`, code: "not-running" });
      default:
        return void res.status(404).json({ error: "This page's stream is not open any more", code: "no-stream" });
    }
  });

  router.post("/pushes/:stream/leave", (req, res) => {
    const asked = named(req.body);
    if (!asked) return void res.status(400).json({ error: "An extension and a topic are needed" });
    leave(String(req.params.stream), asked.extension, asked.topic, asked.token);
    res.json({ ok: true });
  });

  return router;
}
