/**
 * Where the single sign-on settings are kept in the portal's own settings.
 *
 * Nothing here touches the database, so that the command that switches the
 * password login back on (sso-only-off) can use the names without starting a login.
 */

/** The provider's settings, as JSON (see SsoSettings in oidc.ts); absent while single sign-on is not set up. */
export const SSO_KEY = "sso_oidc";
/** "1" while the password login is switched off and only the provider signs in. */
export const SSO_ONLY_KEY = "sso_oidc_only";
