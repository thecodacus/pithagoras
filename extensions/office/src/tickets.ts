/**
 * Document-fetch tickets for the DS container: document.url in a minted editor config points at the
 * loopback listener's GET /doc/<ticket>, which carries no session cookie (the portal gates every /api
 * route, and the DS holds none). The token is self-authenticating -- base64url("docId|expMs|hmac") with
 * a 10-minute default expiry -- verified here in constant time. Pure: no fs, no portal; the caller owns
 * the secret string (the same jwt-secret value as jwt.ts, per plan 5.6). Purpose separation (S3): the ticket
 * has no JWT claims to carry a family marker in, so the marker lives INSIDE the MAC'd message -- the HMAC
 * is computed over "document-ticket|docId|expMs" and only a verifier of this same family knows to prefix it.
 */

/** The purpose domain separator inside every ticket MAC. Mint and verify both prepend it; changing it here
 * invalidates outstanding tickets (10-minute lifetime at most) -- deliberately, like rotating the secret. */
const TICKET_PURPOSE = "document-ticket";
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(bytes: Buffer | string): string {
  return Buffer.from(typeof bytes === "string" ? bytes : bytes).toString("base64url");
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** Mint a fetch ticket for one document. token = base64urlNoPad(`docId|<expiresMs>|<hmacSha256Hex(secret, TICKET_PURPOSE + "|" + docId + "|" + expiresMs)>)`;
 * expiresMs is Date.now() + ttlMs (default 10 minutes). */
export function mintTicket(docId: string, ttlMs = 600_000, secret: string): { token: string; expiresMs: number } {
  if (secret === "") throw new Error("mintTicket: the shared secret is required"); // an empty secret would let anyone forge a ticket
  const expiresMs = Date.now() + ttlMs;
  return { token: b64url(`${docId}|${expiresMs}|${hmacHex(secret, `${TICKET_PURPOSE}|${docId}|${expiresMs}`)}`), expiresMs };
}

/** Verify a ticket: split on "|", recompute the HMAC over TICKET_PURPOSE|docId|exp and compare the hex digests in
 * constant time (timingSafeEqual over Buffer.from(hex, "hex")), then require the expiry to be in the future.
 * Returns { docId } or null -- never throws. A token whose payload splits into anything other than three
 * non-empty sections is rejected outright (so a docId containing "|" can never verify either). A MAC computed
 * WITHOUT the purpose prefix (or for another family) fails the digest comparison. */
export function verifyTicket(token: string, secret: string): { docId: string } | null {
  if (secret === "") return null; // an empty secret would make every well-formed token verify -- refuse instead of forging
  if (!/^[A-Za-z0-9_-]*$/.test(token)) return null; // base64url alphabet only
  let decoded: Buffer;
  try {
    decoded = Buffer.from(token, "base64url");
  } catch {
    return null;
  }
  const parts = decoded.toString("utf8").split("|");
  if (parts.length !== 3 || parts.some((section) => section === "")) return null; // exactly three non-empty sections
  const [docId, expStr, mac] = parts;
  const expiresMs = Number(expStr);
  if (!Number.isFinite(expiresMs) || !/^[0-9a-f]+$/i.test(mac)) return null;
  const expected = Buffer.from(hmacHex(secret, `${TICKET_PURPOSE}|${docId}|${expStr}`), "hex");
  const given = Buffer.from(mac.toLowerCase(), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (expiresMs <= Date.now()) return null; // expiry is not in the future
  return { docId };
}
