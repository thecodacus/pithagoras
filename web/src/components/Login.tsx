import { useState } from "react";
import { api, ApiError, type SingleSignOn } from "../api";
import { t } from "../i18n";

/**
 * Where the provider's sign-in starts: the portal sends the browser on to it, and
 * it comes back to the page it was on. The server checks that page is the portal's own.
 */
const ssoStart = () => `/api/auth/oidc/start?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;

/** The password form, the single sign-on button, or both: `sso.only` leaves the password out. */
export function Login({ onSuccess, sso }: { onSuccess: () => void; sso?: SingleSignOn }) {
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
      // The server's own word where it refused (a wrong password, too many tries). Anything else is
      // not the server saying no: a proxy's "HTTP 502" while the portal restarts reads like a broken login.
      setError(err instanceof ApiError && (err.status === 401 || err.status === 429) ? err.message : t("Cannot reach the portal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[19rem]">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/icon-512.png" alt="" className="h-16 w-16 object-contain p-3" draggable={false} />
          <h1 className="mt-3 text-base font-semibold tracking-tight text-fg">Pithagoras</h1>
          <p className="mt-1 text-xs text-fg-subtle">
            {t("Give it a task, close the browser, come back later.")}
          </p>
        </div>

        {sso && (
          <a
            href={ssoStart()}
            className="block w-full rounded-xl bg-accent px-3 py-2.5 text-center text-sm font-medium text-accent-fg transition hover:opacity-90"
          >
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
              className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/50 focus:ring-4 focus:ring-accent/10"
            />
            {error && <p id="login-error" role="alert" className="mt-2 text-xs text-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy || !password}
              className="mt-3 w-full rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-40"
            >
              {busy ? t("Checking…") : t("Sign in")}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
