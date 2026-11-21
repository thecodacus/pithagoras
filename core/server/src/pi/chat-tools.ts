import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDb, type SessionRow } from "../db.js";
import { agentOf, chatsOf, getAgent } from "../agents.js";
import { AUDIO_MESSAGE_PREFIX } from "./voice-first.js";
import { textOf } from "./entries.js";
import { Entry, pathTo } from "./session-edit.js";
import { findSessionFile, SESSION_ROOT } from "./session-file.js";
import { fail, say } from "./tool-result.js";

/**
 * The agent's own past: the tools to list, read and search its old chats (#376).
 *
 * The record of a conversation is pi's session file, and once a chat is over
 * its content is out of reach — these tools are the way back to it. They read
 * the files of the agent's own chats, the ones that work in its home or in a
 * project of it, and nothing else: a chat of another agent's is not here to be
 * found, whatever its id.
 *
 * What read and search return is other people's words as often as the agent's
 * own: a channel's conversation is whoever wrote it. So they say their result
 * is outside content, and the guard holds the conversation to it as it holds
 * one that read a page or a mail. The list is metadata alone, and says nothing
 * of what is in the chats.
 */

export const CHAT_LIST_TOOL = "chat_list";
export const CHAT_READ_TOOL = "chat_read";
export const CHAT_SEARCH_TOOL = "chat_search";

/** Where a container's pi finds a session's folder: see ContainerExecutor. */
const CONTAINER_SESSION_DIR = "/sessions/";
/** The most recent chats the list shows; the older ones are still there for the search. */
const LIST_CAP = 100;
/** What one read may hand back; more is a slice, not a wall of text. */
const MAX_OUTPUT = 50_000;

/** The file of this chat's conversation, where it is now; undefined where there is none to read. */
function fileOf(session: SessionRow): string | undefined {
  let file = session.pi_session_file;
  if (!file) return undefined;
  if (session.executor !== "host" && file.startsWith(CONTAINER_SESSION_DIR)) {
    file = path.join(SESSION_ROOT, session.id, file.slice(CONTAINER_SESSION_DIR.length));
  }
  return findSessionFile(file, path.join(SESSION_ROOT, session.id));
}

/** The conversation of a file: its entries from the root to the last, the way pi opens it. */
function pathOf(raw: string): Entry[] {
  const body = raw
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Entry];
      } catch {
        return [];
      }
    })
    .filter((e) => e.type !== "session" && typeof e.id === "string");
  const leaf = body.at(-1)?.id;
  if (!leaf) return [];
  return pathTo(new Map(body.map((e) => [e.id!, e])), leaf);
}

/** One line of the account: what it says, and the message it is, by index. */
interface Block {
  /** The index of the user or agent message it is, or the one it comes just before; -1 for a chat with no message. */
  index: number;
  text: string;
}

/**
 * The conversation as an account: the user's and the agent's words, a line per
 * tool call, the summaries where it was compacted, and the notes an extension
 * wrote into it. Tool results are not in it: they are what the work read, not
 * what the chat said, and they are where the search does not look either.
 */
function blocksOf(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  let index = -1;
  let pending: string[] = [];
  for (const e of entries) {
    if (e.type === "compaction") {
      const summary = String(e.summary ?? "").trim();
      if (summary) pending.push(`[compacted] ${summary}`);
      continue;
    }
    if (e.type === "custom_message") {
      const text = textOf(e.content).trim();
      if (text) pending.push(`[${String(e.customType ?? "note")}] ${text}`);
      continue;
    }
    if (e.type !== "message") continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    index++;
    for (const text of pending) blocks.push({ index, text });
    pending = [];
    const content = e.message?.content;
    const text = textOf(content).trim();
    if (role === "user") {
      if (text) blocks.push({ index, text: `**User:** ${text.startsWith(AUDIO_MESSAGE_PREFIX) ? text.slice(AUDIO_MESSAGE_PREFIX.length) : text}` });
    } else {
      if (text) blocks.push({ index, text: `**Agent:** ${text}` });
      if (Array.isArray(content)) {
        for (const part of content) if (part?.type === "toolCall") blocks.push({ index, text: `→ ${String(part.name ?? "tool")}` });
      }
    }
  }
  for (const text of pending) blocks.push({ index: Math.max(index, 0), text });
  return blocks;
}

/** How many messages the conversation has: the user's and the agent's, the index the last one is. */
function messagesOf(entries: Entry[]): number {
  let count = 0;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const role = e.message?.role;
    if (role === "user" || role === "assistant") count++;
  }
  return count;
}

/** What the search shows of a match: the words around it, on one line. */
function snippet(text: string, at: number): string {
  const radius = 80;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function chatTools(agentId: string, sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: CHAT_LIST_TOOL,
      label: "List your chats",
      description:
        "Your old chats, newest first: id, title, kind, message count and last update. The id is what chat_read takes, and the search names.",
      promptSnippet: "see the chats you have had before",
      parameters: Type.Object({}),
      async execute() {
        const agent = getAgent(agentId);
        if (!agent) return fail("No such agent.");
        const sessions = getDb().prepare("SELECT * FROM sessions").all() as SessionRow[];
        const chats = chatsOf(agent, sessions).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        if (!chats.length) return say("You have no chats.");
        const shown = chats.slice(0, LIST_CAP);
        const lines = shown.map((chat) => {
          const file = fileOf(chat);
          let count = 0;
          if (file) {
            try {
              count = messagesOf(pathOf(readFileSync(file, "utf8")));
            } catch {
              count = 0;
            }
          }
          const here = chat.id === sessionId ? " (this chat)" : "";
          return `- ${chat.id} "${chat.title}" (${chat.kind}, ${count} messages, updated ${chat.updated_at})${here}`;
        });
        const more = chats.length > shown.length ? `
…and ${chats.length - shown.length} older ones, which the search still reaches` : "";
        return say(`${chats.length} chats:
${lines.join("\n")}${more}`);
      },
    });

    pi.registerTool({
      name: CHAT_READ_TOOL,
      label: "Read a chat",
      description:
        "Read one of your old chats as an account: the user's and your messages, a line per tool call, the summaries where it was compacted. A slice of it by message range with from and to.",
      promptSnippet: "read an old chat of yours, whole or in a slice",
      guard: { outside: true },
      parameters: Type.Object({
        id: Type.String({ description: "The chat's id, from chat_list or the search" }),
        from: Type.Optional(Type.Number({ description: "First message, 0-based; default the start" })),
        to: Type.Optional(Type.Number({ description: "Last message, inclusive; default the end" })),
      }),
      async execute(_id: string, p: any) {
        const id = String(p.id ?? "").trim();
        if (!id) return fail("A chat needs an id.");
        const agent = getAgent(agentId);
        if (!agent) return fail("No such agent.");
        const session = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
        if (!session) return fail("No chat with that id.");
        if (agentOf(session.workspace)?.id !== agentId) return fail("That chat is not one of yours.");
        const file = fileOf(session);
        if (!file) return say("That chat has no record yet: pi writes it with the first message it takes in.");
        let raw: string;
        try {
          raw = readFileSync(file, "utf8");
        } catch (e) {
          return fail(`The chat's record could not be read: ${(e as Error).message}`);
        }
        const entries = pathOf(raw);
        const blocks = blocksOf(entries);
        const count = messagesOf(entries);
        if (!count) return say("That chat has no messages in it.");
        let from = p.from === undefined ? 0 : Math.trunc(Number(p.from));
        let to = p.to === undefined ? count - 1 : Math.trunc(Number(p.to));
        if (!Number.isFinite(from) || from < 0) return fail("from is a message index, 0-based.");
        if (from >= count) return fail(`That chat has ${count} messages, 0 to ${count - 1}; from is past the end.`);
        if (!Number.isFinite(to) || to < from) return fail("to is a message index, 0-based, and not before from.");
        if (to >= count) to = count - 1;
        const text = blocks
          .filter((b) => b.index >= from && b.index <= to)
          .map((b) => b.text)
          .join("\n");
        const range = from === 0 && to === count - 1 ? "" : ` — messages ${from} to ${to} of ${count}`;
        let out = `"${session.title}" (chat ${session.id}, ${session.kind}${range})

${text}`;
        if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n…truncated; read a slice with from and to.";
        return say(out);
      },
    });

    pi.registerTool({
      name: CHAT_SEARCH_TOOL,
      label: "Search your chats",
      description:
        "Search across your old chats for words, case-insensitively: each match with the chat it is in and a snippet of what is around it.",
      promptSnippet: "find words across your old chats",
      guard: { outside: true },
      parameters: Type.Object({
        query: Type.String({ description: "The words to find" }),
        limit: Type.Optional(Type.Number({ description: "Most matches to show; default 20, at most 50" })),
      }),
      async execute(_id: string, p: any) {
        const query = String(p.query ?? "").trim();
        if (!query) return fail("Nothing to search for.");
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(p.limit ?? 20)) || 20));
        const agent = getAgent(agentId);
        if (!agent) return fail("No such agent.");
        const sessions = getDb().prepare("SELECT * FROM sessions").all() as SessionRow[];
        const chats = chatsOf(agent, sessions).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const needle = query.toLowerCase();
        const matches: string[] = [];
        for (const chat of chats) {
          const file = fileOf(chat);
          if (!file) continue;
          let raw: string;
          try {
            raw = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          for (const block of blocksOf(pathOf(raw))) {
            if (block.index < 0) continue;
            const at = block.text.toLowerCase().indexOf(needle);
            if (at < 0) continue;
            matches.push(`- ${chat.id} "${chat.title}", message ${block.index}: ${snippet(block.text, at)}`);
            if (matches.length >= limit) break;
          }
          if (matches.length >= limit) break;
        }
        if (!matches.length) return say(`No matches for "${query}" in your chats.`);
        return say(`${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}":
${matches.join("\n")}`);
      },
    });
  };
}
