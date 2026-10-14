import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { MIN_PASSWORD_LENGTH, passwordMistake } from "../password";
import { t } from "../i18n";
import { Empty, Field, LoadFailed, Section, inputCls, primaryCls } from "./SettingsUi";

/** Settings → Authentication, its password: changing the one password that signs in to the portal. */
export function PasswordPanel() {
  const [required, setRequired] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setFailed(null);
    api.authStatus().then((s) => setRequired(s.authRequired), (e) => setFailed(e));
  };
  useEffect(load, []);

  if (failed) return <LoadFailed error={failed} onRetry={load} />;
  if (required === null) return null;
  if (!required) {
    return (
      <Empty>
        {t("This portal runs without a login, because PORTAL_ALLOW_NO_PASSWORD is set: whatever sits in front of it signs people in, so there is no password to change and no single sign-on to set up here.")}
      </Empty>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChanged(false);
    const mistake = passwordMistake(password, repeat);
    if (mistake) return setError(mistake);
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, password);
      setCurrent("");
      setPassword("");
      setRepeat("");
      setChanged(true);
    } catch (err) {
      // The server's own words where it said no (the example password); a wrong current one is said here, in the language shown.
      setError(
        err instanceof ApiError && err.status === 403
          ? t("The current password is wrong.")
          : err instanceof ApiError && err.status === 429
            ? err.message
            : err instanceof ApiError && err.status >= 400 && err.status < 500
              ? err.message
              : t("Cannot reach the portal"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("Change password")} hint={t("Every other browser is signed out by it, and asks for the new password. This one stays signed in.")}>
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <Field label={t("Current password")}>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        </Field>
        <Field label={t("New password")} hint={t("At least {count} characters.", { count: MIN_PASSWORD_LENGTH })}>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
        </Field>
        <Field label={t("Repeat the new password")}>
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={inputCls} />
        </Field>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {changed && <p role="status" className="text-xs text-ok">{t("The password is changed.")}</p>}
        <button type="submit" disabled={busy || !current || !password || !repeat} className={primaryCls}>
          {busy ? t("Saving…") : t("Change password")}
        </button>
      </form>
    </Section>
  );
}
