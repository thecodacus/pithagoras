import { getSetting, putSetting } from "./db.js";
import { keptForm, parseOidcConfig, type OidcConfig } from "./oidc.js";
import { SSO_KEY, SSO_ONLY_KEY } from "./sso-keys.js";

/**
 * Single sign-on (Settings → Authentication), as the portal keeps it: in its own settings, like the password, and read from
 * there on every request, so that the command which switches the password login back on (sso-only-off)
 * takes effect in a running portal.
 */

let read: { kept: string; only: boolean; config: OidcConfig | null } | undefined;

/**
 * The provider's settings, or null where single sign-on is not set up. Settings that no longer read (a
 * damaged row) are no single sign-on at all, said once in the log: the password signs in as before.
 */
export function ssoConfig(): OidcConfig | null {
  const kept = getSetting(SSO_KEY);
  if (!kept) return null;
  const only = getSetting(SSO_ONLY_KEY) === "1";
  if (read?.kept === kept && read.only === only) return read.config;
  let config: OidcConfig | null = null;
  try {
    config = parseOidcConfig(JSON.parse(kept), only);
  } catch (e) {
    console.error(`[auth] the single sign-on settings cannot be read, so single sign-on is off until they are saved again: ${(e as Error).message}`);
  }
  read = { kept, only, config };
  return config;
}

/** Keeps the settings, the secret among them, and whether the password login is switched off. */
export function saveSso(config: OidcConfig): void {
  putSetting(SSO_KEY, JSON.stringify(keptForm(config)));
  putSetting(SSO_ONLY_KEY, config.only ? "1" : "");
}

/** Single sign-on taken out: the password is the way in again. */
export function removeSso(): void {
  putSetting(SSO_ONLY_KEY, "");
  putSetting(SSO_KEY, "");
}
