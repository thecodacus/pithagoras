import { useCallback, useEffect, useState } from "react";
import { portal, t, tx } from "../portal";

/** One made extension, as the server half lists it (GET /made). */
interface Made {
  name: string;
  version?: string;
  digest: string;
  at: string;
  chat: { id: string; title: string } | null;
  draft: string;
  installed: boolean;
  enabled?: boolean;
}

const pill = "rounded-md bg-fg/5 px-1.5 py-0.5 text-[10px] leading-4 text-fg-subtle";

/**
 * Creator mode's page in Settings: what agents made in Creator mode chats, newest first, each with whether it is
 * installed and on, the chat it was made in, when, and its digest. Switching one off and removing it is Settings →
 * Extensions'; one removed there keeps its copy here until it is forgotten.
 */
export function MadePage() {
  portal.locale.use();
  const { ui } = portal;
  const [made, setMade] = useState<Made[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadFailed(null);
    portal.api.json<{ made: Made[] }>(portal.api.url("/made")).then(
      (answer) => setMade(answer.made),
      (e) => setLoadFailed((e as Error).message),
    );
  }, []);
  useEffect(load, [load]);

  if (loadFailed) return <ui.LoadFailed error={loadFailed} onRetry={load} />;
  if (!made) return <ui.RowsSkeleton rows={3} label={t("Loading…")} />;

  const forget = async (one: Made) => {
    const sure = await ui.confirm({
      title: t("Forget {name}?", { name: one.name }),
      message: t("Its copy is deleted from Creator mode's folder. It is not installed, so nothing else changes."),
      confirmLabel: t("Forget"),
      danger: true,
      deletes: true,
    });
    if (!sure) return;
    try {
      await portal.api.json(portal.api.url(`/made/${encodeURIComponent(one.name)}`), { method: "DELETE" });
      setFailure(null);
      load();
    } catch (e) {
      setFailure((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      {failure && <ui.ErrorBanner onClose={() => setFailure(null)}>{failure}</ui.ErrorBanner>}
      {/* The page's head, drawn by Settings, has the extension's name and mark already. */}
      <p className="text-xs text-fg-faint">
        {t("What agents made in Creator mode chats, newest first. Each is installed for the whole portal: switch it off or remove it in Settings → Extensions.")}
      </p>
      {made.length === 0 ? (
        <ui.Empty>{t("Nothing made yet. Start a chat in Creator mode: what its agent installs is listed here.")}</ui.Empty>
      ) : (
        <ul className="space-y-2">
          {made.map((one) => (
            <li key={one.name} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-fg">{one.name}</span>
                {one.version && <span className="text-xs text-fg-faint">{one.version}</span>}
                <span className={pill}>{one.installed ? (one.enabled ? t("On") : t("Off")) : t("Not installed")}</span>
                {!one.installed && (
                  <button type="button" onClick={() => void forget(one)} className="ml-auto rounded-lg px-2 py-1 text-xs text-danger transition hover:bg-danger/10">
                    {t("Forget")}
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-fg-muted">
                {one.chat
                  ? tx("Made in {chat}", {
                      chat: (
                        <a
                          href={`/s/${one.chat.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            portal.navigate(`/s/${one.chat!.id}`);
                          }}
                          className="text-accent hover:underline"
                        >
                          {one.chat.title}
                        </a>
                      ),
                    })
                  : t("Made in a chat that was deleted")}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-faint">
                <span>{portal.format.dateTime(one.at)}</span>
                <span className="font-mono" title={one.digest}>
                  {one.digest.slice(0, 12)}
                </span>
                <span className="font-mono">{one.draft}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
