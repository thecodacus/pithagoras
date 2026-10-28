import { nanoid } from "nanoid";
import { agentHome } from "./agent-home.js";
import { listAgents } from "./agents.js";
import { STANDARD } from "./chat-modes.js";
import { createSession, getSession, modeOf, modesFor, parseToolsOff, type SessionRow } from "./db.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { cleanTitle, listProjects } from "./projects.js";
import { baseDir } from "./workspace-files.js";
import { workspaceRoot } from "./workspaces.js";

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
 *
 * A child takes its parent's tool switches and is held to them (`tools: "parent"`), or starts from the tools a new chat
 * of the folder has and is not (`tools: "defaults"`, which an unattended child is unless it asks for its parent's).
 *
 * A child made `unattended` is one nobody answers in, wherever its parent is: it has no ask_question, every dialog an
 * extension opens in it is answered at once with its no-answer value, and the guard refuses a held call rather than
 * asking, as in a routine run. Stored on its row, so a pi started for it after a restart is started the same way. A child
 * of an unattended chat is unattended itself, and a child of an unlisted one unlisted, whatever it is asked.
 */

/** What a server half asks of a child chat: see `chats.create` in server.d.ts. */
export interface ChildChatOptions {
  parent: string;
  title: string;
  mode?: string;
  model?: { provider: string; id: string };
  listed?: boolean;
  unattended?: true;
  tools?: "parent" | "defaults";
}

/** What a server half asks of a chat of its own in a folder: see `chats.start` in server.d.ts. */
export interface PackageChatOptions {
  folder: string;
  title: string;
  listed?: boolean;
  unattended?: true;
}

/** How a run of a child chat ended, and the last thing it said: see `chats.prompt` in server.d.ts. */
export interface ChildRun {
  status: "done" | "stopped" | "error";
  answer: string;
  /** The child had read outside content that holds a chat back (the guard marked it): its parent is marked with it. */
  marked?: true;
  error?: string;
}

/**
 * Where the last run of a chat a server half made stands, from what the portal keeps of it: see `chats.lastAnswer` in
 * server.d.ts. `running` while it goes on.
 */
export interface ChatAnswer {
  status: "running" | ChildRun["status"];
  answer: string;
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
  if (asked.unattended !== undefined && asked.unattended !== true) throw new TypeError("unattended is true, or left out");
  if (asked.tools !== undefined && asked.tools !== "parent" && asked.tools !== "defaults") throw new TypeError('tools is "parent" or "defaults"');
  // A child of a chat nobody attends has nobody to ask either: its dialogs would go to its parent's page, which nobody
  // opens, and wait there for good. So it is unattended too, whoever makes it (the subagent tool does not say).
  const unattended = asked.unattended === true || parent.unattended === 1;
  // A chat nobody attends does work of the package's, not the conversation its parent is: the tools the person switched
  // for that conversation are not its own unless asked for.
  const defaults = asked.tools === "defaults" || (asked.tools === undefined && unattended);
  const model = asked.model as ChildChatOptions["model"] | undefined;
  if (model !== undefined && (!model || typeof model !== "object" || !text(model.provider) || !text(model.id))) {
    throw new TypeError("A child chat's model is a provider and an id, as pi names them");
  }

  // As the child will be: modesFor looks to the parent for where the person can answer (dialogHost).
  const draft = { kind: "task" as const, role: parent.role, channel_slug: null, parent_id: parent.id };
  // With no mode asked for, the parent's: a child is not a way out of the tools a mode took away. The parent's own
  // model and effort stay (the parent may have been moved off its mode's since); another mode that is named is its own
  // choice, and its model and effort are the child's. The parent's own mode, named, is the same as none: it is how an
  // extension says "the mode my chat is in" and still hears if that is gone.
  let mode: string | null = asked.mode === undefined ? parent.mode : null;
  let fromMode: { provider?: string; model?: string; thinkingLevel?: string } = {};
  if (asked.mode !== undefined && asked.mode !== STANDARD) {
    const entry = modesFor(draft).find((one) => one.id === asked.mode);
    if (!entry) throw new TypeError(`There is no mode "${String(asked.mode)}" for this child chat`);
    // A mode that asks the person first was said yes to for the parent, if it is in it; for nothing else.
    if (entry.confirm && parent.mode !== entry.id) throw new TypeError(`The mode "${entry.id}" asks the person first: a child chat can only be put in it where its parent is in it`);
    mode = entry.id;
    if (entry.id !== parent.mode) fromMode = entry;
  }
  // A child in another mode than its parent's has not that mode's layer: the tools it took away stay off for the child
  // too, as its own switches, or naming Standard would be a way out of them. Not for one that starts from the defaults,
  // which has the tools a chat of the folder started in its mode has: none of its parent's switches, nor of its parent's
  // mode's where it is in another (in its parent's, that mode's layer holds for it as for any chat, db.ts withMode).
  const left = mode === parent.mode || defaults ? [] : (modeOf(parent.mode)?.tools?.off ?? []);

  const id = nanoid(12);
  createSession({
    id,
    title,
    workspace: parent.workspace,
    executor: parent.executor,
    kind: "task",
    parent_id: parent.id,
    // Under a parent kept out of the lists, a listed child would stand in them on its own, with no chat it is a part of.
    listed: asked.listed === false || parent.listed === 0 ? 0 : 1,
    creator,
    unattended: unattended ? 1 : 0,
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
    ...(defaults
      ? { tools_from: "defaults" as const }
      : {
          tools_off: left.length ? [...new Set([...parseToolsOff(parent.tools_off), ...left])].sort().join("\n") : parent.tools_off,
          tools_on: left.length ? parseToolsOff(parent.tools_on).filter((name) => !left.includes(name)).join("\n") : parent.tools_on,
        }),
  });
  return getSession(id)!;
}

/**
 * The folder of an agent or a project that `folder` is, by where it really leads, as the chats there store it: an
 * agent's home as its agent names it, a project as the folder directly under the workspace root. Undefined for any
 * other folder, one inside them included: a task chat of the person's own works in one of these.
 */
function agentOrProjectFolder(folder: string): string | undefined {
  let real: string;
  try {
    real = baseDir(folder);
  } catch {
    return undefined;
  }
  const leads = (dir: string) => {
    try {
      return baseDir(dir) === real;
    } catch {
      return false;
    }
  };
  const agent = listAgents().find((one) => leads(one.home));
  if (agent) return agentHome(agent.home);
  try {
    return listProjects(workspaceRoot()).find((project) => leads(project.path))?.path;
  } catch {
    // No workspace root yet: no projects.
    return undefined;
  }
}

/**
 * Makes a chat of an agent's or a project's folder for the package `creator`, and returns its row: a task chat with no
 * parent, in the primary role, in Standard mode on the default model, with the tools a chat started there has. It is
 * the package's as a child is (it alone prompts, stops or removes it), and goes with the folder's chats when the
 * project or the agent is deleted. Throws a TypeError for a request that cannot be one, and says why.
 */
export function newPackageChat(options: unknown, creator: string): SessionRow {
  const asked = (options ?? {}) as Partial<Record<keyof PackageChatOptions, unknown>>;
  if (!text(asked.folder)) throw new TypeError("A chat is started in a folder: an agent's or a project's, as folders.list() gives it");
  const workspace = agentOrProjectFolder(asked.folder);
  if (!workspace) throw new TypeError(`${asked.folder} is not the folder of an agent or a project`);
  const title = cleanTitle(asked.title);
  if (!title) throw new TypeError("A chat needs a title");
  if (asked.listed !== undefined && typeof asked.listed !== "boolean") throw new TypeError("listed is true or false");
  if (asked.unattended !== undefined && asked.unattended !== true) throw new TypeError("unattended is true, or left out");
  // A child that waits on the person says so on its parent's row; a chat with no parent that is in no list has no row
  // to say it on, and a question in it would wait on a page nobody finds.
  if (asked.listed === false && asked.unattended !== true) throw new TypeError("A chat kept out of the lists is one nobody attends: say unattended: true too");
  const id = nanoid(12);
  createSession({
    id,
    title,
    workspace,
    executor: EXECUTOR_KIND,
    kind: "task",
    listed: asked.listed === false ? 0 : 1,
    creator,
    unattended: asked.unattended === true ? 1 : 0,
  });
  return getSession(id)!;
}
