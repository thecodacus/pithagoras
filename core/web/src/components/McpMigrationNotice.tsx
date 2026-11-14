import { LuPlug, LuX } from "react-icons/lu";
import { useMcpMigration } from "../mcp-migration";
import { t } from "../i18n";
import { ghostCls, primarySmCls } from "./SettingsUi";

/**
 * The line at the top of the page that says the MCP servers were moved to pi's own MCP support at the upgrade, until the
 * person has read what it did (Settings → MCP has the report, and keeps it). Nothing on a portal that had nothing to move,
 * and nothing once it is dismissed.
 */
export function McpMigrationNotice({ onReview }: { onReview: () => void }) {
  const { view, dismiss } = useMcpMigration();
  const report = view?.report;
  if (!report || !view.notice) return null;
  const off = report.servers.filter((server) => server.state === "off" && server.why.length).length;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent/10 px-4 py-2 text-sm text-fg">
      <LuPlug aria-hidden className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        {report.status === "pending"
          ? t("The MCP servers were not moved to pi's own MCP support yet: mcp.json cannot be read. Fix it, and the next start moves them.")
          : t("The MCP servers now run on pi's own MCP support: {on} carried over, {off} switched off until you have looked at them.", { on: report.servers.length - off, off })}
      </span>
      <button type="button" onClick={onReview} className={primarySmCls}>{t("Review")}</button>
      <button type="button" onClick={() => void dismiss()} aria-label={t("Dismiss")} title={t("Dismiss")} className={`${ghostCls} shrink-0 !px-1.5`}>
        <LuX aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
