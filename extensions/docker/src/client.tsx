import { useCallback, useEffect, useState } from "react";
import { LuContainer } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import type { ContainerInfo, VolumeInfo } from "./api";
import { de } from "./de";
import { msg, portal, setPortal, t } from "./portal";
import "./client.css";

/**
 * Docker's page in Settings: whether the portal reaches Docker, and the containers and volumes each extension runs,
 * which the person may start, stop and remove, and whose output they may read. What the extensions are given to run
 * them with is the server half's (api.ts).
 */

type Overview = { available: false; socket: boolean } | { available: true; version: string; containers: ContainerInfo[]; volumes: VolumeInfo[] };

/** How often the page asks how things stand, while it is open. */
const EVERY_MS = 5_000;

const at = (path: string) => portal.api.url(path);
const name = (n: string) => encodeURIComponent(n);
const dotOf = (state: string) => (state === "running" ? "running" : state === "dead" ? "error" : state === "restarting" || state === "paused" ? "interrupted" : "idle");

function DockerPage() {
  portal.locale.use();
  const { ui } = portal;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await portal.api.json<Overview>(at("/overview")));
      setFailed(null);
    } catch (e) {
      setFailed(e as Error);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  /** Something done to a container or a volume, and how things stand after it; what went wrong is said above the list. */
  const act = async (key: string, url: string, method: string) => {
    setBusy(key);
    setProblem(null);
    try {
      await portal.api.json(url, { method });
      await load();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (container: ContainerInfo) => {
    const ok = await ui.confirm({
      title: t("Remove {name}?", { name: container.name }),
      message: t("The container is stopped and removed. What {owner} keeps in a volume stays; it may make the container again.", { owner: container.owner }),
      confirmLabel: t("Remove"),
      danger: true,
    });
    if (ok) await act(`remove ${container.name}`, at(`/containers/${name(container.name)}`), "DELETE");
  };
  const removeVolume = async (volume: VolumeInfo) => {
    const ok = await ui.confirm({
      title: t("Delete the volume {name}?", { name: volume.name }),
      message: t("Everything {owner} kept in it is deleted for good.", { owner: volume.owner }),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (ok) await act(`volume ${volume.name}`, at(`/volumes/${name(volume.name)}`), "DELETE");
  };
  const readLogs = async (container: ContainerInfo) => {
    if (logs?.name === container.name) return setLogs(null);
    setBusy(`logs ${container.name}`);
    setProblem(null);
    try {
      const { text } = await portal.api.json<{ text: string }>(at(`/containers/${name(container.name)}/logs?tail=200`));
      setLogs({ name: container.name, text });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (failed && !overview) return <ui.LoadFailed error={failed} onRetry={load} />;
  if (!overview) return <ui.RowsSkeleton rows={3} label={t("Loading…")} />;
  if (!overview.available) {
    return (
      <ui.Section title={t("Docker")}>
        <ui.WarnBanner>
          {overview.socket ? t("Docker's socket is there, but Docker does not answer on it. Is Docker running?") : t("The portal cannot reach Docker: its container has no Docker socket.")}
        </ui.WarnBanner>
        {!overview.socket && (
          <p className="dk-docker-hint">
            {t("Give it the socket in docker-compose.yml, under the portal's volumes, and start it again:")} <code>- /var/run/docker.sock:/var/run/docker.sock</code>
          </p>
        )}
      </ui.Section>
    );
  }

  const owners = [...new Set(overview.containers.map((c) => c.owner))].sort();
  return (
    <div className="dk-docker">
      <ui.Section title={t("Docker")} hint={t("Docker {version}, reached through its socket. The containers and volumes the extensions run, by the extension that runs each.", { version: overview.version })}>
        {problem && <ui.ErrorBanner onClose={() => setProblem(null)}>{problem}</ui.ErrorBanner>}
        {!owners.length && <ui.Empty>{t("No extension runs a container.")}</ui.Empty>}
      </ui.Section>
      {owners.map((owner) => (
        <ui.Section key={owner} title={owner}>
          <ul className="dk-docker-list">
            {overview.containers
              .filter((c) => c.owner === owner)
              .map((container) => (
                <li key={container.id}>
                  <div className="dk-docker-row">
                    <ui.StatusDot status={dotOf(container.state)} />
                    <div className="dk-docker-what">
                      <span className="dk-docker-name">{container.name}</span>
                      <span className="dk-docker-meta">{`${container.image} · ${container.status}`}</span>
                    </div>
                    {/* One Docker waits to start again is running to it, and a stop ends the wait; a start would do nothing. */}
                    {container.state === "running" || container.state === "restarting" ? (
                      <button type="button" className={ui.classes.ghost} disabled={busy !== null} onClick={() => void act(`stop ${container.name}`, at(`/containers/${name(container.name)}/stop`), "POST")}>
                        {t("Stop")}
                      </button>
                    ) : (
                      <button type="button" className={ui.classes.ghost} disabled={busy !== null} onClick={() => void act(`start ${container.name}`, at(`/containers/${name(container.name)}/start`), "POST")}>
                        {t("Start")}
                      </button>
                    )}
                    <button type="button" className={ui.classes.ghost} disabled={busy !== null} aria-expanded={logs?.name === container.name} onClick={() => void readLogs(container)}>
                      {t("Logs")}
                    </button>
                    <button type="button" className={ui.classes.ghost} disabled={busy !== null} onClick={() => void remove(container)}>
                      {t("Remove")}
                    </button>
                  </div>
                  {logs?.name === container.name && <pre className="dk-docker-logs" aria-label={t("What {name} wrote", { name: container.name })}>{logs.text || t("It has written nothing.")}</pre>}
                </li>
              ))}
          </ul>
        </ui.Section>
      ))}
      {overview.volumes.length > 0 && (
        <ui.Section title={t("Volumes")} hint={t("What the extensions keep, which stays when a container is removed.")}>
          <ul className="dk-docker-list">
            {overview.volumes.map((volume) => (
              <li key={volume.name} className="dk-docker-row">
                <div className="dk-docker-what">
                  <span className="dk-docker-name">{volume.name}</span>
                  <span className="dk-docker-meta">{volume.owner}</span>
                </div>
                <button type="button" className={ui.classes.ghost} disabled={busy !== null} onClick={() => void removeVolume(volume)}>
                  {t("Delete")}
                </button>
              </li>
            ))}
          </ul>
        </ui.Section>
      )}
    </div>
  );
}

export default function docker(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  portal.slots.register("settings.page", { id: "docker", title: msg("Docker"), icon: LuContainer, component: DockerPage });
}
