import { useEffect, useState } from "react";
import { api, ApiError, type SsoInput, type SsoState } from "../api";
import { t } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";
import { CollapsibleSection, Field, LoadFailed, Section, SwitchRow, btnCls, inputCls, primaryCls } from "./SettingsUi";

interface Form {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
  name: string;
  endSession: boolean;
  only: boolean;
}

function formOf(state: SsoState): Form {
  const s = state.settings;
  return {
    issuer: s?.issuer ?? "",
    clientId: s?.clientId ?? "",
    clientSecret: "",
    // A first setup starts from the address this page is open at, which is the one to register at the provider.
    redirectUrl: s?.redirectUrl ?? `${window.location.origin}${state.callbackPath}`,
    scopes: s?.scopes ?? "",
    name: s?.name ?? "",
    endSession: s?.endSession ?? false,
    only: state.only,
  };
}

/** The words of a refusal: the server's where it said no, and in this page's language where the password was wrong. */
const refusal = (err: unknown) =>
  err instanceof ApiError && err.status === 403
    ? t("The current password is wrong.")
    : err instanceof ApiError && err.status >= 400 && err.status < 500
      ? err.message
      : t("Cannot reach the portal");

/**
 * Settings → Authentication, its single sign-on: signing in through an OpenID Connect provider, beside the password
 * or instead of it. A section that opens and closes, closed at first: most portals sign in with the password alone.
 */
export function SsoPanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SsoState | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [removeSecret, setRemoveSecret] = useState(false);
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setFailed(null);
    api.sso().then((s) => { setState(s); setForm(formOf(s)); }, (e) => setFailed(e));
  };
  useEffect(load, []);

  if (failed) return <LoadFailed error={failed} onRetry={load} />;
  // Without a login there is nothing to set up; the password's part of the page says why.
  if (!state || !form || state.mode !== "password") return null;

  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm({ ...form, [key]: value });
  const text = (key: Exclude<keyof Form, "endSession" | "only">) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key)(e.target.value),
  });

  const done = (next: SsoState, words: string) => {
    setState(next);
    setForm(formOf(next));
    setRemoveSecret(false);
    setCurrent("");
    setSaved(words);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    const settings: SsoInput = {
      issuer: form.issuer,
      clientId: form.clientId,
      // Left out, the server keeps the secret it has; null takes it away, for a public client.
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : removeSecret ? { clientSecret: null } : {}),
      redirectUrl: form.redirectUrl,
      scopes: form.scopes,
      name: form.name,
      endSession: form.endSession,
    };
    try {
      const r = await api.saveSso(current, settings, form.only);
      done({ ...state, settings: r.settings, only: r.only }, r.noEndSession
        ? t("Saved. The provider names no page to end its session at, so signing out ends the portal's login only.")
        : t("Saved."));
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({
      title: t("Take out single sign-on?"),
      message: t("The provider's button goes from the login page, and the password is the way in again. Every other browser is signed out."),
      confirmLabel: t("Take it out"),
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.saveSso(current, null, false);
      done({ ...state, settings: null, only: false }, t("Single sign-on is taken out."));
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  };

  const kept = state.settings;
  // The kept secret is only ever used for the provider and client it was given for: for another, it is typed again.
  const otherClient = Boolean(kept?.hasSecret) && (form.issuer.trim() !== kept?.issuer || form.clientId.trim() !== kept?.clientId);
  // What it is, said while the section is closed: off, or the provider and whether it is the only way in.
  const summary = kept ? (state.only ? `${kept.name} · ${t("OIDC only")}` : kept.name) : t("Off");
  return (
    <CollapsibleSection title={t("Single sign-on")} hint={t("Signing in through an OpenID Connect provider")} summary={summary} open={open} onToggle={() => setOpen(!open)}>
    <form onSubmit={save}>
      <Section
        title={t("Provider")}
        hint={t("Sign in through an OpenID Connect provider, such as Authentik, Keycloak or Entra ID, beside the password or instead of it. Make a client for the authorization code flow there, with the redirect URL below. The portal has no list of its own: every account the provider signs in gets in, so limit the client to your people at the provider.")}
      >
        <div className="max-w-xl space-y-3">
          <Field label={t("Issuer URL")} hint={t("Exactly as the provider names itself in its discovery document.")}>
            <input {...text("issuer")} placeholder="https://id.example.com/realms/home" spellCheck={false} className={inputCls} />
          </Field>
          <Field label={t("Client ID")}>
            <input {...text("clientId")} spellCheck={false} className={inputCls} />
          </Field>
          <Field
            label={t("Client secret")}
            hint={state.settings?.hasSecret && !removeSecret
              ? otherClient
                ? t("The issuer or the client ID changed: type the client secret again, or remove it for a public client.")
                : t("A secret is kept. Leave this empty to keep it.")
              : t("Leave it empty for a public client: the portal uses PKCE either way.")}
          >
            <input type="password" autoComplete="off" {...text("clientSecret")} disabled={removeSecret} className={inputCls} />
          </Field>
          {state.settings?.hasSecret && (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input type="checkbox" checked={removeSecret} onChange={(e) => setRemoveSecret(e.target.checked)} />
              {t("Remove the kept secret (a public client)")}
            </label>
          )}
          <Field label={t("Redirect URL")} hint={t("Register it at the provider. Sign-ins through it end at this address, so open the portal there.")}>
            <input {...text("redirectUrl")} spellCheck={false} className={inputCls} />
          </Field>
          <Field label={t("Scopes")}>
            <input {...text("scopes")} placeholder="openid email profile" spellCheck={false} className={inputCls} />
          </Field>
          <Field label={t("Name on the button")} hint={t("The login page says “Sign in with” and this.")}>
            <input {...text("name")} placeholder="SSO" className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title={t("Signing in and out")}>
        <div className="max-w-xl space-y-2">
          <SwitchRow
            title={t("End the session at the provider too")}
            detail={t("Signing out of the portal then goes on to the provider's sign-out page.")}
            on={form.endSession}
            onChange={set("endSession")}
          />
          <SwitchRow
            title={t("OIDC only")}
            detail={t("The password form is hidden and the password login refused. The password stays set. If the provider stops letting you in, `npm run sso-only-off` on the server switches the password login back on.")}
            on={form.only}
            onChange={set("only")}
            note={form.only && !state.only ? t("Make sure you can sign in through the provider first.") : undefined}
          />
        </div>
      </Section>

      <Section title={t("Save")} hint={t("Saving asks for the portal's password. A change to the provider or to OIDC only signs out every other browser.")}>
        <div className="max-w-sm space-y-3">
          <Field label={t("Current password")}>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
          </Field>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {saved && <p role="status" className="text-xs text-ok">{saved}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !current || !form.issuer.trim() || !form.clientId.trim()} className={primaryCls}>
              {busy ? t("Saving…") : t("Save")}
            </button>
            {state.settings && (
              <button type="button" onClick={remove} disabled={busy || !current} className={btnCls}>
                {t("Take out single sign-on")}
              </button>
            )}
          </div>
        </div>
      </Section>
    </form>
    </CollapsibleSection>
  );
}
