import { useEffect, useState } from "react";
import { api, ApiError, type SsoInput, type SsoState } from "../api";
import { t } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";
import { Empty, Field, LoadFailed, Section, SwitchRow, btnCls, codeAreaCls, inputCls, primaryCls } from "./SettingsUi";

/** A list as the page shows it: one entry a line. */
const lines = (list: string[]) => list.join("\n");
/** And back: emails and subjects may also be given with commas between them, a group's name may hold one. */
const entries = (text: string, commas: boolean) => text.split(commas ? /[\n,]/ : /\n/).map((s) => s.trim()).filter(Boolean);

interface Form {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string;
  name: string;
  endSession: boolean;
  allowedEmails: string;
  allowedGroups: string;
  groupsClaim: string;
  allowedSubjects: string;
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
    allowedEmails: lines(s?.allowedEmails ?? []),
    allowedGroups: lines(s?.allowedGroups ?? []),
    groupsClaim: s?.groupsClaim ?? "",
    allowedSubjects: lines(s?.allowedSubjects ?? []),
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

/** Settings → Single sign-on: signing in through an OpenID Connect provider, beside the password or instead of it. */
export function SsoPanel() {
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
  if (!state || !form) return null;
  if (state.mode !== "password") {
    return (
      <Empty>
        {t("This portal runs without a login, because PORTAL_ALLOW_NO_PASSWORD is set: whatever sits in front of it signs people in, so there is no single sign-on to set up here.")}
      </Empty>
    );
  }

  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm({ ...form, [key]: value });
  const text = (key: Exclude<keyof Form, "endSession" | "only">) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key)(e.target.value),
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
      allowedEmails: entries(form.allowedEmails, true),
      allowedGroups: entries(form.allowedGroups, false),
      groupsClaim: form.groupsClaim,
      allowedSubjects: entries(form.allowedSubjects, true),
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

  const area = `${codeAreaCls} min-h-[4.5rem]`;
  const kept = state.settings;
  // The kept secret is only ever used for the provider and client it was given for: for another, it is typed again.
  const otherClient = Boolean(kept?.hasSecret) && (form.issuer.trim() !== kept?.issuer || form.clientId.trim() !== kept?.clientId);
  // Saved settings that name nobody: the button is on the login page, and lets nobody in.
  const nobody = Boolean(kept) && !kept?.allowedEmails.length && !kept?.allowedGroups.length && !kept?.allowedSubjects.length;
  return (
    <form onSubmit={save}>
      <Section
        title={t("Provider")}
        hint={t("Sign in through an OpenID Connect provider, such as Authentik, Keycloak, Entra ID or Google, beside the password or instead of it. Make a client for the authorization code flow there, with the redirect URL below.")}
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

      <Section
        title={t("Who may sign in")}
        hint={t("Nobody gets in just because the provider knows them: only who is named here. With all three empty, nobody does.")}
      >
        <div className="max-w-xl space-y-3">
          {nobody && (
            <p role="note" className="text-xs text-warn">
              {t("Nobody is named here yet, so the provider's sign-in lets nobody in.")}
            </p>
          )}
          <Field label={t("Emails")} hint={t("One a line. Only counts when the provider says the email is verified.")}>
            <textarea {...text("allowedEmails")} spellCheck={false} className={area} />
          </Field>
          <Field label={t("Groups")} hint={t("One a line, written as the provider sends them.")}>
            <textarea {...text("allowedGroups")} spellCheck={false} className={area} />
          </Field>
          <Field label={t("Groups claim")}>
            <input {...text("groupsClaim")} placeholder="groups" spellCheck={false} className={inputCls} />
          </Field>
          <Field label={t("Subjects")} hint={t("The provider's IDs for the accounts (sub), one a line.")}>
            <textarea {...text("allowedSubjects")} spellCheck={false} className={area} />
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

      <Section title={t("Save")} hint={t("Saving asks for the portal's password. A change to the provider, to who may sign in or to OIDC only signs out every other browser.")}>
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
  );
}
