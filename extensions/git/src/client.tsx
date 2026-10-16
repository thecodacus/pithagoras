import { useCallback, type KeyboardEvent } from "react";
import { LuGitBranch } from "react-icons/lu";
import type { PanelHandle, PanelProps, Portal } from "@pithagoras/extension-api";
import { GIT_TABS, GitPanel, type GitTab } from "./panel/GitPanel";
import { latestFileActivity } from "./file-activity";
import { portal, setPortal, t } from "./portal";
import { de } from "./de";
import "./client.css";

/**
 * Git for a chat's folder: what changed and its diffs, staging and committing,
 * the history, branches, pushing and pulling, and pull requests through gh.
 * A panel beside the conversation by the name `git`, its tabs and the count of
 * what changed in its head; what it runs, the server half runs with the
 * portal's own git (`portal.git`).
 */

/** Which tab is shown, and how many files have changed: shared by the panel and its head while it is open. */
type Shown = { tab: GitTab; count: number };
const shownOf = (panel: PanelHandle): Shown => ({ tab: "changes", count: 0, ...(panel.state as Partial<Shown> | undefined) });
const show = (panel: PanelHandle, next: Partial<Shown>) => {
  const was = shownOf(panel);
  if (Object.entries(next).every(([key, value]) => was[key as keyof Shown] === value)) return;
  panel.setState({ ...was, ...next });
};

function Body({ chat, panel }: PanelProps) {
  const { tab } = shownOf(panel);
  // A file the agent read or wrote, and the end of its turn: the panel looks again.
  const { activity, running } = portal.chats.use(chat.id, (feed) => ({ activity: latestFileActivity(feed.events, chat.workspace), running: feed.running }));
  const onTab = useCallback((next: GitTab) => show(panel, { tab: next }), [panel]);
  const onCount = useCallback((n: number) => show(panel, { count: n }), [panel]);
  // In Files beside it: Git, just clicked in, is not the panel closed to make room. Offered only where there is a
  // panel by that name: Files is an extension, and may be switched off or replaced.
  const hasFiles = portal.panels.useHas("files");
  const openInFiles = useCallback((path: string) => panel.open("files", { path }), [panel]);
  const onOpenFile = hasFiles ? openInFiles : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <GitPanel sessionId={chat.id} tab={tab} onTab={onTab} activity={activity} running={running} onOpenFile={onOpenFile} onCount={onCount} />
    </div>
  );
}

/** The tabs, in the panel's head, with how many files have changed beside Changes. */
function Tabs({ panel }: PanelProps) {
  portal.locale.use();
  const { tab, count } = shownOf(panel);
  return (
    <div className="git-tabs" role="tablist" aria-label={t("Git")} onKeyDown={(e: KeyboardEvent<HTMLElement>) => portal.ui.tabKeys(e)}>
      {GIT_TABS.map(({ id, label }) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => show(panel, { tab: id })}>
          {t(label)}
          {id === "changes" && count > 0 && <span className="ml-1 rounded-full bg-fg/10 px-1 text-[10px]">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export default function git(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  portal.slots.register("chat.panel", {
    id: "git",
    name: "git",
    title: "Git",
    icon: LuGitBranch,
    header: Tabs,
    component: Body,
    useButton: () => {
      portal.locale.use();
      return { title: t("What changed, commits, branches and pull requests — for this chat's repository") };
    },
  });
}
