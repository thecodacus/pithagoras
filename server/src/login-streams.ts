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
  /** The hash of the password now, or undefined where there is none. */
  hash(): string | undefined;
  /** The login cookie a request carries. */
  cookie(req: StreamRequest): string | undefined;
}

export interface StreamRequest {
  cookies?: Record<string, string>;
  headers: { cookie?: string };
}

let login: Login | undefined;
export const bindLogin = (bound: Login): void => {
  login = bound;
};

const streams = new Set<{ hash: string; cookie: string | undefined; end: () => void }>();
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
 * Ties a stream to the login it was opened with: `end` is called when the password changes, in another
 * browser or with the command that removes it, and the returned function lets go of the stream when it
 * closes by itself. The command runs in another process, so what it did is noticed on a timer.
 */
export function watchStream(req: StreamRequest, end: () => void): () => void {
  const hash = login?.hash();
  if (!login || !hash) return () => {};
  const stream = { hash, cookie: login.cookie(req), end };
  streams.add(stream);
  sweeper ??= setInterval(sweep, 2000).unref();
  return () => void streams.delete(stream);
}

/**
 * After a change of the password to `hash`: the streams of the login that made it are the person's own and
 * go on under the new one, and every other is ended.
 */
export function keepStreams(cookie: string | undefined, hash: string): void {
  if (cookie !== undefined) for (const stream of streams) if (stream.cookie === cookie) stream.hash = hash;
  sweep();
}
