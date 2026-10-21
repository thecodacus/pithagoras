import type { RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import net from 'node:net';

/** Running without a login is a deliberate choice, never what an empty .env falls back to. */
export const allowNoPassword = (): boolean => /^(1|true|yes)$/i.test(process.env.PORTAL_ALLOW_NO_PASSWORD ?? '');

/**
 * Where the portal listens: everywhere once there is a login in front of it (or one to be chosen
 * on the setup screen), and on this machine only where it is open by choice, unless ALLOW_OPEN says otherwise.
 */
export function bindHost(login: boolean, allowOpen: string | undefined): string {
  return login || allowOpen === '1' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Who an address counts as, for the throttle. A network hands out a /64 to one
 * subscriber, so an IPv6 address is only its first four groups: one machine
 * cannot have every address of its block fail once each. An IPv4 address mapped
 * into IPv6 is the IPv4 address it carries.
 */
export function throttleKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!net.isIPv6(address)) return address;
  // `::` stands for however many zero groups make eight.
  const [head, tail] = address.split('%')[0].split('::');
  const groups = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  const all = tail === undefined ? groups : [...groups, ...Array(Math.max(0, 8 - groups.length - rest.length)).fill('0'), ...rest];
  return all.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':') + '::/64';
}

/** Attempts a window lets through before a newcomer, who would have to push another out, is refused. */
const WINDOW_BUDGET = 4096 * 10;

/** Bound memory and attempts without trusting client-supplied forwarding headers. */
export function loginThrottle(now = Date.now): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  // What the window has counted, those that were pushed out of the map included: an address that stops at nine
  // and comes back after 4096 others would otherwise start at nought each time, and the limits above it never bind.
  let spent = 0;
  let windowEnds = 0;
  return (req, res, next) => {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    if (time >= windowEnds) { spent = 0; windowEnds = time + 15 * 60_000; }
    const key = throttleKey(req.socket.remoteAddress);
    const entry = attempts.get(key) ?? { count: 0, until: time + 15 * 60_000 };
    const refuse = (until: number) => {
      res.setHeader('Retry-After', String(Math.ceil((until - time) / 1000)));
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    };
    if (entry.count >= 10) return refuse(entry.until);
    // Full: the entry that runs out first makes room, rather than the newcomer
    // being refused — with enough addresses, that would keep everyone else out.
    // They are in the order they were made, and so in the order they run out.
    // A locked entry is never the one: dropping it would give its address ten
    // more guesses for every 4096 others, so only when all of them are locked
    // is the newcomer refused. Nor is anybody let in without end by pushing
    // others out: once the window's budget is spent, a newcomer waits for the next.
    if (!attempts.has(key) && attempts.size >= 4096) {
      let room: string | undefined;
      for (const [other, value] of attempts) if (value.count < 10) { room = other; break; }
      if (room === undefined) return refuse(attempts.values().next().value!.until);
      if (spent >= WINDOW_BUDGET) return refuse(windowEnds);
      attempts.delete(room);
    }
    entry.count++;
    spent++;
    attempts.set(key, entry);
    // A route that checks the password and then refuses for another reason says so in `res.locals.passwordRight`:
    // that is no guess, and counts like a login that worked.
    res.on('finish', () => { if (res.statusCode < 400 || res.locals.passwordRight === true) attempts.delete(key); });
    next();
  };
}

/**
 * Apply only to the portal UI, not to an extension's routes (/api/x), such as a page one proxies.
 *
 * Pictures come from the portal itself: the browser fetches whatever an `<img>`
 * names the moment it is drawn, so any other host there would be a way for a
 * reply or a page the agent read to send what it has seen out, unseen.
 */
export const portalSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "media-src 'self' blob: data:",
    "connect-src 'self' https: http: ws: wss:", "worker-src 'self' blob:",
    "frame-src 'self' https: http:", "object-src 'none'", "base-uri 'self'",
    "frame-ancestors 'self'", "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

/**
 * The certificate and key the portal serves TLS with: both named, and both
 * there. The one decision, read by the server and by whatever must know how
 * the portal is reached.
 */
export function tlsFiles(): { cert: string; key: string } | null {
  const cert = process.env.PORTAL_TLS_CERT;
  const key = process.env.PORTAL_TLS_KEY;
  return cert && key && existsSync(cert) && existsSync(key) ? { cert, key } : null;
}
