import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Shared-password gate.
 *
 * This portal can run arbitrary code on the host, so even on a Tailscale-only
 * network it should not be drivable by anything that happens to reach the port.
 * The cookie is an HMAC of an expiry stamp — no session store needed.
 */
const PASSWORD = process.env.PORTAL_PASSWORD || "";
const SECRET = process.env.PORTAL_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = (process.env.VOICE_COMPARISON === "true" || process.env.VOICE_PIPELINE_MODE === "sequential") ? "pi_portal_sequential_auth" : "pi_portal_auth";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const authEnabled = PASSWORD.length > 0;

if (!authEnabled) {
  console.warn(
    "\n  WARNING: PORTAL_PASSWORD is not set — authentication is disabled.\n" +
      "  The portal binds loopback unless ALLOW_OPEN=1 explicitly exposes it.\n" +
      "  Set PORTAL_PASSWORD (and PORTAL_SECRET to keep logins across restarts).\n"
  );
}

function sign(expiry: number): string {
  const mac = crypto.createHmac("sha256", SECRET).update(String(expiry)).digest("hex");
  return `${expiry}.${mac}`;
}

function verify(token: string | undefined): boolean {
  if (!token) return false;
  const [expiryStr, mac] = token.split(".");
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(expiryStr).digest("hex");
  const a = Buffer.from(mac ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueCookie(res: Response): void {
  res.cookie(COOKIE, sign(Date.now() + MAX_AGE_MS), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
  });
}

export function checkPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !authEnabled) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled) return next();
  if (verify(req.cookies?.[COOKIE])) return next();
  res.status(401).json({ error: "Unauthorized" });
}

export function isAuthed(req: Request): boolean {
  return !authEnabled || verify(req.cookies?.[COOKIE]);
}
