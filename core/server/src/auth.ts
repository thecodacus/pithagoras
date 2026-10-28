import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getDb, getSetting, isSignedOut, putSetting, recordSignOut } from "./db.js";
import { allowNoPassword, tlsFiles } from "./http-security.js";
import { bindLogin, sweep } from "./login-streams.js";
import { fingerprint } from "./oidc.js";
import { ownerPerson, type RequestPerson } from "./people.js";
import { ssoConfig } from "./sso-settings.js";
import {
  EXAMPLE_PASSWORD,
  MIN_PASSWORD_LENGTH,
  PASSWORD_HELD_KEY,
  PASSWORD_KEY,
  PASSWORD_SHORT_KEY,
  hashPassword,
  passwordMatches,
  passwordProblem,
} from "./password.js";

/**
 * Shared-password gate.
 *
 * This portal can run arbitrary code on the host, so even on a Tailscale-only
 * network it should not be drivable by anything that happens to reach the port.
 * The cookie is an HMAC of an expiry stamp — no session store needed, except
 * for the ones signed out early, which are remembered until they would expire.
 * The key holds the password's hash as well as the secret, so changing the
 * password ends every login that was made under the old one.
 *
 * The password is kept hashed in the portal's settings and read from there on
 * every request, so that the command which removes a lost one (reset-password)
 * takes effect in a running portal. Until one is chosen, the portal is in
 * setup: it answers nothing but the page that asks for one.
 *
 * A sign-in through an OpenID Connect provider (Settings → Authentication,
 * oidc-login.ts) ends in the same cookie, and needs the password to be set: the
 * cookie is signed with its hash, and the provider's settings are added to the key.
 */
const SECRET = process.env.PORTAL_SECRET || crypto.randomBytes(32).toString("hex");
/**
 * Without a secret of its own every start makes a new one, and the logins that were open end with the restart. A portal
 * with no password has no logins to end.
 */
export const loginsSurviveRestart = (): boolean => authMode() === "open" || Boolean(process.env.PORTAL_SECRET);
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

/** What an earlier portal remembered of the password it ran with: the hash of the PORTAL_PASSWORD of its last start. */
const LEGACY_STAMP = "login_password";

const storedHash = (): string | undefined => getSetting(PASSWORD_KEY);

/**
 * `password`: a password is set and the login applies. `setup`: none is set yet, so the portal waits for the
 * person who opens it to choose one. `open`: none, by PORTAL_ALLOW_NO_PASSWORD's choice, and no login at all.
 */
export type AuthMode = "password" | "setup" | "open";
export const authMode = (): AuthMode => (storedHash() ? "password" : openByChoice ? "open" : "setup");

/**
 * Open is a state the portal starts in and stays in, never one it falls into: it was bound to an address for
 * its login (all of them), and a password that goes while it runs (reset-password) must find it waiting on the
 * setup screen, not with no login on that address. Decided once, after a PORTAL_PASSWORD has been moved in.
 */
let openByChoice = false;

/** Whether this portal has been used before: it holds a chat. A new one holds settings of its own already. */
const hasBeenUsed = (): boolean => getDb().prepare("SELECT 1 FROM sessions LIMIT 1").get() !== undefined;

/**
 * A short password only stops a portal it is new to. The minimum came after
 * installs that already had a shorter one, which must still sign in: the one
 * they ran with is the one the portal remembered (salted and hashed, in its own
 * settings), and an install from before it remembered anything is told by having been used.
 */
async function wasInUse(password: string): Promise<boolean> {
  const stamp = getSetting(LEGACY_STAMP);
  return stamp ? passwordMatches(password, stamp) : hasBeenUsed();
}

/** Stores a password the person chose, or moved in. Held first: if the rest is cut short, `PORTAL_PASSWORD` is still not read again. */
function keepPassword(hash: string, short = false): void {
  putSetting(PASSWORD_HELD_KEY, "1");
  putSetting(PASSWORD_SHORT_KEY, short ? "1" : "");
  putSetting(PASSWORD_KEY, hash);
}

/**
 * The password of an install from before it was kept here: PORTAL_PASSWORD, moved into the database on the
 * first start. After that the variable is not read as a password, and the log says so; a start where it
 * differs from the password in the database is said again, so that nobody edits .env and wonders why the
 * old one still signs in. One that the portal has held a password of its own since — even if it has been
 * removed with reset-password — is not moved either, or the reset would be undone by the next restart.
 */
async function moveEnvPassword(): Promise<void> {
  const env = process.env.PORTAL_PASSWORD || "";
  if (!env) return;
  const held = storedHash();
  if (held || getSetting(PASSWORD_HELD_KEY)) {
    if (held && (await passwordMatches(env, held))) return;
    console.warn(
      "\n  PORTAL_PASSWORD is ignored: the portal keeps its password in its database now (Settings → Authentication).\n" +
        "  Remove the variable from your environment.\n"
    );
    return;
  }
  const short = env.length < MIN_PASSWORD_LENGTH;
  if (env === EXAMPLE_PASSWORD || (short && !(await wasInUse(env)))) {
    console.warn(
      "\n  PORTAL_PASSWORD is the example from the old .env.example or shorter than " + MIN_PASSWORD_LENGTH + " characters, so it is\n" +
        "  not taken as the password. Choose one on the setup screen, and remove the variable.\n"
    );
    return;
  }
  keepPassword(await hashPassword(env), short);
  putSetting(LEGACY_STAMP, "");
  console.log(
    "\n  PORTAL_PASSWORD was moved into the portal's database. The password is kept there from now on, and the\n" +
      "  variable is ignored: change the password under Settings → Authentication, and remove the variable.\n"
  );
}
await moveEnvPassword();
openByChoice = allowNoPassword() && !storedHash();

if (authMode() === "setup") {
  console.warn(
    "\n  No password is set yet. Open the portal in a browser to choose one: until then it answers nothing\n" +
      "  else, and whoever opens it first chooses the password. This portal runs arbitrary commands on the\n" +
      "  host, so keep the port to yourself until you have.\n"
  );
}

if (authMode() === "password" && getSetting(PASSWORD_SHORT_KEY)) {
  console.warn(
    "\n  WARNING: the password is shorter than " + MIN_PASSWORD_LENGTH + " characters. This portal ran with it\n" +
      "  before the minimum, so it keeps working, but a new or changed password\n" +
      "  has to be longer. Anybody who can reach the port can try to guess it,\n" +
      "  and the portal runs arbitrary commands on this machine.\n"
  );
}

if (authMode() === "open") {
  console.warn(
    "\n  WARNING: PORTAL_ALLOW_NO_PASSWORD is set and no password is — the\n" +
      "  portal is open to anyone who can reach it, and it can run arbitrary\n" +
      "  commands on this machine. Only the proxy in front of it stops them.\n" +
      "  It binds loopback unless ALLOW_OPEN=1 explicitly exposes it.\n"
  );
}

/** Whether the password that signs in is shorter than the minimum, because the portal ran with it before there was one. */
export const shortPassword = (): boolean => authMode() === "password" && Boolean(getSetting(PASSWORD_SHORT_KEY));

/**
 * What a login is signed under: the password's hash, so a new password refuses every old cookie, and with single
 * sign-on its provider, so that a change to it does the same. Undefined while no password is set. Without single
 * sign-on it is the hash alone, as it was before there was any.
 */
const loginIdentity = (): string | undefined => {
  const hash = storedHash();
  if (!hash) return undefined;
  const sso = ssoConfig();
  return sso ? `${hash}\0${fingerprint(sso)}` : hash;
};

/** What the cookies are signed with: the secret and the login's identity. */
let keyed: { identity: string; key: Buffer } | undefined;
const keyFor = (identity: string): Buffer => {
  if (keyed?.identity !== identity) keyed = { identity, key: crypto.createHash("sha256").update(`${SECRET}\0${identity}`).digest() };
  return keyed.key;
};

/** A key of its own for another purpose, from the same secret and login: the sign-in's state cookie is sealed with one. */
export function derivedKey(purpose: string): Buffer {
  const identity = loginIdentity();
  if (!identity) throw new Error("There is no password to sign in under.");
  return crypto.createHmac("sha256", keyFor(identity)).update(`pithagoras:${purpose}`).digest();
}

/** The name of the short-lived cookie a sign-in through the provider keeps its state in, beside the login's. */
export const OIDC_STATE_COOKIE = `${COOKIE}_oidc`;

/** Whether the password login is switched off: single sign-on is set up as the only way in. */
export const passwordRefused = (): boolean => authMode() === "password" && ssoConfig()?.only === true;

const macOf = (expiry: string, key: Buffer) => crypto.createHmac("sha256", key).update(expiry).digest("hex");

function sign(expiry: number, key: Buffer): string {
  return `${expiry}.${macOf(String(expiry), key)}`;
}

/** The token's expiry and signature, if it is one this portal signed under this password and it has not run out. */
function genuine(token: string | undefined): { expiry: number; mac: string } | null {
  const identity = loginIdentity();
  if (!token || !identity) return null;
  const [expiryStr, mac] = token.split(".");
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  const expected = macOf(expiryStr, keyFor(identity));
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

/** Signs this browser in, under the password as it is now: after setting or changing it, so that the new hash is the one signed with. */
export function issueCookie(res: Response): void {
  const identity = loginIdentity();
  if (!identity) throw new Error("There is no password to sign in with.");
  res.cookie(COOKIE, sign(Date.now() + MAX_AGE_MS, keyFor(identity)), {
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

export async function checkPassword(candidate: unknown): Promise<boolean> {
  const hash = storedHash();
  return typeof candidate === "string" && hash !== undefined && (await passwordMatches(candidate, hash));
}

/** Why a request to set or change the password was refused: the status to answer with, and the words. */
export interface Refusal {
  status: number;
  error: string;
}

/** Chooses the first password, on the setup screen. Whoever signs in with it is the caller's to do (issueCookie). */
export async function setUpPassword(password: unknown): Promise<Refusal | null> {
  const taken = (): Refusal | null =>
    storedHash() ? { status: 409, error: "A password is set already." }
      : authMode() === "open" ? { status: 409, error: "This portal runs without a login: PORTAL_ALLOW_NO_PASSWORD is set." }
      : null;
  const refused = taken();
  if (refused) return refused;
  const problem = passwordProblem(password);
  if (problem) return { status: 400, error: problem };
  const hash = await hashPassword(password as string);
  // Hashing takes a moment, and another request may have chosen a password in it: the first one stands.
  const late = taken();
  if (late) return late;
  keepPassword(hash);
  return null;
}

/**
 * Changes the password to `next`, given the one it is now. The caller signs this browser in again (issueCookie):
 * every other login is ended by the change, because the cookies are signed with the password's hash, and so is
 * every stream that was open under the old one, the changer's too: a cookie can be copied, and so can what is open with it.
 */
export async function changePassword(current: unknown, next: unknown): Promise<Refusal | null> {
  if (authMode() !== "password") return { status: 409, error: "No password is set." };
  const problem = passwordProblem(next);
  if (problem) return { status: 400, error: problem };
  if (!(await checkPassword(current))) return { status: 403, error: "The current password is wrong." };
  keepPassword(await hashPassword(next as string));
  // Every stream ends, the changer's too: the page opens them again with the cookie it is signed in with by the caller.
  sweep();
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (authMode() === "open") return next();
  if (verify(req.cookies?.[COOKIE])) return next();
  res.status(401).json({ error: "Unauthorized" });
}

export function isAuthed(req: Request): boolean {
  return authMode() === "open" || verify(req.cookies?.[COOKIE]);
}

/** The login's cookie of a request cookie-parser never saw: an upgrade is handed to the server before Express, so its cookies are still the raw header. */
function upgradeCookie(req: { headers: { cookie?: string } }): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// A stream ends when what its login was signed under changes: the password, or the provider's settings.
bindLogin({ hash: loginIdentity });

export function isAuthedUpgrade(req: { headers: { cookie?: string } }): boolean {
  return authMode() === "open" || verify(upgradeCookie(req));
}

/**
 * The person behind a request's login, from its cookie as it came (a request to an extension's routes, or an upgrade):
 * nobody for one that is not signed in. Every login is the owner's for now (ownerPerson); once there are logins with
 * fewer rights, this is where each says who it is.
 */
export function requestPerson(req: { headers: { cookie?: string } }): RequestPerson | undefined {
  return isAuthedUpgrade(req) ? ownerPerson() : undefined;
}

