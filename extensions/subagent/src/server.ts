import { readFileSync } from "node:fs";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import subagentTool from "./pi";
import type { Hear } from "./runner";
import { chatModel, forgetChat, openChats, pruneChats, setChatModel, takeChats } from "./per-chat";
import { checkChange, isModelChoice, MAX_PARALLEL, openStore, saveSettings, settings, settingsOf, takeSettings, type Settings } from "./settings";

/**
 * The subagent extension's server half: the `subagent` tool in every chat's pi but a child chat's and a heartbeat's
 * (`portal.chats.extend`, pi.ts), whose subagents work in child chats of that chat (`portal.chats.create`), with the
 * settings it keeps in its own folder (settings.ts) and what each chat says its subagents run on (per-chat.ts), and
 * the routes of its page in Settings and of the row in a chat's model menu, at /api/x/pithagoras-subagent/….
 *
 * In the portal's own process, never in one of its own: the tool speaks the subagent protocol on the chat's event bus
 * (`pi.events`), which a pi given to a half in a process of its own does not have.
 *
 * What the portal kept for the tool before it was an extension is taken up first (takeHandoff, takeChatsHandoff).
 */
export default function subagent(portal: ServerPortal) {
  openStore(portal.dataDir());
  openChats(portal.dataDir());
  forgetGoneChats(portal);
  takeHandoff(portal);
  takeChatsHandoff(portal);
  const hear = hearChildren(portal);
  portal.chats.extend((pi, chat) => {
    // A child chat has no subagents of its own: one level, as the portal's child chats are. Nor has a heartbeat, which
    // is held to reading, and whose child chat the portal refuses: the tool would only fail, at a cost in every request.
    if (chat.parent || chat.kind === "heartbeat") return;
    subagentTool(pi, { chat, chats: portal.chats, settings, chatModel: () => chatModel(chat.id), hear });
  });
  portal.chats.on("deleted", (chatId) => {
    try {
      forgetChat(chatId);
    } catch (e) {
      portal.log(`could not forget what the deleted chat ${chatId} said its subagents run on: ${(e as Error).message}`);
    }
  });
  routes(portal);
}

/**
 * The settings as the tool kept them in pi's settings.json, before it was an extension: the upgrade to schema 12 left
 * them in the portal's data folder under the name "subagent", and `portal.handoffs.take` gives them to the first
 * extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   subagentMode, subagentMaxParallel and subagentModel as pi's settings had them, each null where they
 *                   had none
 *
 * Each is read as the tool read it, and taken where this extension has none of its own: one said on its page since,
 * while the hand-off waited, is the person's latest word. One that an earlier hand-off gave and nobody has changed
 * since is not: the person went back to pi's settings meanwhile, and what they hold now is newer. Only then is the
 * hand-off done with, so a start that stopped half way takes it up again, harmlessly. What cannot be taken up stays
 * where it is, for the next start: the extension starts with what it has, and says why in the portal's log.
 */
export function takeHandoff(portal: Pick<ServerPortal, "handoffs" | "log">): void {
  try {
    const dir = portal.handoffs.take("subagent");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`they are in a format this version does not read (${format})`);
    const kept = read("settings.json") ?? {};
    const old = settingsOf({ mode: kept.subagentMode, maxParallel: kept.subagentMaxParallel, model: kept.subagentModel });
    const taken = takeSettings(old);
    portal.handoffs.done("subagent");
    portal.log(`took up the subagent settings pi's settings held${taken.length ? `: ${taken.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal.log(`could not take up the subagent settings pi's settings held, which are kept for the next start: ${(e as Error).message}`);
  }
}

/**
 * What each chat said its subagents run on, as the portal kept it before the extension did: the upgrade to schema 14
 * left it in the portal's data folder under the name "subagent-chats", taken as the settings are (takeHandoff). In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   models.json     {"<chat id>": "auto" | "provider/model"}, for each chat that said one
 *
 * Each is taken for a chat that says nothing here yet: one said since in its model menu is the person's latest word.
 * One that an earlier hand-off gave and nobody has set since is not: the person went back meanwhile, and what the older
 * version holds now is newer (as with the settings). Chats the portal no longer has are not taken. What cannot be
 * taken up stays where it is, for the next start.
 */
export function takeChatsHandoff(portal: Pick<ServerPortal, "handoffs" | "log" | "chats">): void {
  try {
    const dir = portal.handoffs.take("subagent-chats");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version does not read (${format})`);
    const kept = read("models.json");
    const { taken, left } = takeChats(kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {}, (chatId) => !!portal.chats.get(chatId));
    portal.handoffs.done("subagent-chats");
    portal.log(
      `took up what ${taken.length === 1 ? "one chat" : `${taken.length} chats`} said ${taken.length === 1 ? "its" : "their"} subagents run on` +
        (left.length ? `, and left ${left.length === 1 ? "one chat" : `${left.length} chats`} with ${left.length === 1 ? "its" : "their"} own choice` : ""),
    );
  } catch (e) {
    portal.log(`could not take up what the chats said their subagents run on, which is kept for the next start: ${(e as Error).message}`);
  }
}

/** What a child chat's pi says, to whoever listens for that chat: the card of a call that waits on its subagent. */
function hearChildren(portal: Pick<ServerPortal, "chats">): Hear {
  const listening = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  // Every chat's every event comes here, a token at a time: only a chat somebody listens for is looked at.
  portal.chats.onEvent((chatId, event) => {
    const handlers = listening.get(chatId);
    if (handlers) for (const handler of [...handlers]) handler(event);
  });
  return (chatId, handler) => {
    let handlers = listening.get(chatId);
    if (!handlers) listening.set(chatId, (handlers = new Set()));
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (!handlers.size && listening.get(chatId) === handlers) listening.delete(chatId);
    };
  };
}

/** A chat deleted while the half was off told it nothing: what it said is forgotten as the half starts. */
function forgetGoneChats(portal: Pick<ServerPortal, "chats" | "log">): void {
  try {
    const gone = pruneChats((chatId) => !!portal.chats.get(chatId));
    if (gone.length) portal.log(`forgot what ${gone.length === 1 ? "one deleted chat" : `${gone.length} deleted chats`} said its subagents run on`);
  } catch (e) {
    portal.log(`could not forget what deleted chats said their subagents run on: ${(e as Error).message}`);
  }
}

/**
 * The page in Settings, and the row in a chat's model menu, behind the portal's login:
 *
 *   GET /settings   {mode, maxParallel, maxParallelLimit, model, keep}
 *   PUT /settings   {mode?, maxParallel?, model?, keep?}: each it names; the open chats are loaded again, as the mode,
 *                   the limit and whether chats are kept are in what the tool tells the model, and the answer says how
 *                   many were (`reloaded`) and how many have it from their next step (`waiting`)
 *
 * The portal's old address for them, /api/features/subagent, sends here. `enabled` there was the switch, which is
 * Settings → Extensions' now: `true` asks for nothing this does not have already, as it answers; `false` is refused.
 */
function routes(portal: ServerPortal): void {
  const json = portal.http.json();
  // The most there may be, for the page to count up to: said here, not repeated there.
  const shown = () => ({ ...settings(), maxParallelLimit: MAX_PARALLEL });
  portal.router.get("/settings", (_req, res) => res.json(shown()));
  // What a chat's subagents run on: its own choice (null follows `default`, the settings' model).
  const chosen = (chatId: string) => ({ model: chatModel(chatId) ?? null, default: settings().model });
  portal.router.get("/chats/:id/model", (req, res) => {
    if (!portal.chats.get(req.params.id)) return res.status(404).json({ error: "There is no such chat" });
    res.json(chosen(req.params.id));
  });
  portal.router.put("/chats/:id/model", json, (req, res) => {
    if (!portal.chats.get(req.params.id)) return res.status(404).json({ error: "There is no such chat" });
    const model = req.body?.model ?? null;
    if (model !== null && !isModelChoice(model)) return res.status(400).json({ error: 'model must be null, "auto" or provider/model' });
    try {
      // Read as a subagent starts: nothing to reload.
      setChatModel(req.params.id, model);
      res.json(chosen(req.params.id));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  portal.router.put("/settings", json, async (req, res) => {
    let change: Partial<Settings>;
    try {
      if (req.body?.enabled !== undefined && req.body.enabled !== true) {
        throw new Error("The subagent tool is switched off in Settings → Extensions (PUT /api/extensions/enabled)");
      }
      change = checkChange(req.body);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    try {
      saveSettings({ ...settings(), ...change });
      // The mode, the limit and keeping are in the tool's description, which a chat reads as its pi is loaded.
      const { reloaded, waiting } = await portal.chats.reload();
      res.json({ ...shown(), reloaded, waiting });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
