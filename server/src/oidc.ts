import { createRemoteJWKSet, type JWTPayload, type RemoteJWKSet } from "jose";

/**
 * Signing in through an OpenID Connect provider: what the deployment asks for,
 * and what the provider says about itself.
 *
 * Everything here fails closed. A setting that is not quite right, or a
 * provider that does not answer or calls itself by another name, stops the
 * portal at start with a message, rather than leaving it open or with a login
 * that nobody can use. The flow itself is in oidc-login.ts.
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
  allowedEmails: Set<string>;
  allowedGroups: Set<string>;
  groupsClaim: string;
  allowedSubjects: Set<string>;
}

export class OidcConfigError extends Error {}

const flag = (value: string | undefined) => /^(1|true|yes)$/i.test(value ?? "");

/** A comma-separated list. Commas only, since a group's name may have a space in it. */
const list = (value: string | undefined, fold = (s: string) => s) =>
  new Set((value ?? "").split(",").map((s) => fold(s.trim())).filter(Boolean));

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

/** What the environment asks for, or null where it asks for no single sign-on. Throws on a setting that cannot be right. */
export function readOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuer = (env.OIDC_ISSUER ?? "").trim();
  if (!issuer) {
    // Said, rather than ignored: OIDC_ONLY without a provider would be a portal with no login at all.
    const stray = Object.keys(env).filter((name) => name.startsWith("OIDC_") && (env[name] ?? "").trim() !== "");
    if (stray.length) throw new OidcConfigError(`${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but OIDC_ISSUER is not`);
    return null;
  }
  const issuerUrl = providerUrl(issuer, "OIDC_ISSUER", true);
  if (issuerUrl.search || issuerUrl.hash) throw new OidcConfigError("OIDC_ISSUER must not have a query or a fragment");
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  if (!clientId) throw new OidcConfigError("OIDC_ISSUER is set but OIDC_CLIENT_ID is not");

  // Never taken from a request's Host header: that is the sender's to choose.
  const redirect = (env.OIDC_REDIRECT_URL ?? "").trim() ||
    ((env.PORTAL_PUBLIC_URL ?? "").trim() ? `${(env.PORTAL_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")}${CALLBACK_PATH}` : "");
  if (!redirect) throw new OidcConfigError(`set OIDC_REDIRECT_URL to the portal's address followed by ${CALLBACK_PATH} (or PORTAL_PUBLIC_URL to the portal's address)`);
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    throw new OidcConfigError(`OIDC_REDIRECT_URL is not a URL: ${JSON.stringify(redirect)}`);
  }
  if (redirectUrl.protocol !== "https:" && redirectUrl.protocol !== "http:") throw new OidcConfigError("OIDC_REDIRECT_URL must be an http or https URL");
  if (redirectUrl.pathname !== CALLBACK_PATH || redirectUrl.search || redirectUrl.hash || redirectUrl.username || redirectUrl.password) {
    throw new OidcConfigError(`OIDC_REDIRECT_URL must be the portal's address followed by ${CALLBACK_PATH}, and nothing else: ${redirectUrl.href}`);
  }

  const scopes = (env.OIDC_SCOPES ?? "").trim().split(/\s+/).filter(Boolean);
  if (scopes.length && !scopes.includes("openid")) throw new OidcConfigError("OIDC_SCOPES must include openid");

  return {
    issuer,
    clientId,
    ...((env.OIDC_CLIENT_SECRET ?? "") ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
    redirectUrl,
    scopes: scopes.length ? scopes.join(" ") : "openid email profile",
    name: (env.OIDC_NAME ?? "").trim() || "SSO",
    only: flag(env.OIDC_ONLY),
    endSession: flag(env.OIDC_END_SESSION),
    allowedEmails: list(env.OIDC_ALLOWED_EMAILS, (s) => s.toLowerCase()),
    allowedGroups: list(env.OIDC_ALLOWED_GROUPS),
    groupsClaim: (env.OIDC_GROUPS_CLAIM ?? "").trim() || "groups",
    allowedSubjects: list(env.OIDC_ALLOWED_SUBJECTS),
  };
}

/** Whether the allow-list lets anybody in: an empty one refuses everyone. */
export const allowsAnyone = (config: OidcConfig) =>
  config.allowedEmails.size + config.allowedGroups.size + config.allowedSubjects.size > 0;

/**
 * What the cookies are signed with depends on this too, so that changing the
 * provider or who may sign in ends every login made before: somebody taken off
 * the list is not let in for another thirty days on the cookie they hold.
 */
export const fingerprint = (config: OidcConfig) =>
  JSON.stringify([
    config.issuer, config.clientId, config.groupsClaim,
    [...config.allowedEmails].sort(), [...config.allowedGroups].sort(), [...config.allowedSubjects].sort(),
  ]);

/** Signature algorithms an ID token may be signed with: the provider's keys only, never a shared secret or none. */
const ASYMMETRIC = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];

export interface OidcProvider {
  config: OidcConfig;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  userinfoEndpoint?: URL;
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
    throw new OidcConfigError(`the provider's discovery document ${where} could not be read: ${(e as Error).message}`);
  }
  // The exact string: it is what every ID token's `iss` is compared with.
  if (meta.issuer !== config.issuer) {
    throw new OidcConfigError(`the provider calls itself ${JSON.stringify(meta.issuer)}, not ${JSON.stringify(config.issuer)}: OIDC_ISSUER must be exactly what it says`);
  }
  const endpoint = (name: string, required: boolean) => {
    if (meta[name] === undefined && !required) return undefined;
    return providerUrl(meta[name], `the provider's ${name}`, loopbackHttp);
  };
  const authorizationEndpoint = endpoint("authorization_endpoint", true)!;
  const tokenEndpoint = endpoint("token_endpoint", true)!;
  const jwksUri = endpoint("jwks_uri", true)!;
  const userinfoEndpoint = endpoint("userinfo_endpoint", false);
  const endSessionEndpoint = endpoint("end_session_endpoint", false);

  const responseTypes = strings(meta.response_types_supported);
  if (responseTypes && !responseTypes.includes("code")) throw new OidcConfigError("the provider does not offer the authorization code flow");
  const challenges = strings(meta.code_challenge_methods_supported);
  if (challenges && !challenges.includes("S256")) throw new OidcConfigError("the provider does not offer PKCE with S256");

  const offered = strings(meta.id_token_signing_alg_values_supported) ?? ["RS256"];
  const algorithms = offered.filter((alg) => ASYMMETRIC.includes(alg));
  if (!algorithms.length) {
    throw new OidcConfigError(`the provider signs ID tokens with ${offered.join(", ") || "nothing"}, and the portal only takes ones signed with a key of the provider's (${ASYMMETRIC.join(", ")})`);
  }

  let tokenAuth: OidcProvider["tokenAuth"] = "none";
  if (config.clientSecret) {
    // client_secret_basic is what a provider that says nothing takes.
    const methods = strings(meta.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"];
    if (methods.includes("client_secret_basic")) tokenAuth = "client_secret_basic";
    else if (methods.includes("client_secret_post")) tokenAuth = "client_secret_post";
    else throw new OidcConfigError(`the provider takes a client secret neither as client_secret_basic nor as client_secret_post (it offers ${methods.join(", ")})`);
  }

  // The ID token's keys. A key the portal has not seen sends it back for them,
  // so a provider that rotates them is followed; the wait between two such
  // fetches is short, since every attempt to make it fetch comes through the
  // throttled callback.
  const jwks = createRemoteJWKSet(jwksUri, { cooldownDuration: 1_000, timeoutDuration: PROVIDER_TIMEOUT_MS });
  try {
    await jwks.reload();
  } catch (e) {
    throw new OidcConfigError(`the provider's keys at ${jwksUri.href} could not be read: ${(e as Error).message}`);
  }

  return {
    config, authorizationEndpoint, tokenEndpoint, userinfoEndpoint, endSessionEndpoint, jwks, algorithms, tokenAuth,
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

/** The claims the allow-list is read from. */
export interface Identity {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  groups?: unknown;
}

/** What let this identity in, or null for nobody on the list. An email counts only once the provider has verified it. */
export function admitted(identity: Identity, config: OidcConfig): string | null {
  if (config.allowedSubjects.has(identity.sub)) return "subject";
  if (typeof identity.email === "string" && identity.email_verified === true && config.allowedEmails.has(identity.email.toLowerCase())) return "email";
  const groups = typeof identity.groups === "string" ? [identity.groups] : strings(identity.groups) ?? [];
  if (groups.some((group) => config.allowedGroups.has(group))) return "group";
  return null;
}

/** Whether the allow-list needs a claim this token does not carry, so that the userinfo endpoint is asked. */
export function needsUserinfo(claims: JWTPayload, config: OidcConfig): boolean {
  if (config.allowedSubjects.has(String(claims.sub))) return false;
  return (config.allowedEmails.size > 0 && (claims.email === undefined || claims.email_verified === undefined)) ||
    (config.allowedGroups.size > 0 && claims[config.groupsClaim] === undefined);
}

/** Said once, the same way, for every way single sign-on can be set up wrong. */
export function refuseToStart(message: string): never {
  console.error(
    `\n  Single sign-on (OIDC_ISSUER) is not set up right: ${message}.\n` +
      "  The portal does not start with a login it cannot check.\n"
  );
  process.exit(1);
}

/** What this portal's environment asks for, read once at start; null without single sign-on. */
export const oidcConfig: OidcConfig | null = (() => {
  try {
    return readOidcConfig(process.env);
  } catch (e) {
    if (e instanceof OidcConfigError) refuseToStart(e.message);
    throw e;
  }
})();
