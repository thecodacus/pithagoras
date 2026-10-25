import { nanoid } from "nanoid";
import { STANDARD } from "./chat-modes.js";
import { createSession, getSession, modesFor, type SessionRow } from "./db.js";
import { cleanTitle } from "./projects.js";

/**
 * Child chats: a chat a server half makes for a chat (`chats.create`, server.d.ts), to give part of that chat's work
 * to. In every other way it is an ordinary session: the portal starts its pi in the parent's folder, with the guard,
 * the sandbox's user for that folder, the tool layers and its mode, and it keeps a transcript of its own, opened at
 * /s/<id>. Its kind is `task`, so its dialogs are drawn on its own page and the guard can ask there.
 *
 * It starts where its parent stands: the parent's role and last speaker, so the guard holds it to the person who
 * asked; the parent's mode, model and effort unless it is given its own; and the tools the person switched off or on in
 * the parent. Its dialogs and the guard's questions go where its parent's would (db.ts dialogHost): where nobody can
 * answer on the portal's pages, the guard refuses for the child too, rather than waiting on a page nobody opens. One
 * level only: a child has no children. It is deleted with its parent (db.ts removeSession, and
 * SessionManager.discard for its pi and files).
 */

/** What a server half asks of a child chat: see `chats.create` in server.d.ts. */
export interface ChildChatOptions {
  parent: string;
  title: string;
  mode?: string;
  model?: { provider: string; id: string };
  listed?: boolean;
}

/** How a run of a child chat ended, and the last thing it said: see `chats.prompt` in server.d.ts. */
export interface ChildRun {
  status: "done" | "stopped" | "error";
  answer: string;
  /** The child had read outside content that holds a chat back (the guard marked it): its parent is marked with it. */
  marked?: true;
  error?: string;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Makes a child chat of `options.parent` for the package `creator`, and returns its row. Throws a TypeError for a
 * request that cannot be one, and says why: no such parent, a parent that is a child itself or a heartbeat, no title,
 * a model that is not a provider and an id, or a mode the child may not be put in.
 */
export function newChildChat(options: unknown, creator: string): SessionRow {
  const asked = (options ?? {}) as Partial<Record<keyof ChildChatOptions, unknown>>;
  if (!text(asked.parent)) throw new TypeError("A child chat needs the id of its parent chat");
  const parent = getSession(asked.parent);
  if (!parent) throw new TypeError(`There is no chat ${asked.parent}`);
  if (parent.parent_id) throw new TypeError("A child chat cannot have children of its own: make it a child of its parent instead");
  // A heartbeat is held to reading by a role of its own, which a chat started under it would not carry: its row says
  // primary, and the child would run with the primary user's rights, on whatever WATCH.md made the heartbeat read.
  if (parent.kind === "heartbeat") throw new TypeError("A heartbeat cannot have child chats: it looks around on its own, held to reading, which a child chat would not be");
  const title = cleanTitle(asked.title);
  if (!title) throw new TypeError("A child chat needs a title");
  if (asked.listed !== undefined && typeof asked.listed !== "boolean") throw new TypeError("listed is true or false");
  const model = asked.model as ChildChatOptions["model"] | undefined;
  if (model !== undefined && (!model || typeof model !== "object" || !text(model.provider) || !text(model.id))) {
    throw new TypeError("A child chat's model is a provider and an id, as pi names them");
  }

  // As the child will be: modesFor looks to the parent for where the person can answer (dialogHost).
  const draft = { kind: "task" as const, role: parent.role, channel_slug: null, parent_id: parent.id };
  // With no mode asked for, the parent's: a child is not a way out of the tools a mode took away. The parent's own
  // model and effort stay (the parent may have been moved off its mode's since); a mode that is named is its own choice.
  let mode: string | null = asked.mode === undefined ? parent.mode : null;
  let fromMode: { provider?: string; model?: string; thinkingLevel?: string } = {};
  if (asked.mode !== undefined && asked.mode !== STANDARD) {
    const entry = modesFor(draft).find((one) => one.id === asked.mode);
    if (!entry) throw new TypeError(`There is no mode "${String(asked.mode)}" for this child chat`);
    // A mode that asks the person first was said yes to for the parent, if it is in it; for nothing else.
    if (entry.confirm && parent.mode !== entry.id) throw new TypeError(`The mode "${entry.id}" asks the person first: a child chat can only be put in it where its parent is in it`);
    mode = entry.id;
    fromMode = entry;
  }

  const id = nanoid(12);
  createSession({
    id,
    title,
    workspace: parent.workspace,
    executor: parent.executor,
    kind: "task",
    parent_id: parent.id,
    listed: asked.listed === false ? 0 : 1,
    creator,
    role: parent.role,
    last_person_key: parent.last_person_key,
    mode,
    // The model it is given, else the one its mode starts on, else its parent's (which may be the default's).
    ...(model
      ? { provider: model.provider, model: model.id }
      : fromMode.model
        ? { provider: fromMode.provider ?? null, model: fromMode.model }
        : { provider: parent.provider, model: parent.model }),
    thinking_level: fromMode.thinkingLevel ?? parent.thinking_level,
    tools_off: parent.tools_off,
    tools_on: parent.tools_on,
  });
  return getSession(id)!;
}
