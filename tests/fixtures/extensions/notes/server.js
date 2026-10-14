/**
 * The Notes extension's server half: loaded once by the portal, for all chats.
 *
 * The notes themselves are the pi half's (index.ts), one per chat, kept with
 * the conversation. This half is what a chat's pi cannot be: there when no
 * chat is running. It hears each chat's notes as its pi half says them, keeps
 * a copy in the folder the chat works in, and answers for all chats at once:
 *
 *   GET /api/x/pithagoras-notes/notes   every chat that has notes, with them
 *
 * A page that opens a chat is told how many notes it has, and each page open
 * on it again when that changes, without the chat's pi being started for it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FOLDER = ".pithagoras-notes";

export default function (portal) {
  /** Where a chat's notes are kept, by chat: remembered, since a deleted chat no longer says where it worked. */
  const kept = new Map();
  const fileOf = (chatId) => {
    if (!kept.has(chatId)) kept.set(chatId, portal.files.inside(portal.chats.folder(chatId), `${FOLDER}/${chatId}.json`));
    return kept.get(chatId);
  };
  // The chats there are as this starts: one deleted before it is next opened is known all the same.
  for (const chat of portal.chats.list()) {
    try {
      fileOf(chat.id);
    } catch {
      // Its folder is gone: it keeps nothing there.
    }
  }
  const read = (chatId) => {
    try {
      const notes = JSON.parse(readFileSync(fileOf(chatId), "utf8"));
      return Array.isArray(notes) ? notes : [];
    } catch {
      // No notes yet, or the chat's folder is gone.
      return [];
    }
  };

  // What the chat's pi half says to its browser half is heard here as well.
  portal.chats.onEvent((chatId, event) => {
    if (event.type !== "portal_extension_ui" || event.extension !== portal.extension || event.data?.type !== "notes") return;
    const notes = event.data.notes;
    const file = fileOf(chatId);
    if (notes.length) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(notes));
    } else if (existsSync(file)) rmSync(file);
    portal.chats.send(chatId, { type: "count", count: notes.length });
  });
  portal.chats.onOpen((chatId) => ({ type: "count", count: read(chatId).length }));
  portal.chats.on("deleted", (chatId) => {
    const file = kept.get(chatId);
    if (file && existsSync(file)) rmSync(file);
    kept.delete(chatId);
  });

  portal.router.get("/notes", (_req, res) => {
    const chats = portal.chats
      .list()
      .map((chat) => ({ id: chat.id, title: chat.title, notes: read(chat.id) }))
      .filter((chat) => chat.notes.length);
    res.json({ chats });
  });
}
