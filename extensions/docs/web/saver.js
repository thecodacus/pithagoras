/**
 * Saving a document while it is edited: no React and no editor in it, so that
 * what it does can be tried alone (tests/docs-saver.test.mts).
 *
 * It is told when the text changed and reads the text itself when it saves,
 * so what it sends is what the editor holds then, not what it held when the
 * editor last spoke (the editor reports a change a moment after it).
 *
 *   saved -> dirty -> saving -> saved
 *                  \-> conflict   somebody else saved first: nothing is sent
 *                                 until the person has chosen
 *                  \-> error      the save failed: tried again at the next change
 *
 * A save says the revision the text started from (`base`). The server refuses
 * it when the document stands somewhere else now, and says where, and with what
 * text (a 409): the editor goes on holding the person's text, and that is the
 * draft.
 */
export function createSaver({ read, send, onState, delay = 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // The revision the editor's text started from, and what the editor holds of it (its own way of writing the same Markdown).
  let base = 0;
  let baseline = "";
  let timer = null;
  // The save on its way: one at a time, so that a revision is never sent twice.
  let running = null;
  // The warning a save came back with was put away: not said again while the saves keep coming back with it.
  let dismissed = false;
  let state = { status: "saved", base, error: null, conflict: null, warning: null };

  const set = (next) => {
    state = { ...state, ...next };
    onState?.(state);
  };
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const later = () => {
    cancel();
    timer = setTimer(() => {
      timer = null;
      void save();
    }, delay);
  };

  /** What was typed after the last save went out is sent after the usual wait. */
  function settle() {
    if (read() === baseline) return set({ status: "saved", error: null });
    set({ status: "dirty" });
    later();
  }

  function save() {
    cancel();
    if (running || state.status === "conflict") return running ?? Promise.resolve();
    const text = read();
    if (text === baseline) {
      if (state.status !== "saved") set({ status: "saved", error: null });
      return Promise.resolve();
    }
    running = (async () => {
      set({ status: "saving", error: null });
      try {
        const answer = await send(text, base);
        base = answer.revision;
        baseline = text;
        if (!answer.warning) dismissed = false;
        set({ base, warning: dismissed ? null : (answer.warning ?? null) });
      } catch (e) {
        if (e?.status === 409 && Number.isInteger(e.body?.revision)) {
          const theirs = typeof e.body.markdown === "string" ? e.body.markdown : "";
          // Somebody saved the very words that were being saved: there is nothing to choose between.
          if (theirs !== text) return set({ status: "conflict", conflict: { revision: e.body.revision, markdown: theirs } });
          base = e.body.revision;
          baseline = text;
          set({ base });
        } else {
          return set({ status: "error", error: e?.message || String(e) });
        }
      } finally {
        running = null;
      }
      settle();
    })();
    return running;
  }

  /** Saves what is unsaved, and says whether it all is (false: it is waiting on a choice, or failed). */
  async function flush() {
    for (;;) {
      cancel();
      if (running) await running;
      if (state.status === "conflict") return false;
      if (read() === baseline) {
        if (state.status !== "saved") set({ status: "saved", error: null });
        return true;
      }
      await save();
      if (state.status === "conflict" || state.status === "error") return false;
    }
  }

  return {
    state: () => state,

    /** Whether the editor holds text that is not saved: asked of the text itself, since the editor says it changed a moment after it did. */
    unsaved: () => state.status !== "saved" || read() !== baseline,

    /** The editor's text changed. */
    changed() {
      // Nothing is sent until the person has chosen what becomes of the other version.
      if (state.status === "conflict") return;
      if (read() === baseline) {
        cancel();
        if (!running && state.status !== "saved") set({ status: "saved", error: null });
        return;
      }
      if (state.status !== "saving") set({ status: "dirty", error: null });
      later();
    },

    /** The editor holds `text`, the document as it stands at `revision`: loaded, or taken from the server. */
    adopt(revision, text) {
      cancel();
      base = revision;
      baseline = text;
      set({ status: "saved", base, error: null, conflict: null });
    },

    /** The text held was written on revision `from`, and the document stands at `conflict.revision` with `conflict.markdown`: a draft kept from earlier. */
    conflicted(conflict, from) {
      cancel();
      base = from;
      set({ status: "conflict", conflict, base });
    },

    flush,

    /** The warning a save came back with is put away. */
    dismissWarning() {
      dismissed = state.warning !== null;
      set({ warning: null });
    },

    /** Keeps the text as it is as the next revision, after the one that was saved meanwhile. */
    keepMine() {
      if (state.status !== "conflict") return Promise.resolve(false);
      base = state.conflict.revision;
      set({ status: "dirty", base, conflict: null });
      return flush();
    },

    dispose: cancel,
  };
}
