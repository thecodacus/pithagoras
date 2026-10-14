/**
 * Keystrokes for a shell, sent in the order they were typed.
 *
 * Each key used to be a request of its own, and requests can overtake one
 * another on the way: typed quickly, `echo hello` reached the shell as
 * `ecohh lelo`. Here one request is out at a time; what is typed meanwhile is
 * joined and goes next, so a burst costs a request or two instead of one per key.
 *
 * `failed` hears of each request that did not arrive; later keys are still tried.
 */
export function orderedInput(send: (data: string) => Promise<unknown>, failed: () => void): (data: string) => void {
  let out = false;
  let queued = "";
  const drain = async () => {
    out = true;
    while (queued) {
      const data = queued;
      queued = "";
      try {
        await send(data);
      } catch {
        failed();
      }
    }
    out = false;
  };
  return (data) => {
    queued += data;
    if (!out) void drain();
  };
}
