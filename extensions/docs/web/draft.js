/**
 * A comment being written, saved as it is typed: no React in it, so that what
 * it does can be tried alone (extensions/docs/test/draft.test.mts).
 *
 * The box tells it what was typed (`changed`), and it sends that after a short
 * while with nothing more typed, as the document's own autosave does (saver.js).
 * The first save makes the comment (`save(text, null)`), the next ones change
 * it (`save(text, id)`), and typing it all away takes it away (`remove(id)`).
 * One request at a time: what is typed while one is on its way is sent after
 * it. A request that failed leaves the text as it is, and the next change, or
 * `flush`, tries again.
 *
 *   `save(text, id)`  makes or changes the comment, and answers with its id
 *   `remove(id)`      takes the comment away
 *   `onState(state)`  `{ id, saving, error }`: the comment saved so far, and how it stands
 */
export function createDraft({ save, remove, onState, delay = 700, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let text = "";
  let id = null;
  let dirty = false;
  let error = null;
  let saving = false;
  let timer = null;
  let running = null;

  const tell = () => onState?.({ id, saving, error });
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  function run() {
    cancel();
    if (running) return running;
    running = (async () => {
      // After `running` is set: with nothing to send, the loop would end, and `running` be cleared, before it was.
      await null;
      try {
        while (dirty) {
          const typed = text;
          dirty = false;
          saving = true;
          error = null;
          tell();
          try {
            if (!typed.trim()) {
              if (id !== null) {
                const gone = id;
                await remove(gone);
                if (id === gone) id = null;
              }
            } else {
              id = await save(typed, id);
            }
          } catch (e) {
            // What was typed is kept, and sent with the next change.
            dirty = true;
            error = e;
            return;
          }
        }
      } finally {
        saving = false;
        running = null;
        tell();
      }
    })();
    return running;
  }

  return {
    /** The text in the box is now `next`. */
    changed(next) {
      text = next;
      dirty = true;
      if (!running) {
        cancel();
        timer = setTimer(() => {
          timer = null;
          void run();
        }, delay);
      }
    },
    /** Saves what was typed now. True once nothing typed is unsaved. */
    async flush() {
      cancel();
      if (dirty || running) await run();
      return !dirty;
    },
    /** Saves what was typed, and lets the comment go: the next thing typed is a comment of its own. True when it was saved. */
    async settle() {
      if (!(await this.flush())) return false;
      text = "";
      id = null;
      tell();
      return true;
    },
    /** Takes away what was saved, and what was typed: the comment is not to be. True when it is gone. */
    async discard() {
      cancel();
      if (running) await running;
      dirty = false;
      text = "";
      error = null;
      if (id !== null) {
        try {
          await remove(id);
        } catch (e) {
          error = e;
          tell();
          return false;
        }
        id = null;
      }
      tell();
      return true;
    },
    /** What the comment is, as far as it is saved. */
    state: () => ({ id, saving, error }),
  };
}
