/**
 * Minimal HS256 JWT for pithagoras-office -- config signing (minted in /editor-config) and callback
 * verification share ONE secret: a random hex value the server keeps 0600 at dataDir()/jwt-secret and
 * passes to the DS container as JWT_SECRET. This module is pure: no file access, no fs, no portal;
 * the caller owns the secret string (per the wave-2 amendments). node:crypto only -- there is no jwt
 * dependency in the monorepo lockfile.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(bytes: Buffer | string): string {
  return Buffer.from(typeof bytes === "string" ? bytes : bytes).toString("base64url");
}

function b64urlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null; // base64url alphabet only (no padding in jwt)
  try {
    return Buffer.from(text, "base64url");
  } catch {
    return null;
  }
}

function sign(signingInput: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(signingInput).digest());
}

/** HS256-sign a payload. When `ttlMs` is given, iat (now, seconds precision) and exp (now + ttl, rounded up to the
 * second so the token outlives its ttl) are added automatically; when `ttlMs` is undefined NO exp claim is written
 * (the token then never expires on its own). A caller-supplied iat is kept. When `purpose` is given it is embedded
 * as a signed "typ" CLAIM (purpose separation, S3): every verifier of that family passes the same purpose to
 * verifyJwt and refuses tokens minted for another one -- without changing the key or breaking DS-side verification,
 * which ignores unknown claims. The contract shape is signJwt(payload, ttlMs?, secret?); TS forbids a required
 * parameter after an optional one, so the call forms are exposed as overloads and resolved in the implementation.
 * Callers type-check exactly against the contract. */
export function signJwt(payload: Record<string, unknown>, secret: string): string;
export function signJwt(payload: Record<string, unknown>, ttlMs?: number, secret?: string, purpose?: string): string;
export function signJwt(payload: Record<string, unknown>, maybeTtlOrSecret: number | string | undefined = undefined, secret: string | undefined = undefined, purpose: string | undefined = undefined): string {
  const ttlMs = typeof maybeTtlOrSecret === "number" ? maybeTtlOrSecret : undefined;
  const signingSecret = typeof maybeTtlOrSecret === "string" ? maybeTtlOrSecret : (secret ?? "");
  if (signingSecret === "") throw new Error("signJwt: the HS256 secret is required");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims: Record<string, unknown> = { ...payload };
  if (ttlMs !== undefined) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.iat === undefined) claims.iat = nowSec;
    claims.exp = nowSec + Math.ceil(ttlMs / 1000); // a negative ttl yields an already-expired token (used by tests)
  }
  if (purpose !== undefined && purpose !== "") claims.typ = purpose; // signed into the payload: part of the HMAC input
  const body = b64url(JSON.stringify(claims));
  return `${header}.${body}.${sign(`${header}.${body}`, signingSecret)}`;
}

/** Verify structure, pin header.alg to exactly "HS256" (anything else -- RS256, none, ... -- is null), recompute the
 * HMAC and compare in constant time, then reject an expired token (exp < now, seconds). When `purpose` is given,
 * the token's signed "typ" claim must equal it exactly (purpose separation) -- a validly-signed editor-config or
 * fetch token can never pass as a callback of another family. Tokens without a typ claim (minted before purpose
 * was introduced, or by DS itself) are accepted when NO purpose is requested, so the existing 15-minute
 * verification flow and already-running containers keep working unchanged. Returns the payload object or null for
 * any malformation; never throws. */
export function verifyJwt(token: string, secret: string, purpose?: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headB64, bodyB64, sigB64] = parts;
  const headerBuf = b64urlDecode(headB64);
  const bodyBuf = b64urlDecode(bodyB64);
  const sigBuf = b64urlDecode(sigB64);
  if (!headerBuf || !bodyBuf || !sigBuf) return null;
  let header: unknown;
  try {
    header = JSON.parse(headerBuf.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null || (header as Record<string, unknown>).alg !== "HS256") return null;
  const expected = sign(`${headB64}.${bodyB64}`, secret); // recompute over the EXACT transmitted segments
  const expectedBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const obj = claims as Record<string, unknown>;
  if (obj.exp !== undefined) {
    const exp = typeof obj.exp === "number" ? obj.exp : Number(obj.exp);
    if (!Number.isFinite(exp)) return null;
    if (exp < Math.floor(Date.now() / 1000)) return null; // expired
  }
  if (purpose !== undefined) {
    const typ = obj.typ; // the SIGNATURE already covers this claim: a forger cannot strip or rewrite it
    if (typeof typ !== "string" || typ !== purpose) return null; // wrong family or no claim at all
  }
  return obj;
}
