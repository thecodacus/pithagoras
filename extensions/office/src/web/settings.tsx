import { useState } from "react";
import { portal, t } from "../portal";
import { api, sayError } from "./api";
import { floatingTag } from "../office-ui";
import { refreshOfficeState, useOfficeState } from "./state";

/**
 * The Office page in Settings: a service panel for the Document Server -- where it stands (and what a first pull is
 * doing), start and stop, the pinned image tag, co-editing, and where the documents live. Enabling goes through
 * POST /settings, which answers without waiting for a first pull to finish (`starting`): the pull progress keeps
 * coming in over the shared 5 s poll, and the server half's lookAfter stays quiet while the person has stopped it.
 */

function mem(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
}

export function OfficeSettings() {
  portal.locale.use();
  const state = useOfficeState();
  const [busy, setBusy] = useState<null | "start" | "stop" | "settings">(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Null: still saying what the server says. A string: what is in the input now.
  const [tag, setTag] = useState<string | null>(null);

  if (!state) return <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const c = state.container;
  const running = c.state === "running";
  const pull = c.pull;

  async function act(kind: NonNullable<typeof busy>, work: () => Promise<unknown>): Promise<void> {
    setBusy(kind);
    setProblem(null);
    try {
      await work();
      await refreshOfficeState();
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(null);
    }
  }

  const saveTag = () =>
    act("settings", async () => {
      const next = (tag ?? state.imageTag).trim();
      if (next === "") throw new Error(t("{ imageTag } must be a non-empty string like onlyoffice/documentserver:10.0"));
      // The same refusal the server makes, made here first: never a floating tag (it breaks the co-editing keys).
      if (floatingTag(next)) throw new Error(t("Never pin :latest — a moved image changes the Document Server under you and breaks the co-editing keys."));
      await api.saveSettings({ imageTag: next });
    });

  const start = () =>
    act("start", async () => {
      // A first start pulls the whole image and takes minutes; the route awaits it, so this fetch stays open while
      // the pull progress is shown from /state meanwhile.
      await api.startContainer();
      setTag(null);
    });

  const stop = () => act("stop", async () => {
    await api.stopContainer();
    setTag(null);
  });

  return (
    <div className="space-y-4">
      {/* The service itself: where it stands, and what a pull is doing. */}
      <div className="po-service" role="status">
        <div className="po-service-head">
          <span
            className={
              "h-2 w-2 rounded-full " +
              (running ? "po-state-live bg-ok" : c.state === "starting" || (pull?.active ?? false) ? "po-state-pulling bg-warn" : "bg-fg-subtle")
            }
          />
          {t("OnlyOffice Document Server")}
        </div>
        <div className="po-service-detail">
          {c.state}
          {running && c.version ? ` · ${c.version}` : ""}
          {c.memBytes !== undefined ? ` · ${mem(c.memBytes)}` : ""}
        </div>
        {pull && pull.active && (
          <div className="po-pull-line">
            {t("Pulling the image")} · {pull.line}
            {pull.error ? <span className="text-danger"> — {pull.error}</span> : null}
          </div>
        )}
      </div>

      {/* Enabling it: with the memory warning before a first start (plan 2.4/5.1: ~4 GB RAM recommended at runtime). */}
      {!state.enabled && (
        <portal.ui.WarnBanner>
          {t("About 4 GB of RAM is recommended for the Document Server while it runs. Its image is pulled on the first start and takes a while; its working data keeps in a container volume, every save comes back to the library.")}
        </portal.ui.WarnBanner>
      )}

      <portal.ui.SwitchRow
        title={t("Use Office")}
        detail={t("Starts the Document Server on this machine when switched on, and stops it when switched off. The server keeps it going while it stands (and never brings back one that was stopped on purpose).")}
        on={state.enabled}
        disabled={busy !== null}
        onChange={(on) => void act("settings", () => api.saveSettings({ enabled: on }))}
      />
      <portal.ui.SwitchRow
        title={t("Live co-editing between agent and editor")}
        detail={t("While on, an agent edit of a document somebody has open proceeds under the revision gate with a force-save request first; while off, it is refused until the editor is closed. Switching it off is the escape hatch.")}
        on={state.coEdit}
        disabled={busy !== null}
        onChange={(on) => void act("settings", () => api.saveSettings({ coEdit: on }))}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null || running} onClick={() => void start()}>
          {busy === "start" ? t("Starting… (first pull can take minutes)") : t("Start container")}
        </button>
        <button type="button" className={portal.ui.classes.button} disabled={busy !== null || !running} onClick={() => void stop()}>
          {busy === "stop" ? t("Stopping…") : t("Stop container")}
        </button>
      </div>

      <portal.ui.Field label={t("Image tag (pinned)")} hint={t("Never pin :latest — a moved image changes the Document Server under you and breaks the co-editing keys. A new tag applies at the next start.")}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${portal.ui.classes.input} mt-1 font-mono text-xs`}
            style={{ maxWidth: "24rem" }}
            value={tag ?? state.imageTag}
            aria-label={t("Image tag (pinned)")}
            disabled={busy !== null || running}
            onChange={(e) => setTag(e.target.value)}
          />
          <button type="button" className={portal.ui.classes.primarySmall} disabled={busy !== null || running} onClick={() => void saveTag()}>
            {t("Save")}
          </button>
        </div>
      </portal.ui.Field>

      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</portal.ui.ErrorBanner>
      )}

      {/* Where the things live, and who can reach them: said once, as fact. */}
      <div className="space-y-1">
        <p className="po-exposure">{t("Documents keep in this extension's own data directory (its docs folder with its index and trash), not in a chat's folder; import and export are copies.")}</p>
        <p className="po-exposure">{t("The editor itself loads from the Document Server's own origin on this machine, so it works from here over plain HTTP; remote viewers reach the library, but not the live editor (a portal-side proxy would unlock that). The server-facing document fetch and callback endpoints are bound to 127.0.0.1 only.")}</p>
      </div>
    </div>
  );
}
