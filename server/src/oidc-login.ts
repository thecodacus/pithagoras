import crypto from "node:crypto";
import express, { type RequestHandler, type Response } from "express";
import { errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { OIDC_STATE_COOKIE, authMode, derivedKey, issueCookie, secure } from "./auth.js";
import {
  CALLBACK_PATH, PROVIDER_TIMEOUT_MS, discover, safeReturnTo,
  type OidcConfig, type OidcProvider,
} from "./oidc.js";
import { ssoConfig } from "./sso-settings.js";

/**
 * Signing in through an OpenID Connect provider: the authorization code flow
 * with PKCE, `state` and `nonce`.
 *
 * The browser is sent to the provider with a short-lived cookie that holds what
 * the answer must match, sealed so that only this portal can read or make one.
 * The answer is taken once: its state is remembered as used until it would have
 * run out, and the cookie is cleared whatever the outcome. The ID token is
 * checked against the provider's keys, issuer, audience, expiry and nonce. Who
 * may sign in is the provider's to decide: an account it signs in, with an ID
 * token that checks out, gets the portal's own login cookie, the one the
 * password gives, so nothing behind the login changes. The provider's tokens
 * are not kept, nor written anywhere.
 *
 * The settings are read on every request (Settings → Authentication, sso-settings.ts), and single sign-on
 * applies only while the portal has a password: the login cookie is signed with its hash.
 */

/** Single sign-on as it applies now: set up, and on a portal with a password. */
export const activeSso = (): OidcConfig | null => (authMode() === "password" ? ssoConfig() : null);

/** How long a provider that could not be read is left alone before it is asked again. */
const RETRY_DISCOVERY_MS = 30_000;

/** The provider's discovery document and keys, read once for an issuer (and kind of client), and again after a failure. */
let discovered: { key: string; at: number; failed: boolean; result: Promise<OidcProvider> } | undefined;

const discoveryKey = (config: OidcConfig) => `${config.issuer}\0${config.clientSecret ? "confidential" : "public"}`;

/** The provider for these settings: what discovery found, with the settings as they are now. */
export async function providerFor(config: OidcConfig): Promise<OidcProvider> {
  const key = discoveryKey(config);
  if (!discovered || discovered.key !== key || (discovered.failed && Date.now() - discovered.at > RETRY_DISCOVERY_MS)) {
    const entry = { key, at: Date.now(), failed: false, result: discover(config) };
    entry.result.catch(() => { entry.failed = true; });
    discovered = entry;
  }
  return { ...(await discovered.result), config };
}

/** Keeps what was found when the settings were saved, so that the first sign-in does not read it again. */
export function rememberProvider(provider: OidcProvider): void {
  discovered = { key: discoveryKey(provider.config), at: Date.now(), failed: false, result: Promise.resolve(provider) };
}

/** How long a sign-in at the provider may take, from the button to the answer. */
const STATE_TTL_MS = 10 * 60_000;
/** The leeway on the clocks of the provider and the portal, for an ID token's times. */
const CLOCK_TOLERANCE_S = 60;
/** How old an ID token may be: it was made a moment ago, for this answer. */
const MAX_TOKEN_AGE_S = 10 * 60;
/** States taken, held until they would run out. A full list refuses rather than forgets. */
const MAX_USED_STATES = 50_000;

const random = () => crypto.randomBytes(32).toString("base64url");
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

interface Pending {
  /** The provider the sign-in was started with: settings changed in between do not finish it. */
  issuer: string;
  clientId: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expires: number;
}

/** AES-GCM: what the cookie holds is unreadable to anyone but the portal, and any change to it is found. */
const sealKey = () => derivedKey("oidc-state");

function seal(pending: Pending): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(pending), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(token: unknown): Pending | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const pending = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as Pending;
    if (typeof pending.state !== "string" || typeof pending.nonce !== "string" || typeof pending.verifier !== "string") return null;
    if (typeof pending.issuer !== "string" || typeof pending.clientId !== "string") return null;
    if (typeof pending.expires !== "number" || pending.expires < Date.now()) return null;
    return pending;
  } catch {
    return null;
  }
}

const used = new Map<string, number>();

/** Takes the state, once: false for one taken before, or when the list of taken ones is full. */
function take(state: string, expires: number): boolean {
  const now = Date.now();
  for (const [key, until] of used) if (until <= now) used.delete(key);
  if (used.has(state) || used.size >= MAX_USED_STATES) return false;
  used.set(state, expires);
  return true;
}

const cookieOptions = (res: Response) => ({ httpOnly: true, sameSite: "lax" as const, secure: secure(res), path: "/api/auth/oidc/" });

/** A refused sign-in, as a page: the browser came here from the provider, not from the portal's own code. */
class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly detail?: string) {
    super(message);
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function refusalPage(res: Response, refusal: Refusal) {
  res
    .status(refusal.status)
    .set("Cache-Control", "no-store")
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Sign-in failed</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
        `<h1 style="font-size:1.1rem">Sign-in failed</h1><p>${escapeHtml(refusal.message)}</p>` +
        `<p><a href="/">Back to the sign-in page</a></p></body></html>`,
    );
}

/** A short piece of what the provider said, for the page and the log: never more than it needs. */
const said = (value: unknown) => (typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, "").slice(0, 200) : "");

async function redeem(provider: OidcProvider, code: string, verifier: string): Promise<string> {
  const { config } = provider;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUrl.href, code_verifier: verifier });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (provider.tokenAuth === "client_secret_basic") {
    // RFC 6749 2.3.1: each half form-encoded before the two are joined.
    const pair = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret!)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    body.set("client_id", config.clientId);
    if (provider.tokenAuth === "client_secret_post") body.set("client_secret", config.clientSecret!);
  }
  let res: globalThis.Response;
  try {
    res = await fetch(provider.tokenEndpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (e) {
    throw new Refusal(502, "The sign-in provider could not be reached to finish the sign-in.", `token endpoint: ${(e as Error).message}`);
  }
  const answer = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || !answer || typeof answer !== "object") {
    const error = said(answer?.error);
    throw new Refusal(502, `The sign-in provider did not accept the sign-in${error ? ` (${error})` : ""}.`, `token endpoint: HTTP ${res.status} ${error} ${said(answer?.error_description)}`);
  }
  if (typeof answer.id_token !== "string") throw new Refusal(502, "The sign-in provider answered without an ID token.", "token endpoint: no id_token");
  // The access and refresh tokens, where there are any, go no further: the portal does not need them.
  return answer.id_token;
}

async function verifyIdToken(provider: OidcProvider, idToken: string, nonce: string): Promise<JWTPayload> {
  const { config } = provider;
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, provider.jwks, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: provider.algorithms,
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    }));
  } catch (e) {
    const code = e instanceof joseErrors.JOSEError ? e.code : "ERR_UNKNOWN";
    throw new Refusal(401, "The sign-in provider's answer could not be verified.", `ID token: ${code}: ${said((e as Error).message)}`);
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new Refusal(401, "The sign-in provider's answer could not be verified.", "ID token: no subject");
  if (typeof claims.nonce !== "string" || !same(claims.nonce, nonce)) throw new Refusal(401, "The sign-in provider's answer could not be verified.", "ID token: nonce does not match");
  // OpenID Connect Core 3.1.3.7: with more than one audience, the party it was given to must be this portal.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== config.clientId) {
    throw new Refusal(401, "The sign-in provider's answer could not be verified.", "ID token: azp is not this portal");
  }
  return claims;
}

export function oidcRouter(throttle: RequestHandler): express.Router {
  const router = express.Router();
  const notSetUp = new Refusal(404, "Single sign-on is not set up on this portal.", "not set up");

  router.get("/api/auth/oidc/start", async (req, res) => {
    const config = activeSso();
    if (!config) return refusalPage(res, notSetUp);
    // The state cookie is kept for the host it is set on, and the provider sends the browser back to the redirect
    // URL's: a portal opened by another name (an IP, a Tailscale name) starts again there first. The target is the
    // configured address, never the request's; `moved` stops a proxy that rewrites Host from sending it round again.
    // A request without a Host header (HTTP/1.0 allows it) has no name, which is another name too.
    if ((req.hostname ?? "").toLowerCase() !== config.redirectUrl.hostname.toLowerCase() && req.query.moved === undefined) {
      const there = new URL("/api/auth/oidc/start", config.redirectUrl.origin);
      there.searchParams.set("returnTo", safeReturnTo(req.query.returnTo));
      there.searchParams.set("moved", "1");
      return res.set("Cache-Control", "no-store").redirect(303, there.href);
    }
    let provider: OidcProvider;
    try {
      provider = await providerFor(config);
    } catch (e) {
      console.warn(`[auth] sign-in through ${config.name} cannot start: ${(e as Error).message}`);
      return refusalPage(res, new Refusal(502, `${config.name} cannot be reached at the moment. Try again later, or sign in with the password.`));
    }
    const pending: Pending = {
      issuer: config.issuer, clientId: config.clientId,
      state: random(), nonce: random(), verifier: random(), returnTo: safeReturnTo(req.query.returnTo), expires: Date.now() + STATE_TTL_MS,
    };
    res.cookie(OIDC_STATE_COOKIE, seal(pending), { ...cookieOptions(res), maxAge: STATE_TTL_MS });
    const to = new URL(provider.authorizationEndpoint);
    to.searchParams.set("response_type", "code");
    to.searchParams.set("client_id", config.clientId);
    to.searchParams.set("redirect_uri", config.redirectUrl.href);
    to.searchParams.set("scope", config.scopes);
    to.searchParams.set("state", pending.state);
    to.searchParams.set("nonce", pending.nonce);
    to.searchParams.set("code_challenge", sha256(pending.verifier));
    to.searchParams.set("code_challenge_method", "S256");
    res.set("Cache-Control", "no-store").redirect(303, to.href);
  });

  router.get(CALLBACK_PATH, throttle, async (req, res) => {
    const config = activeSso();
    if (!config) return refusalPage(res, notSetUp);
    const pending = unseal(req.cookies?.[OIDC_STATE_COOKIE]);
    // Single use whatever happens next: the browser does not keep it.
    res.clearCookie(OIDC_STATE_COOKIE, cookieOptions(res));
    try {
      if (!pending) {
        throw new Refusal(400, `This sign-in was not started in this browser, or took too long. Open the portal at ${config.redirectUrl.origin} and start it again.`, "no state cookie");
      }
      const { state, code, error, iss } = req.query;
      if (typeof state !== "string" || !same(state, pending.state)) throw new Refusal(400, "This sign-in does not belong to this browser. Start it again.", "state does not match");
      if (!take(pending.state, pending.expires)) throw new Refusal(400, "This sign-in was used already. Start it again.", "state used before");
      if (pending.issuer !== config.issuer || pending.clientId !== config.clientId) {
        throw new Refusal(400, "Single sign-on was set up differently while this sign-in was under way. Start it again.", "settings changed");
      }
      let provider: OidcProvider;
      try {
        provider = await providerFor(config);
      } catch (e) {
        throw new Refusal(502, `${config.name} cannot be reached at the moment. Try again later.`, `discovery: ${(e as Error).message}`);
      }
      // RFC 9207: an answer that names its issuer must name this one, and one that always does must not leave it out.
      if (iss !== undefined || provider.issParameter) {
        if (typeof iss !== "string" || iss !== config.issuer) throw new Refusal(400, "The answer did not come from this portal's sign-in provider.", "iss does not match");
      }
      if (error !== undefined) {
        throw new Refusal(401, `The sign-in provider refused the sign-in${said(error) ? ` (${said(error)})` : ""}.`, `provider: ${said(error)} ${said(req.query.error_description)}`);
      }
      if (typeof code !== "string" || !code) throw new Refusal(400, "The sign-in provider's answer has no code.", "no code");

      const claims = await verifyIdToken(provider, await redeem(provider, code, pending.verifier), pending.nonce);
      console.log(`[auth] signed in through ${config.name} as ${said(claims.sub)}${typeof claims.email === "string" ? ` (${said(claims.email)})` : ""}`);
      issueCookie(res);
      res.set("Cache-Control", "no-store").redirect(303, safeReturnTo(pending.returnTo));
    } catch (e) {
      const refusal = e instanceof Refusal ? e : new Refusal(500, "The sign-in could not be finished.", (e as Error).message);
      console.warn(`[auth] sign-in through ${config.name} refused: ${refusal.detail ?? refusal.message}`);
      refusalPage(res, refusal);
    }
  });

  return router;
}

/** Where signing out sends the browser after the portal's own logout, where the settings ask for the provider's too. */
export async function endSessionUrl(): Promise<string | undefined> {
  const config = activeSso();
  if (!config?.endSession) return undefined;
  const provider = await providerFor(config).catch(() => undefined);
  if (!provider?.endSessionEndpoint) return undefined;
  const to = new URL(provider.endSessionEndpoint);
  to.searchParams.set("client_id", config.clientId);
  to.searchParams.set("post_logout_redirect_uri", `${config.redirectUrl.origin}/`);
  return to.href;
}
