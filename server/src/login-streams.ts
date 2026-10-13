/**
 * Streams that were opened under a login and are still open: a cookie is only looked at when a request
 * arrives, so a change of the password ends the logins but not what they had open (an event stream, a
 * terminal, the agent's browser). Each is kept with the password it was opened under, and ended once that
 * is not the password any more.
 *
 * Apart from auth.ts, which opens the database and reads the environment as it loads, so that the routes
 * that hold streams can be loaded without them. Until the login is bound, nothing is watched.
 */

export interface Login {
  /** What logins are signed under now (the password's hash, with the provider's settings where single sign-on is set up), or undefined where there is no password. */
  hash(): string | undefined;
}

let login: Login | undefined;
export const bindLogin = (bound: Login): void => {
  login = bound;
};

const streams = new Set<{ hash: string; end: () => void }>();
let sweeper: ReturnType<typeof setInterval> | undefined;

/** Ends every stream that was opened under a password that is not the one now. */
export function sweep(): void {
  const hash = login?.hash();
  for (const stream of streams) {
    if (stream.hash === hash) continue;
    streams.delete(stream);
    stream.end();
  }
  if (streams.size === 0) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/**
 * Ties a stream to the password it was opened under: `end` is called when the password changes, in any
 * browser (the one that changed it too: a cookie is a copyable string, so no stream is "its own", and the
 * page opens its streams again with the cookie the change signed it in with) or with the command that
 * removes it, and the returned function lets go of the stream when it closes by itself. The command runs
 * in another process, so what it did is noticed on a timer.
 */
export function watchStream(end: () => void): () => void {
  const hash = login?.hash();
  if (!hash) return () => {};
  const stream = { hash, end };
  streams.add(stream);
  sweeper ??= setInterval(sweep, 2000).unref();
  return () => void streams.delete(stream);
}
