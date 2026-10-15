/**
 * A document that is changed while it is open: no React, no editor library and
 * no network of its own in it, so that what it does can be tried alone
 * (extensions/docs/test/live.test.mts).
 *
 * The page is told which revision the document is at (`seen`), as the server
 * half's stream says it, and asks for its text. What it does with it depends on
 * what the person has in the editor:
 *
 *   nothing of their own (all saved)  the text is put in place of the editor's, where it differs
 *   unsaved text                      the change is made to that text too, as far as the person's
 *                                     own changes allow (merge.js); the text is then unsaved
 *                                     again, on the new revision, and is saved as usual
 *   a change that meets theirs        nothing is merged: the conflict the person chooses in,
 *                                     with their text kept (the saver's)
 *
 * The same is done with what the server made of a save that started from an
 * earlier revision (`merged`), which the saver hands over.
 *
 * Everything is compared as the editor writes Markdown, not as the file has it:
 * a document written in another style (`*` bullets) is the same text on both
 * sides of a merge, so that style alone is no change.
 */
import { merge3 } from "./merge.js";

/**
 * `editor`: `markdown()` (what it holds), `normalize(markdown)` (a text as the editor writes it) and `apply(markdown)`
 * (puts a text in its place, changing what differs and no more). `saver`: saver.js. `load()` resolves the document
 * as it is now: `{ revision, markdown }`; `revision` is the one the editor was loaded at. `notify(what)` is told what
 * was done: `{ kind: "updated" | "merged" | "conflict", revision, author }`. A request that fails is made again after
 * `retryMs`, twice as long each time (at most 30 s); `setTimer` and `clearTimer` are the clock.
 */
export function createLive({ editor, saver, load, notify, revision = 0, merge = merge3, retryMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // The newest revision looked at, whatever came of it (a conflict keeps the base where it was); and the one that is wanted.
  let looked = revision;
  let wanted = 0;
  let author = null;
  let running = false;
  let closed = false;
  // The wait before a request that failed is made again: the stream is healthy then (it says nothing until the document changes), so
  // nothing else would ask for the text.
  let failures = 0;
  let retry = null;

  const known = () => Math.max(looked, saver.state().base);

  /** The document and the person's text meet: the person is to choose, and nothing is sent until they have. Their text is kept. */
  function conflict(theirs, what) {
    saver.conflicted({ revision: theirs.revision, markdown: theirs.markdown }, saver.state().base);
    notify({ kind: "conflict", ...what });
  }

  /**
   * `theirs` (`{ revision, markdown }`) is the document, and the editor's text started from `from`, which is not it.
   * `joined`: the server made it of the person's save and a later revision, so the person's changes are in it.
   * One step: nothing is waited for in it, so what is typed meanwhile cannot fall between.
   */
  function incorporate(theirs, from, joined) {
    looked = Math.max(looked, theirs.revision);
    const what = { revision: theirs.revision, author };
    try {
      // Already a conflict: the other version is the newer one now, and nothing is tried again.
      if (saver.state().status === "conflict") return conflict(theirs, what);
      const mine = editor.markdown();
      if (mine === from) {
        editor.apply(theirs.markdown);
        saver.adopt(theirs.revision, editor.markdown());
        return notify({ kind: joined ? "merged" : "updated", ...what });
      }
      const theirText = editor.normalize(theirs.markdown);
      const text = merge(from, mine, theirText);
      if (text === null) return conflict(theirs, what);
      editor.apply(text);
      saver.rebase(theirs.revision, theirText);
      notify({ kind: "merged", ...what });
    } catch {
      // The editor could not take it up (a text it cannot read): the person's text is not touched, and the other version is theirs to choose.
      conflict(theirs, what);
    }
  }

  async function catchUp() {
    if (running) return;
    running = true;
    try {
      while (wanted > known() && !closed) {
        // A save on its way comes first: it may be the very change that is wanted (the stream often says a page's own save before its
        // answer comes), and what it sends is what the editor held then.
        await saver.idle();
        if (closed) return;
        if (wanted <= known()) break;
        const theirs = await load();
        await saver.idle();
        if (closed) return;
        if (theirs.revision <= known()) {
          // The document is no further than that, whatever was said.
          wanted = known();
          break;
        }
        incorporate(theirs, saver.baseline());
      }
      failures = 0;
    } catch {
      // The editor is as it was: the text is asked for again after a while (or sooner, by the next message).
      if (!closed && retry === null) {
        retry = setTimer(() => {
          retry = null;
          void catchUp();
        }, Math.min(retryMs * 2 ** failures++, 30_000));
      }
    } finally {
      running = false;
    }
  }

  return {
    /** The document is at `change.revision` (made by `change.author`): as far as the page is not there, it goes there. */
    seen(change) {
      if (closed || !Number.isInteger(change?.revision) || change.revision <= known()) return Promise.resolve();
      wanted = Math.max(wanted, change.revision);
      author = change.author ?? null;
      return catchUp();
    },

    /** The server put a save together with a later revision: `answer` has the text that was saved (`markdown`); `sent` is the text that was sent. */
    merged(answer, sent) {
      if (closed) return;
      author = null;
      incorporate({ revision: answer.revision, markdown: answer.markdown }, sent, true);
    },

    /** The page is done with the document: nothing more is taken up. */
    close() {
      closed = true;
      if (retry !== null) clearTimer(retry);
      retry = null;
    },
  };
}
