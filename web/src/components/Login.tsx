import { useState } from "react";
import { api, ApiError, type SingleSignOn } from "../api";
import { MIN_PASSWORD_LENGTH, passwordMistake } from "../password";
import { t } from "../i18n";

const fieldCls =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/50 focus:ring-4 focus:ring-accent/10";
const buttonCls = "mt-3 w-full rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-40";

function Brand({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <img src="/icon-512.png" alt="" className="h-16 w-16 object-contain p-3" draggable={false} />
      <h1 className="mt-3 text-base font-semibold tracking-tight text-fg">Pithagoras</h1>
      <p className="mt-1 text-xs text-fg-subtle">{t("Give it a task, close the browser, come back later.")}</p>
      {children}
    </div>
  );
}

/**
 * Where the provider's sign-in starts: the portal sends the browser on to it, and it comes back to the page it was
 * on. The server checks that the page is the portal's own.
 */
const ssoStart = () => `/api/auth/oidc/start?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;

/** The password form, the single sign-on button, or both: `sso.only` leaves the password out. */
export function Login({ onSuccess, onSetup, sso }: { onSuccess: () => void; onSetup: () => void; sso?: SingleSignOn }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      // The password was removed while this page was open: there is none to give, and the page asks for a new one.
      if (err instanceof ApiError && err.status === 409 && err.body.setup) return onSetup();
      // The server's own word where it refused (a wrong password, too many tries). Anything else is
      // not the server saying no: a proxy's "HTTP 502" while the portal restarts reads like a broken login.
      // 403: the password login was switched off while this page was open, and the server says to use the provider.
      setError(err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 429) ? err.message : t("Cannot reach the portal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[19rem]">
        <Brand />

        {sso && (
          <a href={ssoStart()} className="block w-full rounded-xl bg-accent px-3 py-2.5 text-center text-sm font-medium text-accent-fg transition hover:opacity-90">
            {t("Sign in with {name}", { name: sso.name })}
          </a>
        )}
        {sso && !sso.only && (
          <div className="my-4 flex items-center gap-3 text-xs text-fg-faint" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            {t("or with the password")}
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {!sso?.only && (
          <>
            <input
              autoFocus={!sso}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("Password")}
              aria-label={t("Password")}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className={fieldCls}
            />
            {error && <p id="login-error" role="alert" className="mt-2 text-xs text-danger">{error}</p>}

            <button type="submit" disabled={busy || !password} className={buttonCls}>
              {busy ? t("Checking…") : t("Sign in")}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

/** The first start of a portal: nobody has chosen a password yet, and whoever opens it first does. */
export function Setup({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const mistake = passwordMistake(password, repeat);
    if (mistake) return setError(mistake);
    setBusy(true);
    setError(null);
    try {
      await api.setupPassword(password);
      onSuccess();
    } catch (err) {
      // A password chosen by somebody else while this form was open is the server's word, like any other refusal of it.
      setError(err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : t("Cannot reach the portal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[19rem]">
        <Brand>
          <p className="mt-4 text-sm font-medium text-fg">{t("Choose a password")}</p>
          <p className="mt-1 text-xs text-fg-subtle">{t("It signs you in to this portal, which can run commands on the machine it is on. Use at least {count} characters. You can change it later under Settings.", { count: MIN_PASSWORD_LENGTH })}</p>
        </Brand>

        <input
          autoFocus
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("New password")}
          aria-label={t("New password")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "setup-error" : undefined}
          className={fieldCls}
        />
        <input
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          placeholder={t("Repeat the password")}
          aria-label={t("Repeat the password")}
          aria-invalid={error ? true : undefined}
          className={`${fieldCls} mt-2`}
        />
        {error && <p id="setup-error" role="alert" className="mt-2 text-xs text-danger">{error}</p>}

        <button type="submit" disabled={busy || !password || !repeat} className={buttonCls}>
          {busy ? t("Saving…") : t("Set password")}
        </button>
      </form>
    </div>
  );
}
