import type { ReactNode } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import type { PortalTool } from "../api";
import { CODEMODE_HELD, MARK_TITLE, displayName, groupSummary, groupTools, markCls, markName, sourceName, toolTitle, type ToolGroup } from "../tool-groups";
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
  onMark,
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
  /** Settings only: mark one tool lazy, or direct, or take the mark away (auto). Without it the label is only shown. */
  onMark?: (tool: PortalTool) => void;
}) {
  const groups = useOpenGroups();
  return (
    <>
      {groupTools(tools).map((group) => {
        const open = groups.isOpen(group.source);
        const editing = naming?.(group);
        // What the group's switch flips: not a tool the chat's mode holds on.
        const free = group.tools.filter((tool) => !tool.byMode);
        const freeOff = free.every((tool) => !tool.enabled);
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
                  {free.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onFlip(free.map((tool) => tool.name), freeOff)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                    >
                      {freeOff ? t("all on") : t("all off")}
                    </button>
                  )}
                </>
              )}
            </div>
            <ul className={open ? (roomy ? "py-1" : "pb-1") : "hidden"}>
              {group.tools.map((tool) => (
                <li key={tool.name}>
                  <label title={toolTitle(tool)} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs transition hover:bg-fg/5">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={busy || tool.byMode}
                      onChange={(e) => onFlip([tool.name], e.target.checked)}
                      className="h-3 w-3 shrink-0 accent-accent"
                    />
                    <span className={`min-w-0 flex-1 truncate font-mono ${tool.enabled ? "text-fg" : "text-fg-faint line-through"}`}>{tool.name}</span>
                    {/* Not in the model's list one by one, but on: it finds the tool through `tool_search`. */}
                    {onMark ? (
                      !tool.noLazy && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={t("Lazy or direct {name}: {mark}", { name: tool.name, mark: markName(tool) })}
                          onClick={(e) => {
                            // The tool sits in a label whose click flips its switch.
                            e.preventDefault();
                            onMark(tool);
                          }}
                          title={t(MARK_TITLE)}
                          className={`shrink-0 rounded border px-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-60 ${markCls(tool)}`}
                        >
                          {markName(tool)}
                        </button>
                      )
                    ) : (
                      tool.lazy && (
                        <span
                          title={t("Not in the model's list one by one: it finds and calls this tool through the `tool_search` tool.")}
                          className="shrink-0 rounded border border-line px-1 text-[10px] text-fg-faint"
                        >
                          {t("lazy")}
                        </span>
                      )
                    )}
                    {/* Only where this chat disagrees with the default, so the
                        setting is findable from the place it is being overruled. */}
                    {tool.defaultOn !== undefined && tool.defaultOn !== tool.enabled && (
                      <span className="shrink-0 text-[10px] text-fg-faint">{tool.defaultOn ? t("default on") : t("default off")}</span>
                    )}
                  </label>
                  {tool.byMode && <p className="px-3 pb-1 pl-8 text-[10px] text-fg-faint">{t(CODEMODE_HELD)}</p>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
