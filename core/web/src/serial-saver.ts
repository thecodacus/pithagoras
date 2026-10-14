/**
 * Saves a value one request at a time, and always ends on the last one asked for.
 *
 * A slider or a switch can be moved again before its save has come back. Sending
 * each move as its own request lets the answers arrive in any order, so the
 * server can end up on a value that is not the last one picked; refusing a move
 * because its value is already being saved loses a later move back to that value
 * (low, high, low). Here a move made while a save is out only replaces what is
 * waiting, and once the save returns the waiting value is sent — unless it is the
 * one that was just saved.
 *
 * `settled` runs after the last save, before the saver is free again, so what
 * comes of a save (a reload, say) is still covered by the same busy state.
 */
export function serialSaver<T>(save: (value: T) => Promise<void>, settled?: () => Promise<void> | void) {
  let running = false;
  let waiting: { value: T } | undefined;
  const waitingNow = () => waiting;
  return {
    /** True from the first request until the last save and `settled` are done. */
    get busy() {
      return running;
    },
    /**
     * Resolves when everything is saved if this call started the saving, and at
     * once if a save was already out and this only left the value waiting for it.
     */
    async request(value: T): Promise<void> {
      if (running) {
        waiting = { value };
        return;
      }
      running = true;
      try {
        let next = value;
        for (;;) {
          waiting = undefined;
          await save(next);
          // Read through a function: the compiler has seen `waiting` cleared just
          // above and cannot know a request made during the save set it again.
          const asked = waitingNow();
          if (!asked || asked.value === next) break;
          next = asked.value;
        }
        await settled?.();
      } finally {
        running = false;
        waiting = undefined;
      }
    },
  };
}
