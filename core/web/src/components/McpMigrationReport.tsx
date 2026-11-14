import { useState } from "react";
import { LuDownload, LuPlug, LuRefreshCw } from "react-icons/lu";
import { useMcpMigration } from "../mcp-migration";
import { api, type McpMigrationReport } from "../api";
import { t, tp } from "../i18n";
import { ghostCls } from "./SettingsUi";

/** How many lines of a long list the report shows before it says how many more there are. */
const SHOWN = 20;

function Lines({ items }: { items: string[] }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
      {items.slice(0, SHOWN).map((item, i) => (
        <li key={i} className="break-words">{item}</li>
      ))}
      {items.length > SHOWN && <li className="text-fg-faint">{t("{n} more", { n: items.length - SHOWN })}</li>}
    </ul>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-fg">{title}</p>
      {children}
    </div>
  );
}

/**
 * What the move from the old MCP adapter to pi's own MCP support did (see mcp-migration-run.ts): the servers that were
 * switched off and why, those that were renamed, the stored names it could not carry over, the texts and folders to look at.
 * Kept under Settings → MCP after the note at the top of the page is dismissed. Nothing where there is no report.
 */
/** The files of a folder whose servers can be taken into the user's: pi's own project file and the two other tools' that share its shape. */
const IMPORTABLE = [".pi/mcp.json", ".mcp.json", ".vscode/mcp.json"];

/** One folder of the report, with a button to take the servers of each of its files into the user's configuration, switched off. */
function ProjectLine({ project, onImported }: { project: McpMigrationReport["projects"][number]; onImported: () => void }) {
  const files = [...(project.mcpJson ? [".pi/mcp.json"] : []), ...project.foreign].filter((file) => IMPORTABLE.includes(file));
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, { text: string; error?: boolean }>>({});
  const run = async (file: string) => {
    setBusy(file);
    try {
      const done = await api.importMcpFolder(project.folder, file);
      const text = [
        done.added.length ? t("Added {names}, switched off: look at what each one runs, then switch it on.", { names: done.added.join(", ") }) : "",
        ...Object.entries(done.variables ?? {}).map(([name, names]) => t("{name} sends {variables} from the portal's environment to its address.", { name, variables: names.join(", ") })),
        ...done.skipped.map((one) => t("Skipped {name}: {reason}", { name: one.name, reason: one.reason })),
      ].filter(Boolean).join(" ");
      setSaid((all) => ({ ...all, [file]: { text: text || t("Nothing to import.") } }));
      if (done.added.length) onImported();
    } catch (e) {
      setSaid((all) => ({ ...all, [file]: { text: (e as Error).message, error: true } }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="break-words">
      {[project.folder, project.adapterSettings ? t("lists the adapter") : "", project.mcpJson ? t("has .pi/mcp.json") : "", ...project.foreign].filter(Boolean).join(" — ")}
      {files.map((file) => (
        <span key={file} className="mt-1 block">
          <button type="button" disabled={busy !== null} className={ghostCls} onClick={() => void run(file)} aria-label={t("Import {file} of {folder} into the user config", { file, folder: project.folder })}>
            {busy === file ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : <LuDownload className="h-3.5 w-3.5" />}
            {t("Import {file} into the user config", { file })}
          </button>
          {said[file] && <span role={said[file].error ? "alert" : "status"} className={`ml-2 text-xs ${said[file].error ? "text-danger" : "text-fg-subtle"}`}>{said[file].text}</span>}
        </span>
      ))}
    </li>
  );
}

export function McpMigrationSection({ onImported }: { onImported?: () => void }) {
  const { view, dismiss } = useMcpMigration();
  const report = view?.report;
  if (!report) return null;
  return (
    <section className="mb-6 rounded-xl border border-line bg-raised/40 p-3" aria-label={t("Moved to pi's own MCP support")}>
      <div className="flex items-center gap-2">
        <LuPlug aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />
        <h3 className="text-sm font-medium text-fg">{t("Moved to pi's own MCP support")}</h3>
        <span className="text-xs text-fg-faint">{new Date(report.at).toLocaleDateString()}</span>
        {view.notice && (
          <button type="button" onClick={() => void dismiss()} className={`${ghostCls} ml-auto`}>
            {t("Dismiss")}
          </button>
        )}
      </div>
      <Report report={report} onImported={onImported ?? (() => {})} />
    </section>
  );
}

function Report({ report, onImported }: { report: McpMigrationReport; onImported: () => void }) {
  const off = report.servers.filter((server) => server.state === "off" && server.why.length);
  const renamed = report.servers.filter((server) => server.renamedTo);
  const dropped = report.servers.flatMap((server) => server.notes.filter((note) => /dropped|no counterpart/.test(note)).map((note) => `${server.renamedTo ?? server.name}: ${note}`));
  return (
    <>
      {report.status === "pending" ? (
        <p className="mt-2 text-xs text-warn">
          {t("mcp.json cannot be read: {reason}. Nothing was changed, and the next start tries again once it is fixed.", { reason: report.file.note ?? "" })}
        </p>
      ) : (
        <p className="mt-2 text-xs text-fg-muted">
          {tp(report.servers.length, "{n} server was carried over to pi's keys.", "{n} servers were carried over to pi's keys.")}{" "}
          {t("The file as it was is kept beside it as {name}.", { name: report.file.copy ?? "mcp.json.adapter" })}{" "}
          {report.adapter.removed ? t("The adapter is out of pi's package list; its files stay on disk.") : report.adapter.note ?? ""}
        </p>
      )}
      {off.length > 0 && (
        <Part title={t("Switched off until you have looked at them")}>
          <Lines items={off.map((server) => `${server.renamedTo ?? server.name}: ${server.why.join("; ")}`)} />
        </Part>
      )}
      {renamed.length > 0 && (
        <Part title={t("Renamed: pi's server names have no dots, and - and _ are the same")}>
          <Lines items={renamed.map((server) => `${server.name} → ${server.renamedTo}`)} />
        </Part>
      )}
      {report.untrusted.length > 0 && (
        <Part title={t("No longer trusted, as it was not certain which server they were")}>
          <Lines items={report.untrusted} />
        </Part>
      )}
      {report.unconverted.length > 0 && (
        <Part title={t("Stored switches that could not be carried over")}>
          <Lines items={report.unconverted.map((item) => `${item.where}: ${item.name}: ${item.why}`)} />
        </Part>
      )}
      {dropped.length > 0 && (
        <Part title={t("What the adapter had that pi has no counterpart for")}>
          <Lines items={dropped} />
        </Part>
      )}
      {report.gone.length > 0 && (
        <Part title={t("Left out of the file")}>
          <Lines items={report.gone} />
        </Part>
      )}
      {report.texts.length > 0 && (
        <Part title={t("Texts that still name the old tools (not changed)")}>
          <Lines items={report.texts.map((text) => `${text.where}: ${text.names.join(", ")}`)} />
        </Part>
      )}
      {report.projects.length > 0 && (
        <Part title={t("Folders that bring their own MCP configuration or the adapter (not changed)")}>
          <ul className="mt-1 space-y-1.5 text-xs text-fg-muted">
            {report.projects.map((project) => (
              <ProjectLine key={project.folder} project={project} onImported={onImported} />
            ))}
          </ul>
        </Part>
      )}
    </>
  );
}
