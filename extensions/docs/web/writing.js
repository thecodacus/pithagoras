/**
 * What the agent is writing in documents, by chat, as the server half tells
 * the pages open on a chat (../writing.js): the draft of each call while the
 * model writes it, and how it ended. Kept by this page alone, with no React in
 * it, so that what it does can be tried alone (test/writing.test.mts).
 *
 * Each chat's calls are a Map by call id, of `{ call, tool, folder, id?, title?,
 * markdown, done, ok? }`; a new Map whenever one changes, so that a hook can
 * tell a change by its identity.
 */

const EMPTY = new Map();
/** How many ended calls a chat keeps: enough for a panel that opened on one to find how it ended. */
const KEPT = 20;

export function writingStore() {
  const chats = new Map();
  const listeners = new Set();
  const set = (chat, calls) => {
    chats.set(chat, calls);
    for (const listener of [...listeners]) listener();
  };
  return {
    /** A message of the server half's to the pages of `chat`: anything else is not one of these, and is left alone. */
    hear(chat, data) {
      if (data?.type === "writings" && Array.isArray(data.list)) {
        return set(chat, new Map(data.list.filter((w) => typeof w?.call === "string").map((w) => [w.call, { ...w, done: false }])));
      }
      if (typeof data?.call !== "string") return;
      const calls = chats.get(chat) ?? EMPTY;
      if (data.type === "writing") {
        const next = new Map(calls);
        next.set(data.call, { ...data, done: false });
        // The oldest of the ended ones go first.
        for (const [call, write] of next) if (next.size > KEPT && write.done) next.delete(call);
        return set(chat, next);
      }
      if (data.type === "written") {
        const was = calls.get(data.call);
        if (!was) return;
        const next = new Map(calls);
        next.set(data.call, { ...was, done: true, ok: data.ok === true, ...(data.ok === true ? { folder: data.folder, id: data.id } : {}) });
        return set(chat, next);
      }
    },
    /** The calls of `chat`, being written and ended. */
    of: (chat) => chats.get(chat) ?? EMPTY,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What a draft shows of a document: its text without a front matter block, which the editor keeps apart too. */
export const shownOf = (markdown) => markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");

/** What a draft shows of a new document: with its title as its first heading when the Markdown has none of its own near its top, as doc_create makes it. */
export function shownNew(title, markdown) {
  const body = shownOf(markdown);
  return title && !/^ {0,3}#{1,6}(?:\s|$)/m.test(body.slice(0, 4096)) ? `# ${title}\n\n${body.replace(/^(?:[ \t]*\r?\n)+/, "")}` : body;
}
