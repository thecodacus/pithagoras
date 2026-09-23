import type { RequestHandler } from 'express';

export function bindHost(password: string | undefined, allowOpen: string | undefined): string {
  return password || allowOpen === '1' ? '0.0.0.0' : '127.0.0.1';
}

/** Bound memory and attempts without trusting client-supplied forwarding headers. */
export function loginThrottle(now = Date.now): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    const key = req.socket.remoteAddress ?? 'unknown';
    const entry = attempts.get(key) ?? { count: 0, until: time + 15 * 60_000 };
    if (entry.count >= 10) {
      res.setHeader('Retry-After', String(Math.ceil((entry.until - time) / 1000)));
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }
    if (!attempts.has(key) && attempts.size >= 4096) {
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }
    entry.count++;
    attempts.set(key, entry);
    res.on('finish', () => { if (res.statusCode < 400) attempts.delete(key); });
    next();
  };
}

/** Apply only to the portal UI, not the separately proxied browser desktop. */
export const portalSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:", "media-src 'self' blob: data:",
    "connect-src 'self' https: http: ws: wss:", "worker-src 'self' blob:",
    "frame-src 'self' https: http:", "object-src 'none'", "base-uri 'self'",
    "frame-ancestors 'self'", "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};
