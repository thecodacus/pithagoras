/**
 * Unit tests for src/jwt.ts and src/tickets.ts: sign/verify happy paths, tampered payload/signature/header-alg
 * (RS256, "none", truncated) all -> null, expired tokens -> null, ttlMs undefined -> no exp claim; ticket
 * mint/verify round-trip, expiry, docId flip, wrong secret. Pure crypto only -- no fs, no portal, secrets are
 * test literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signJwt, verifyJwt } from "../src/jwt";
import { mintTicket, verifyTicket } from "../src/tickets";

const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01234567";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/* ---------------- jwt ---------------- */

test("jwt: sign/verify round-trip keeps the payload and adds iat/exp", () => {
  const token = signJwt({ sub: "doc-123", role: "editor" }, 60_000, SECRET);
  const payload = verifyJwt(token, SECRET);
  assert.ok(payload);
  assert.equal(payload.sub, "doc-123");
  assert.equal(payload.role, "editor");
  assert.equal(typeof payload.iat, "number");
  assert.equal(typeof payload.exp, "number");
  // seconds precision: exp is within [now+60, now+61]
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(payload.exp! >= nowSec + 60 && payload.exp! <= nowSec + 62, `exp ${payload.exp} not ~now+60`);
});

test("jwt: ttlMs undefined -> no iat/exp claims, still verifies", () => {
  const token = signJwt({ sub: "x" }, undefined, SECRET);
  const payload = verifyJwt(token, SECRET);
  assert.deepEqual(payload, { sub: "x" }); // exactly the original claims -- no iat, no exp
});

test("jwt: expired token -> null", () => {
  const token = signJwt({ sub: "x" }, -5000, SECRET); // signed 5s in the past
  assert.equal(verifyJwt(token, SECRET), null);
});

test("jwt: tampered payload -> null", () => {
  const token = signJwt({ sub: "x" }, 60_000, SECRET);
  const [head, body, sig] = token.split(".");
  // bump one claim and keep the original signature
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  claims.sub = "evil";
  assert.equal(verifyJwt(`${head}.${b64url(JSON.stringify(claims))}.${sig}`, SECRET), null);
});

test("jwt: tampered signature -> null (incl. truncated/garbage)", () => {
  const token = signJwt({ sub: "x" }, 60_000, SECRET);
  const [head, body, sig] = token.split(".");
  assert.equal(verifyJwt(`${head}.${body}.${sig.slice(0, -3)}AAAAAA`, SECRET), null);
  assert.equal(verifyJwt(`${head}.${body}.not-base64-!!!`, SECRET), null);
  assert.equal(verifyJwt(`${head}.${body}`, SECRET), null); // missing segment
});

test("jwt: header alg RS256 -> null even with a valid HMAC for the fake header", () => {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub: "x", exp: Math.floor(Date.now() / 1000) + 60 }));
  // a perfectly valid HMAC over the RS256 header -- must still be rejected (alg is pinned, not just trusted)
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  assert.equal(verifyJwt(`${head}.${body}.${sig}`, SECRET), null);
});

test("jwt: alg 'none' -> null; wrong secret -> null; garbage token -> null", () => {
  const body = b64url(JSON.stringify({ sub: "x" }));
  const noneHead = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  assert.equal(verifyJwt(`${noneHead}.${body}.`, SECRET), null);
  const good = signJwt({ sub: "x" }, 60_000, SECRET);
  assert.equal(verifyJwt(good, "a different secret entirely"), null);
  assert.equal(verifyJwt("not-a-token", SECRET), null);
});

/* ---------------- tickets ---------------- */

test("tickets: mint/verify round-trip returns the docId", () => {
  const { token, expiresMs } = mintTicket("my-doc-abc123", undefined, SECRET);
  assert.ok(token && typeof token === "string");
  assert.ok(expiresMs > Date.now() + 590_000 && expiresMs <= Date.now() + 600_000); // ~10 minute default
  assert.deepEqual(verifyTicket(token, SECRET), { docId: "my-doc-abc123" });
});

test("tickets: expired ticket -> null", () => {
  const { token } = mintTicket("my-doc", -5000, SECRET); // already in the past
  assert.equal(verifyTicket(token, SECRET), null);
});

test("tickets: flipped character in the docId section -> null", () => {
  const { token } = mintTicket("doc-a-1", 60_000, SECRET);
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const [docId, expMs, mac] = decoded.split("|");
  // a different docId with the SAME expiry and signature must not verify (HMAC covers both sections)
  const forged = Buffer.from(`doc-b-2|${expMs}|${mac}`).toString("base64url");
  assert.notEqual(forged, token);
  assert.equal(verifyTicket(forged, SECRET), null);
});

test("tickets: wrong secret -> null", () => {
  const { token } = mintTicket("doc-a-1", 60_000, SECRET);
  assert.equal(verifyTicket(token, "wrong-secret"), null);
});

test("tickets: malformed tokens -> null (never throws)", () => {
  assert.equal(verifyTicket("", SECRET), null);
  assert.equal(verifyTicket("!!!not-base64!!!", SECRET), null); // outside the base64url alphabet
  assert.equal(verifyTicket(Buffer.from("onlytwo|3").toString("base64url"), SECRET), null); // two sections
  assert.equal(verifyTicket(Buffer.from("|1700000000000|abcdef").toString("base64url"), SECRET), null); // empty docId section
});
