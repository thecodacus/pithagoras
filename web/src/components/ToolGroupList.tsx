import type { ReactNode } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import type { PortalTool } from "../api";
import { displayName, groupSummary, groupTools, sourceName, type ToolGroup } from "../tool-groups";
import { useOpenGroups } from "../use-open-groups";
import { t } from "../i18n";

/**
 * The tools grouped by what brought them, each with a switch, and a switch for the whole group.
 *
 * What the chat's popover, a project and Settings → Tools all draw: what a switch does is the caller's (`onFlip`),
 * and so are the things only one of them has, the group renaming of Settings (`naming`, `beside`).
 */
export function ToolGroupList({
  tools,
  names,
  busy,
  onFlip,
  roomy,
  naming,
  beside,
}: {
  tools: PortalTool[];
  /** The names given to groups, which stand in for what installed them. */
  names: Record<string, string>;
  busy: boolean;
  onFlip: (names: string[], enabled: boolean) => void;
  /** The page's own size, with a tinted header on each group, rather than a popover's. */
  roomy?: boolean;
  /** What a group's header holds in place of its name and the switch for all of it, while it is being named. */
  naming?: (group: ToolGroup) => ReactNode;
  /** What goes after the name of a group, before the switch for all of it. */
  beside?: (group: ToolGroup) => ReactNode;
}) {
  const groups = useOpenGroups();
  return (
    <>
      {groupTools(tools).map((group) => {
        const open = groups.isOpen(group.source);
        const editing = naming?.(group);
        return (
          <div key={group.source} className={`border-b last:border-0 ${roomy ? "border-line" : "border-line/60"}`}>
            <div className={`flex items-center gap-1 px-1.5 py-1.5 ${roomy ? "bg-raised/40" : ""}`}>
              {editing ?? (
                <>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => groups.toggle(group.source)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition hover:bg-fg/5"
                  >
                    {open ? (
                      <LuChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
                    ) : (
                      <LuChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
                    )}
                    <span title={sourceName(group.source)} className={`min-w-0 flex-1 truncate font-medium text-fg-muted ${roomy ? "text-xs" : "text-[11px]"}`}>
                      {displayName(group.source, names)}
                    </span>
                    <span className={`shrink-0 text-fg-faint ${roomy ? "text-[11px]" : "text-[10px]"}`}>{groupSummary(group)}</span>
                  </button>
                  {beside?.(group)}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onFlip(group.tools.map((tool) => tool.name), group.allOff)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                  >
                    {group.allOff ? t("all on") : t("all off")}
                  </button>
                </>
              )}
            </div>
            <ul className={open ? (roomy ? "py-1" : "pb-1") : "hidden"}>
              {group.tools.map((tool) => (
                <li key={tool.name}>
                  <label title={tool.description} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs transition hover:bg-fg/5">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={busy}
                      onChange={(e) => onFlip([tool.name], e.target.checked)}
                      className="h-3 w-3 shrink-0 accent-accent"
                    />
                    <span className={`min-w-0 flex-1 truncate font-mono ${tool.enabled ? "text-fg" : "text-fg-faint line-through"}`}>{tool.name}</span>
                    {/* What is listed is what the server had when it last ran, not what it has now. */}
                    {tool.cached && (
                      <span
                        title={t("Listed from the MCP adapter's cache: the server starts when one of its tools is first used.")}
                        className="shrink-0 rounded border border-line px-1 text-[10px] text-fg-faint"
                      >
                        {t("cached")}
                      </span>
                    )}
                    {/* Only where this chat disagrees with the default, so the
                        setting is findable from the place it is being overruled. */}
                    {tool.defaultOn !== undefined && tool.defaultOn !== tool.enabled && (
                      <span className="shrink-0 text-[10px] text-fg-faint">{tool.defaultOn ? t("default on") : t("default off")}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
