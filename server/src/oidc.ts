import { createRemoteJWKSet, type RemoteJWKSet } from "jose";

/**
 * Signing in through an OpenID Connect provider: what single sign-on under Settings → Authentication
 * keeps, and what the provider says about itself.
 *
 * Everything here fails closed. Settings that are not quite right, or a provider
 * that does not answer or calls itself by another name, are refused when they are
 * saved, with a message, rather than leaving a login that lets the wrong people in
 * or nobody. Nothing here reads the database or the environment: the settings are
 * kept by sso-settings.ts, and the flow itself is in oidc-login.ts.
 */

/** The path the provider sends the browser back to. Fixed: the configured redirect URL must name it. */
export const CALLBACK_PATH = "/api/auth/oidc/callback";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Absent for a public client, which proves itself with PKCE alone. */
  clientSecret?: string;
  redirectUrl: URL;
  scopes: string;
  /** What the button on the login page says after "Sign in with". */
  name: string;
  /** The password form is hidden and the password login refused. */
  only: boolean;
  /** Signing out also sends the browser to the provider's end_session_endpoint. */
  endSession: boolean;
}

/** The settings as they are kept, and as the Settings page sends them: plain values. */
export interface SsoSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUrl: string;
  scopes: string;
  name: string;
  endSession: boolean;
}

export class OidcConfigError extends Error {}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Plain HTTP only for a provider on this machine, the case of trying it out; anything else is https. */
function providerUrl(value: unknown, what: string, loopbackHttp: boolean): URL {
  let url: URL;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
  } catch {
    throw new OidcConfigError(`${what} is not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopbackHttp && LOOPBACK.test(url.hostname)) return url;
  throw new OidcConfigError(`${what} must be an https URL (plain http only for a provider on this machine): ${url.href}`);
}

const MAX_TEXT = 2048;

/** A text setting: trimmed, and an empty one is `fallback`. */
function text(value: unknown, what: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > MAX_TEXT) throw new OidcConfigError(`${what} must be a text of at most ${MAX_TEXT} characters`);
  return value.trim() || fallback;
}

/** Reads settings as sent or as kept, into what the sign-in works with. Throws on a setting that cannot be right. */
export function parseOidcConfig(input: unknown, only: boolean): OidcConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OidcConfigError("The settings are not an object");
  const raw = input as Record<string, unknown>;
  const issuer = text(raw.issuer, "The issuer");
  if (!issuer) throw new OidcConfigError("The issuer is required");
  const issuerUrl = providerUrl(issuer, "The issuer", true);
  if (issuerUrl.search || issuerUrl.hash) throw new OidcConfigError("The issuer must not have a query or a fragment");
  const clientId = text(raw.clientId, "The client ID");
  if (!clientId) throw new OidcConfigError("The client ID is required");
  const clientSecret = raw.clientSecret === undefined || raw.clientSecret === null ? "" : text(raw.clientSecret, "The client secret");

  // Configured, never taken from a request's Host header: that is the sender's to choose.
  const redirect = text(raw.redirectUrl, "The redirect URL");
  if (!redirect) throw new OidcConfigError(`The redirect URL is required: the portal's address followed by ${CALLBACK_PATH}`);
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    throw new OidcConfigError(`The redirect URL is not a URL: ${JSON.stringify(redirect)}`);
  }
  if (redirectUrl.protocol !== "https:" && redirectUrl.protocol !== "http:") throw new OidcConfigError("The redirect URL must be an http or https URL");
  if (redirectUrl.pathname !== CALLBACK_PATH || redirectUrl.search || redirectUrl.hash || redirectUrl.username || redirectUrl.password) {
    throw new OidcConfigError(`The redirect URL must be the portal's address followed by ${CALLBACK_PATH}, and nothing else: ${redirectUrl.href}`);
  }

  const scopes = text(raw.scopes, "The scopes").split(/\s+/).filter(Boolean);
  if (scopes.length && !scopes.includes("openid")) throw new OidcConfigError("The scopes must include openid");
  const name = text(raw.name, "The button's name", "SSO");
  if (name.length > 60) throw new OidcConfigError("The button's name must be at most 60 characters");
  if (raw.endSession !== undefined && typeof raw.endSession !== "boolean") throw new OidcConfigError("End the session at the provider must be on or off");

  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUrl,
    scopes: scopes.length ? scopes.join(" ") : "openid email profile",
    name,
    only,
    endSession: raw.endSession === true,
  };
}

/** What is kept of the settings: the secret too. */
export const keptForm = (config: OidcConfig): SsoSettings => ({
  issuer: config.issuer,
  clientId: config.clientId,
  ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
  redirectUrl: config.redirectUrl.href,
  scopes: config.scopes,
  name: config.name,
  endSession: config.endSession,
});

/** What the Settings page is shown: everything but the secret, of which it learns only that there is one. */
export function shownForm(config: OidcConfig): Omit<SsoSettings, "clientSecret"> & { hasSecret: boolean } {
  const { clientSecret, ...rest } = keptForm(config);
  return { ...rest, hasSecret: Boolean(clientSecret) };
}

/**
 * What the cookies are signed with depends on this too, so that changing the
 * provider ends every login made before. So does switching the password login
 * off or on.
 */
export const fingerprint = (config: OidcConfig) => JSON.stringify([config.issuer, config.clientId, config.only]);

/** Signature algorithms an ID token may be signed with: the provider's keys only, never a shared secret or none. */
const ASYMMETRIC = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];

export interface OidcProvider {
  config: OidcConfig;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  endSessionEndpoint?: URL;
  jwks: RemoteJWKSet;
  algorithms: string[];
  /** How the client authenticates at the token endpoint. */
  tokenAuth: "client_secret_basic" | "client_secret_post" | "none";
  /** The provider adds `iss` to its answer (RFC 9207), so an answer without it is refused. */
  issParameter: boolean;
}

/** How long a request to the provider may take. */
export const PROVIDER_TIMEOUT_MS = 10_000;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

/**
 * Reads the provider's discovery document and checks its keys can be fetched.
 * Throws with a message for the log if anything is not as it must be.
 */
export async function discover(config: OidcConfig, fetchImpl: typeof fetch = fetch): Promise<OidcProvider> {
  const loopbackHttp = new URL(config.issuer).protocol === "http:";
  const where = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let meta: Record<string, unknown>;
  try {
    const res = await fetchImpl(where, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not a JSON object");
    meta = body as Record<string, unknown>;
  } catch (e) {
    throw new OidcConfigError(`The provider's discovery document ${where} could not be read: ${(e as Error).message}`);
  }
  // The exact string: it is what every ID token's `iss` is compared with.
  if (meta.issuer !== config.issuer) {
    throw new OidcConfigError(`The provider calls itself ${JSON.stringify(meta.issuer)}, not ${JSON.stringify(config.issuer)}: the issuer must be exactly what it says`);
  }
  const endpoint = (name: string, required: boolean) => {
    if (meta[name] === undefined && !required) return undefined;
    return providerUrl(meta[name], `The provider's ${name}`, loopbackHttp);
  };
  const authorizationEndpoint = endpoint("authorization_endpoint", true)!;
  const tokenEndpoint = endpoint("token_endpoint", true)!;
  const jwksUri = endpoint("jwks_uri", true)!;
  const endSessionEndpoint = endpoint("end_session_endpoint", false);

  const responseTypes = strings(meta.response_types_supported);
  if (responseTypes && !responseTypes.includes("code")) throw new OidcConfigError("The provider does not offer the authorization code flow");
  const challenges = strings(meta.code_challenge_methods_supported);
  if (challenges && !challenges.includes("S256")) throw new OidcConfigError("The provider does not offer PKCE with S256");

  const offered = strings(meta.id_token_signing_alg_values_supported) ?? ["RS256"];
  const algorithms = offered.filter((alg) => ASYMMETRIC.includes(alg));
  if (!algorithms.length) {
    throw new OidcConfigError(`The provider signs ID tokens with ${offered.join(", ") || "nothing"}, and the portal only takes ones signed with a key of the provider's (${ASYMMETRIC.join(", ")})`);
  }

  let tokenAuth: OidcProvider["tokenAuth"] = "none";
  if (config.clientSecret) {
    // client_secret_basic is what a provider that says nothing takes.
    const methods = strings(meta.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"];
    if (methods.includes("client_secret_basic")) tokenAuth = "client_secret_basic";
    else if (methods.includes("client_secret_post")) tokenAuth = "client_secret_post";
    else throw new OidcConfigError(`The provider takes a client secret neither as client_secret_basic nor as client_secret_post (it offers ${methods.join(", ")})`);
  }

  // The ID token's keys. A key the portal has not seen sends it back for them,
  // so a provider that rotates them is followed; the wait between two such
  // fetches is short, since every attempt to make it fetch comes through the
  // throttled callback.
  const jwks = createRemoteJWKSet(jwksUri, { cooldownDuration: 1_000, timeoutDuration: PROVIDER_TIMEOUT_MS });
  try {
    await jwks.reload();
  } catch (e) {
    throw new OidcConfigError(`The provider's keys at ${jwksUri.href} could not be read: ${(e as Error).message}`);
  }

  return {
    config, authorizationEndpoint, tokenEndpoint, endSessionEndpoint, jwks, algorithms, tokenAuth,
    issParameter: meta.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * The path a login goes on to, when it is one of the portal's own pages; the
 * start page otherwise. Never another origin, nor an API route.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "/";
  // `//host` and `/\host` are other origins to a browser; a control character is never part of a path that was meant.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  const base = "http://portal.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }
  // Checked again on what is returned: dot segments collapse, so `/.//host` comes out as `//host`.
  // Express matches routes whatever their case, so `/API/` is an API route too.
  const lower = url.pathname.toLowerCase();
  if (url.origin !== base || url.pathname.startsWith("//") || lower === "/api" || lower.startsWith("/api/")) return "/";
  return url.pathname + url.search;
}
