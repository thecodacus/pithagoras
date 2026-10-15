import path from "node:path";
import Database from "better-sqlite3";
import type { RequestHandler, Response, Router } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { openStore, type CanvasMessage, type CanvasStore } from "./store";
import { CanvasTools } from "./tools";

/**
 * Canvases' server half: the store, its routes at
 * /api/x/pithagoras-canvas/chats/<chat>/canvases, the agent's tools in each
 * chat, and what the pages open on a chat are told as its canvases change.
 *
 * Stored canvases are in a database of the extension's own, in the portal's
 * data folder (`portal.dataDir()`): a chat's folder is one its agent can
 * write, and the panel's documents are the person's to change, not the
 * agent's behind it.
 */

/** How often a canvas being written is sent to the pages, at most. */
const EVERY_MS = 250;

const fail = (res: Response, status: number, e: unknown) => res.status(status).json({ error: (e as Error).message });

export default function canvas(portal: ServerPortal) {
  const db = new Database(path.join(portal.dataDir(), "canvases.db"));
  const store = openStore(db, (id) => Boolean(portal.chats.get(id)));
  store.interruptAll();

  // A document being written changes many times a second, each change the whole of it, and the conversation's own
  // events wait behind them on the page's one connection. So only the latest of a document's changes goes, at most
  // every EVERY_MS; anything else sends what was held first, in order.
  const held = new Map<string, Map<string, CanvasMessage>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const sendHeld = (chat: string) => {
    clearTimeout(timers.get(chat));
    timers.delete(chat);
    const messages = held.get(chat);
    held.delete(chat);
    for (const message of messages?.values() ?? []) portal.chats.send(chat, message);
  };
  store.events.on("message", (chat: string, message: CanvasMessage) => {
    if (message.type === "update") {
      let messages = held.get(chat);
      if (!messages) held.set(chat, (messages = new Map()));
      messages.set(message.canvas.id, message);
      if (!timers.has(chat)) timers.set(chat, setTimeout(() => sendHeld(chat), EVERY_MS));
      return;
    }
    sendHeld(chat);
    portal.chats.send(chat, message);
  });
  // A page that opens a chat is told all of its canvases first.
  portal.chats.onOpen((chat) => ({ type: "snapshot", canvases: store.list(chat) }));

  // The agent's tools, in each chat as its pi starts, and the live write, from what the chat's pi says.
  const tools = new Map<string, CanvasTools>();
  portal.chats.extend((pi, chat) => {
    const own = new CanvasTools(store, chat.id, () => portal.chats.offers(chat.id, "canvas_write"));
    tools.get(chat.id)?.interrupt();
    tools.set(chat.id, own);
    own.register(pi);
  });
  portal.chats.onEvent((chat, event) => tools.get(chat)?.observe(event));
  portal.chats.on("stopped", (chat) => {
    tools.get(chat)?.interrupt();
    tools.delete(chat);
  });
  portal.chats.on("deleted", (chat) => {
    tools.get(chat)?.interrupt();
    tools.delete(chat);
    store.forget(chat);
  });

  routes(portal.router, portal.http.json({ limit: "2mb" }), store, (id) => Boolean(portal.chats.get(id)));

  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    for (const own of tools.values()) own.interrupt();
    store.close();
    db.close();
  };
}

/** The routes of a chat's canvases, on `router` (the package's, at /api/x/pithagoras-canvas): `json` reads a body. */
export function routes(router: Router, json: RequestHandler, store: CanvasStore, chatExists: (id: string) => boolean) {
  router.use("/chats/:id", (req, res, next) => (chatExists(String(req.params.id)) ? next() : res.status(404).json({ error: "Session not found" })));
  router.get("/chats/:id/canvases", (req, res) => res.json(store.list(String(req.params.id))));
  router.post("/chats/:id/canvases", json, (req, res) => {
    try {
      if (typeof req.body?.title !== "string") throw new Error("Title required");
      res.json(store.create(String(req.params.id), req.body.title));
    } catch (e) {
      fail(res, 400, e);
    }
  });
  router.post("/chats/:id/canvases/:canvas/persist", (req, res) => {
    try {
      res.json(store.persist(String(req.params.id), String(req.params.canvas)));
    } catch (e) {
      fail(res, 400, e);
    }
  });
  router.put("/chats/:id/canvases/:canvas", json, (req, res) => {
    try {
      const { revision, title, content } = req.body ?? {};
      if (!Number.isInteger(revision) || typeof title !== "string" || typeof content !== "string") throw new Error("Revision, title and content required");
      res.json(store.edit(String(req.params.id), String(req.params.canvas), revision, title, content));
    } catch (e) {
      fail(res, 409, e);
    }
  });
  router.post("/chats/:id/canvases/:canvas/restore", json, (req, res) => {
    try {
      const revision = req.body?.revision;
      if (!Number.isInteger(revision)) throw new Error("Revision required");
      res.json(store.restore(String(req.params.id), String(req.params.canvas), revision));
    } catch (e) {
      fail(res, 409, e);
    }
  });
  router.delete("/chats/:id/canvases/:canvas", json, (req, res) => {
    try {
      const revision = req.body?.revision;
      if (!Number.isInteger(revision)) throw new Error("Revision required");
      store.remove(String(req.params.id), String(req.params.canvas), revision);
      res.json({ ok: true });
    } catch (e) {
      fail(res, 409, e);
    }
  });

}
