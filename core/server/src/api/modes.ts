import express, { type Router } from "express";
import { CORE_MODES, STANDARD, type ChatModeEntry } from "../chat-modes.js";
import { chatSaid, getSession, onChannel, updateSession, type SessionRow } from "../db.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { asksQuestions } from "../pi/ask-question.js";
import { SessionEditError } from "../pi/session-edit.js";
import { sessions } from "../session-manager.js";

/**
 * The modes a chat may be put in: none where it may not choose. A chat with the person on the portal's pages (a task
 * chat or an Agent-page chat, of the primary user: see asksQuestions), where pi runs in the portal's own process: a
 * mode is carried out where the portal starts a chat's pi, which a container's pi is not.
 */
export function modesFor(session: SessionRow): readonly ChatModeEntry[] {
  return EXECUTOR_KIND === "host" && asksQuestions(session, onChannel(session)) ? CORE_MODES : [];
}

const STARTED = "This chat has started, and its mode is fixed: start a new chat for another one.";

/** A chat's mode: the ones it may be put in, and putting it in one before it has said anything (see chat-modes.ts). */
export function modesRouter(): Router {
  const router = express.Router();

  /** What the chat may be put in. Whether or not it has started: the header looks its stored mode up here. Never starts pi. */
  router.get("/sessions/:id/modes", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({ modes: modesFor(session).map(({ id, label, description }) => ({ id, label, description })) });
  });

  /** Puts a chat that has said nothing yet in a mode; its pi, where one is up, is let go, to start again in it. */
  router.put("/sessions/:id/modes", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const offered = modesFor(session);
    if (!offered.length) {
      return res.status(409).json({ error: "Modes are for the chats you start on the portal's pages, where pi runs in the portal's own process." });
    }
    if (chatSaid(session.id) || sessions.isBusy(session.id)) return res.status(409).json({ error: STARTED });
    const mode = req.body?.mode;
    const entry = offered.find((one) => one.id === mode);
    if (!entry) return res.status(400).json({ error: `There is no mode "${String(mode)}" for this chat.` });
    try {
      const done = await sessions.stopUnstarted(session.id, () => updateSession(session.id, { mode: entry.id === STANDARD ? null : entry.id }));
      if (!done) return res.status(409).json({ error: STARTED });
    } catch (e) {
      // Held while an edit or a reload of its pi holds the chat: said as the edit routes say it.
      if (e instanceof SessionEditError) return res.status(409).json({ error: e.message });
      return res.status(500).json({ error: (e as Error).message });
    }
    res.json({ mode: entry.id });
  });

  return router;
}
