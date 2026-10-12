import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getDb, getSetting, isSignedOut, putSetting, recordSignOut } from "./db.js";
import { tlsFiles } from "./http-security.js";
import { allowsAnyone, fingerprint, oidcConfig } from "./oidc.js";

/**
 * Shared-password gate.
 *
 * This portal can run arbitrary code on the host, so even on a Tailscale-only
 * network it should not be drivable by anything that happens to reach the port.
 * The cookie is an HMAC of an expiry stamp — no session store needed, except
 * for the ones signed out early, which are remembered until they would expire.
 * The key holds the password as well as the secret, so changing the password
 * ends every login that was made under the old one. A sign-in through an
 * OpenID Connect provider (oidc-login.ts) ends in the same cookie.
 */
const PASSWORD = process.env.PORTAL_PASSWORD || "";
const SECRET = process.env.PORTAL_SECRET || crypto.randomBytes(32).toString("hex");
// What a .env written from the deploying guide's old example holds: nothing runs a command in that
// file, so the secret is the command's own text, the same on every install that copied it.
if (/^\$\(/.test(process.env.PORTAL_SECRET ?? "")) {
  console.warn(
    "\n  WARNING: PORTAL_SECRET is a shell command, not a secret: a .env file is not run through a shell,\n" +
      "  so it was taken as written, and anybody who has read the guide knows it. Put the output of\n" +
      "  `openssl rand -hex 32` there instead.\n"
  );
}
const COOKIE = (process.env.VOICE_COMPARISON === "true" || process.env.VOICE_PIPELINE_MODE === "sequential") ? "pi_portal_sequential_auth" : "pi_portal_auth";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** The password is a way in: one is set, and single sign-on has not been made the only way. */
export const passwordLogin = PASSWORD.length > 0 && !oidcConfig?.only;
export const authEnabled = passwordLogin || oidcConfig !== null;
/** The example in .env.example and the README, which is public: nobody's password. */
const EXAMPLE_PASSWORD = "change-me";
const MIN_PASSWORD_LENGTH = 8;
/** Running without a login is a deliberate choice, never what an empty .env falls back to. */
const allowNoPassword = /^(1|true|yes)$/i.test(process.env.PORTAL_ALLOW_NO_PASSWORD ?? "");

if (!authEnabled && !allowNoPassword) {
  console.error(
    "\n  PORTAL_PASSWORD is not set. This portal runs arbitrary commands on the\n" +
      "  host, so it refuses to start without a login rather than open the port.\n" +
      "  Set PORTAL_PASSWORD or OIDC_ISSUER (and PORTAL_SECRET to keep logins across restarts),\n" +
      "  or set PORTAL_ALLOW_NO_PASSWORD=1 when a reverse proxy authenticates in\n" +
      "  front of it and nothing else can reach the port.\n"
  );
  process.exit(1);
}

/**
 * A short password only stops a portal it is new to. The minimum came after
 * installs that already had a shorter one, which must still start: the portal
 * remembers the password it ran with (salted and hashed, in its own settings),
 * and one it has run with before keeps working, with a warning. An install
 * from before it remembered anything is told by having been used.
 */
const LOGIN_STAMP = "login_password";

const stampOf = (password: string): string => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
};

function isStamp(stamp: string, password: string): boolean {
  const [salt, hash] = stamp.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(salt, "hex"), expected.length), expected);
}

/** Whether this portal has been used before: it holds a chat. A new one holds settings of its own already. */
const hasBeenUsed = (): boolean => getDb().prepare("SELECT 1 FROM sessions LIMIT 1").get() !== undefined;

const tooShort = passwordLogin && PASSWORD !== EXAMPLE_PASSWORD && PASSWORD.length < MIN_PASSWORD_LENGTH;

/** The password is shorter than the minimum, but this portal has run with it before. */
export const keptShortPassword = tooShort && (() => {
  const stamp = getSetting(LOGIN_STAMP);
  return stamp ? isStamp(stamp, PASSWORD) : hasBeenUsed();
})();

if (passwordLogin && (PASSWORD === EXAMPLE_PASSWORD || (tooShort && !keptShortPassword))) {
  console.error(
    "\n  PORTAL_PASSWORD is the example from .env.example or shorter than " + MIN_PASSWORD_LENGTH + " characters.\n" +
      "  This portal runs arbitrary commands on the host and listens on every\n" +
      "  interface once it has a password, so it refuses to start with one that\n" +
      "  anybody could guess. Choose a longer one.\n"
  );
  process.exit(1);
}

if (keptShortPassword) {
  console.warn(
    "\n  WARNING: PORTAL_PASSWORD is shorter than " + MIN_PASSWORD_LENGTH + " characters. This portal ran with it\n" +
      "  before the minimum, so it keeps working, but a new or changed password\n" +
      "  has to be longer. Anybody who can reach the port can try to guess it,\n" +
      "  and the portal runs arbitrary commands on this machine.\n"
  );
}

// What this start ran with, so that a change to the password is known next time.
if (passwordLogin) {
  const stamp = getSetting(LOGIN_STAMP);
  if (!stamp || !isStamp(stamp, PASSWORD)) putSetting(LOGIN_STAMP, stampOf(PASSWORD));
}

/**
 * Without a password that is a way in, the login cookie rests on the secret alone: everything else in its
 * key (the issuer, the client ID, the allow-list) can be read or guessed from outside. A secret that is
 * the guide's old command, or too short to be one nobody can guess, would let anybody make a login.
 * Left out, the secret is a random one, which only costs the logins at a restart.
 */
const MIN_SECRET_LENGTH = 32;
const givenSecret = process.env.PORTAL_SECRET ?? "";
if (oidcConfig && !passwordLogin && givenSecret && (/^\$\(/.test(givenSecret) || givenSecret.length < MIN_SECRET_LENGTH)) {
  console.error(
    "\n  PORTAL_SECRET is a shell command or shorter than " + MIN_SECRET_LENGTH + " characters. With single sign-on and no\n" +
      "  password login, the secret is all the login cookie rests on, so the portal refuses to start\n" +
      "  with one that anybody could guess. Put the output of `openssl rand -hex 32` there.\n"
  );
  process.exit(1);
}

if (PASSWORD && oidcConfig?.only) {
  console.warn("\n  OIDC_ONLY is set: the password login is refused, and PORTAL_PASSWORD is not used to sign in.\n");
}

if (oidcConfig && !allowsAnyone(oidcConfig)) {
  console.warn(
    "\n  WARNING: single sign-on is set up, but OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_GROUPS and\n" +
      "  OIDC_ALLOWED_SUBJECTS are all empty, so the provider's sign-in lets nobody in.\n" +
      "  Name the people or groups who may use this portal.\n"
  );
}

if (!authEnabled) {
  console.warn(
    "\n  WARNING: PORTAL_ALLOW_NO_PASSWORD is set and PORTAL_PASSWORD is not — the\n" +
      "  portal is open to anyone who can reach it, and it can run arbitrary\n" +
      "  commands on this machine. Only the proxy in front of it stops them.\n" +
      "  It binds loopback unless ALLOW_OPEN=1 explicitly exposes it.\n"
  );
}

/**
 * What the cookies are signed with: the secret and the password, so a new password refuses every old cookie,
 * and the single sign-on provider and its allow-list, so that a change to who may sign in does the same.
 * The password only while it is a way in, so switching OIDC_ONLY on ends the logins it gave. The key is the
 * same for every login, so the provider's end with them, and switching it off again ends those made meanwhile.
 */
const KEY = crypto.createHash("sha256").update(`${SECRET}\0${passwordLogin ? PASSWORD : ""}${oidcConfig ? `\0${fingerprint(oidcConfig)}` : ""}`).digest();

/** A key of its own for another purpose, from the same secret: the sign-in's state cookie is sealed with one. */
export const keyFor = (purpose: string): Buffer => crypto.createHmac("sha256", KEY).update(`pithagoras:${purpose}`).digest();

/** The name of the short-lived cookie a sign-in through the provider keeps its state in, beside the login's. */
export const OIDC_STATE_COOKIE = `${COOKIE}_oidc`;

const macOf = (expiry: string) => crypto.createHmac("sha256", KEY).update(expiry).digest("hex");

function sign(expiry: number): string {
  return `${expiry}.${macOf(String(expiry))}`;
}

/** The token's expiry and signature, if it is one this portal signed and it has not run out. */
function genuine(token: string | undefined): { expiry: number; mac: string } | null {
  if (!token) return null;
  const [expiryStr, mac] = token.split(".");
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  const expected = macOf(expiryStr);
  const a = Buffer.from(mac ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { expiry, mac } : null;
}

function verify(token: string | undefined): boolean {
  const login = genuine(token);
  return login !== null && !isSignedOut(login.mac);
}

/**
 * Only over TLS: the browser sends a cookie to every port of the host name, and a
 * Secure one is kept from the plain-HTTP services beside the portal. Where the
 * portal itself is plain HTTP, a Secure cookie would never be stored at all.
 */
export const secure = (res: Response) => Boolean(tlsFiles()) || res.req.secure;

export function issueCookie(res: Response): void {
  res.cookie(COOKIE, sign(Date.now() + MAX_AGE_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: secure(res),
    maxAge: MAX_AGE_MS,
  });
}

/**
 * Ends this browser's login: the cookie is cleared, and the login it held is
 * refused from now on, so a copy of it taken elsewhere stops working too.
 */
export function signOut(req: Request, res: Response): void {
  const login = genuine(req.cookies?.[COOKIE]);
  if (login) recordSignOut(login.mac, login.expiry);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: secure(res) });
}

export function checkPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !passwordLogin) return false;
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

/**
 * The same question for a request cookie-parser never saw: an upgrade is
 * handed to the server before Express, so its cookies are still the raw header.
 */
export function isAuthedUpgrade(req: { headers: { cookie?: string } }): boolean {
  if (!authEnabled) return true;
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== COOKIE) continue;
    try {
      return verify(decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      return false;
    }
  }
  return false;
}
