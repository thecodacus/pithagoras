/**
 * What the agent is writing in a document, drawn in the chat's page while the
 * model writes the call, from the chat's calls as the page has them
 * (`ChatFeed.calls`): doc_create's Markdown, and the document doc_edit changes
 * with the edits that have come so far. Nothing of it is saved: the tool saves
 * when it runs, as it always did, and the document's own stream brings what
 * it saved. Only the page that has the chat open does any of this.
 *
 * No React and no network in it, so that what it does can be tried alone
 * (test/writing.test.mts).
 */

/** The agent's tools that write a document. */
export const WRITING_TOOLS = new Set(["doc_create", "doc_edit"]);

/** A document's id, as the store gives it: what a doc_edit names is opened once all of it has come. */
export const isDocumentId = (id) => typeof id === "string" && /^[0-9a-f]{16}$/.test(id);

const plain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether two lists of calls are drawn alike: the same calls, in the same state, with the same arguments as far as they were read. */
export const sameCalls = (a, b) => a.length === b.length && a.every((call, i) => call.callId === b[i].callId && call.status === b[i].status && call.input === b[i].input);

/** Whether a call is drawn alike: see sameCalls. */
export const sameCall = (a, b) => a === b || (a !== undefined && b !== undefined && sameCalls([a], [b]));

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
 * is stored, none overlapping. An edit is made once its replacement has begun after its quote (the quote is whole then); one
 * that is not there, is there twice or overlaps another is left out of the draft, and the tool says why when it runs.
 */
export function drafted(markdown, edits) {
  const found = [];
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!plain(edit) || Object.keys(edit)[0] !== "quote" || typeof edit.replacement !== "string" || typeof edit.quote !== "string" || !edit.quote) continue;
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

/** What a draft shows of a document: its text without a front matter block, which the editor keeps apart too. */
export const shownOf = (markdown) => markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");

/** What a draft shows of a new document: with its title as its first heading when the Markdown has none of its own near its top, as doc_create makes it. */
export function shownNew(title, markdown) {
  const body = shownOf(typeof markdown === "string" ? markdown : "");
  return typeof title === "string" && title.trim() && !/^ {0,3}#{1,6}(?:\s|$)/m.test(body.slice(0, 4096)) ? `# ${title.trim()}\n\n${body.replace(/^(?:[ \t]*\r?\n)+/, "")}` : body;
}
