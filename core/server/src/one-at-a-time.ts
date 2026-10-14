/**
 * Runs the steps it is given one after the other, in the order they came,
 * whether the one before succeeded or not.
 *
 * For what must not overlap: two installs into the same package folder are an
 * ENOTEMPTY or a settings file written by both.
 */
export function oneAtATime(): <T>(step: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (step) => {
    const next = last.catch(() => {}).then(step);
    last = next;
    return next;
  };
}
