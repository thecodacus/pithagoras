/**
 * What the agent is writing in a document, while the model is still writing
 * the call: doc_create's Markdown, and the document doc_edit changes with the
 * edits that have come so far. The pages open on the chat show it (the
 * Documents panel, which opens for it); nothing is saved until the tool runs,
 * as before, and the end of the call says what came of it.
 *
 * pi reads a call's arguments as they stream in: the message it is writing
 * (`partial`) has them, each string as far as it has come. Nothing is parsed
 * here. A call is followed by its own name, or through the `tools` tool where
 * the tool is lazy, as the chat offers it now (`chats.offers`): a call by a
 * name it is not offered under is refused and never runs, and its text is
 * nobody's document. A call through `tools` whose arguments are given as the
 * text of an object, not an object, is not followed: it is shown once it is
 * done, as every call was before.
 *
 * Messages to the pages (`chats.send`), at most one for each call every
 * EVERY_MS while it is written:
 *
 *   { type: "writing", call, tool: "create", folder, title, markdown }
 *   { type: "writing", call, tool: "edit", folder, id, revision, markdown }   the document with the edits so far
 *   { type: "written", call, ok, folder?, id? }                                  the call ended, or the run did without it
 */

const TOOLS = { doc_create: "create", doc_edit: "edit" };
const GATEWAY_TOOL = "tools";
/** How often the pages are told of a call that is being written. */
export const EVERY_MS = 250;
/** A document's id, as the store gives it: what a doc_edit names is followed once all of it has come. */
const DOCUMENT_ID = /^[0-9a-f]{16}$/;

const plain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === "string" ? v : "");

/** Where `quote` is in `markdown`, once; nothing for a quote that is not there, or is there more than once. A quote with line feeds is looked for with CRLF too. */
function findOnce(markdown, quote) {
  for (const q of quote.includes("\n") && markdown.includes("\r\n") ? [quote, quote.replace(/\r?\n/g, "\r\n")] : [quote]) {
    const at = markdown.indexOf(q);
    if (at !== -1) return markdown.indexOf(q, at + 1) === -1 ? { at, end: at + q.length } : undefined;
  }
  return undefined;
}

/**
 * The document with the edits that have come so far, as doc_edit will make them: each quote found once in the document as it
 * is, none overlapping. An edit is made once its replacement has begun after its quote (the quote is whole then); one that is
 * not there, is there twice or overlaps another is left out of the draft, and the tool says why when it runs.
 */
export function drafted(markdown, edits) {
  const found = [];
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!plain(edit) || Object.keys(edit)[0] !== "quote" || typeof edit.replacement !== "string" || !text(edit.quote)) continue;
    const place = findOnce(markdown, edit.quote);
    if (place && !found.some((f) => place.at < f.end && f.at < place.end)) found.push({ ...place, replacement: edit.replacement });
  }
  found.sort((a, b) => a.at - b.at);
  let out = "";
  let from = 0;
  for (const f of found) {
    out += markdown.slice(from, f.at) + f.replacement;
    from = f.end;
  }
  return out + markdown.slice(from);
}

/**
 * Follows the doc_create and doc_edit calls of chats as they are written. `offers(chat, tool)` is `chats.offers`;
 * `folderOf(chat)` the id of the chat's folder; `documentOf(chat, id)` resolves a document the chat sees as
 * `{ folder, id, revision, markdown }`, or nothing; `send(chat, message)` is `chats.send`.
 */
export function followWriting({ offers, folderOf, documentOf, send, log = () => {}, every = EVERY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** By chat: the calls being written, by call id. */
  const chats = new Map();

  /** The call a tool call in the message is, as it has come so far: one of the two tools and its arguments, or nothing. */
  function callOf(chat, tool) {
    const direct = TOOLS[tool.name];
    if (direct) return offers(chat, tool.name) === "direct" && plain(tool.arguments) ? { tool: direct, args: tool.arguments } : undefined;
    if (tool.name !== GATEWAY_TOOL || !plain(tool.arguments)) return undefined;
    const { action, name, args } = tool.arguments;
    return action === "call" && TOOLS[name] && offers(chat, name) === "lazy" && plain(args) ? { tool: TOOLS[name], args } : undefined;
  }

  /** What the pages are to be shown of a call now: nothing while there is nothing to show of it yet. */
  function message(chat, call, write) {
    const { args } = write;
    if (write.tool === "create") return { type: "writing", call, tool: "create", folder: write.folder, title: text(args.title), markdown: text(args.markdown) };
    if (!write.base) return undefined;
    const { folder, id, revision, markdown } = write.base;
    return { type: "writing", call, tool: "edit", folder, id, revision, markdown: drafted(markdown, args.edits) };
  }

  function flush(chat) {
    const calls = chats.get(chat);
    if (!calls) return;
    calls.timer = null;
    for (const [call, write] of calls.writes) {
      if (!write.dirty) continue;
      write.dirty = false;
      const said = message(chat, call, write);
      if (said) send(chat, said);
    }
  }

  function changed(chat, write) {
    write.dirty = true;
    const calls = chats.get(chat);
    calls.timer ??= setTimer(() => flush(chat), every);
  }

  /** The document a doc_edit names, read once, as soon as all of its id has come. */
  function load(chat, write) {
    const id = write.args.id;
    if (write.loading || !DOCUMENT_ID.test(text(id))) return;
    write.loading = Promise.resolve()
      .then(() => documentOf(chat, id))
      .then(
        (base) => {
          if (!base || chats.get(chat)?.writes.get(write.call) !== write) return;
          write.base = base;
          changed(chat, write);
        },
        (e) => log(`A document being edited in chat ${chat} could not be read: ${e?.message ?? e}`),
      );
  }

  /** The call is over: the pages are told how, with what it made or changed when it did. */
  function end(chat, call, outcome) {
    const calls = chats.get(chat);
    const write = calls?.writes.get(call);
    if (!write) return;
    calls.writes.delete(call);
    // What it last had is said before its end, so that a page shows the end of what was written, not what was written 250 ms before.
    if (write.dirty) {
      write.dirty = false;
      const said = message(chat, call, write);
      if (said) send(chat, said);
    }
    send(chat, { type: "written", call, ...outcome });
    if (!calls.writes.size) {
      clearTimer(calls.timer);
      chats.delete(chat);
    }
  }

  function observe(chat, event) {
    const inner = event?.assistantMessageEvent;
    if (event?.type === "message_update" && inner?.type === "toolcall_delta") {
      const tool = inner.partial?.content?.[inner.contentIndex];
      if (!tool?.id) return;
      const known = chats.get(chat)?.writes.get(tool.id);
      const found = callOf(chat, tool);
      if (!found || (known && known.tool !== found.tool)) return;
      let calls = chats.get(chat);
      if (!calls) chats.set(chat, (calls = { writes: new Map(), timer: null }));
      let write = calls.writes.get(tool.id);
      if (!write) {
        let folder;
        try {
          folder = folderOf(chat);
        } catch {
          // The chat's folder is gone: the tool will say so, and there is nothing to show.
          return;
        }
        write = { call: tool.id, tool: found.tool, folder, args: found.args, dirty: false, loading: null, base: null };
        calls.writes.set(tool.id, write);
      }
      write.args = found.args;
      if (write.tool === "edit") load(chat, write);
      changed(chat, write);
      return;
    }
    if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const details = event.result?.details;
      const ok = !event.isError && typeof details?.id === "string";
      end(chat, event.toolCallId, ok ? { ok: true, folder: details.folder, id: details.id } : { ok: false });
      return;
    }
    // The run is over: a call it did not end was not run, and is not being written any more.
    if (event?.type === "agent_end" || event?.type === "agent_settled") forget(chat);
  }

  /** The calls of a chat being written now end as not made: the run, or the chat's pi, is over. */
  function forget(chat) {
    for (const call of [...(chats.get(chat)?.writes.keys() ?? [])]) end(chat, call, { ok: false });
  }

  return {
    observe,
    forget,
    /** What a page that opens the chat is told first: the calls being written now, as far as they have come. */
    opened(chat) {
      const list = [...(chats.get(chat)?.writes ?? [])].map(([call, write]) => message(chat, call, write)).filter(Boolean);
      return list.length ? { type: "writings", list } : undefined;
    },
    stop() {
      for (const calls of chats.values()) clearTimer(calls.timer);
      chats.clear();
    },
  };
}
