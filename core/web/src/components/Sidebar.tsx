import { Fragment, memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SessionActions, sessionError } from "./SessionActions";
import { TitleInput } from "./TitleInput";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { StatusDot, workingText } from "./StatusDot";
import { ChatsHeading, FolderTree } from "./FolderTree";
import {
  LuBot,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuClock,
  LuFolderKanban,
  LuChevronRight,
  LuMessagesSquare,
  LuPlus,
  LuPuzzle,
  LuSearch,
  LuSettings,
  LuShield,
} from "react-icons/lu";
import type { Session } from "../api";
import { local } from "../safe-storage";
import { filterSessions } from "../session-filter";
import { isEscape } from "../shortcuts";
import { pick, useFlip, useLeaveRef } from "../motion";
import { useDismiss } from "../use-dismiss";
import { HOME, folderKeys, hasMoreThanHome, folderName, folderNameOf, groupByFolder, sortFolders, type Places } from "../session-folders";
import { useFolderPrefs, useOpenFolders } from "../use-session-folders";
import { t, useLanguage } from "../i18n";
import { titleOf, useSlot, type Registered } from "../extensions/slots";
import { failedIn } from "../extensions/loader";
import { ErrorBoundary } from "./ErrorBoundary";
import { SubChats } from "./SubChats";
import { familiesFound, familyRunning, searchFolderOf, shownStatus, splitSubChats, topOf, type ShownStatus } from "../sub-chats";

/** How many unpinned sessions the sidebar shows before deferring to Sessions. A chat's sub-chats come with it, uncounted. */
const RECENTS_LIMIT = 12;
/** How many of a folder's chats the sidebar shows before deferring to Sessions, opened at that folder. */
const FOLDER_LIMIT = 8;

/**
 * Asks an extension's page whether its entry is listed now (`useShown`), and
 * says so each time that changes. Drawn on its own, so that each page's hook is
 * called the same way however many pages there are.
 */
function PageShown({ entry, onChange }: { entry: Registered<"nav.page">; onChange: (shown: boolean) => void }) {
  const shown = entry.useShown!() === true;
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => change.current(shown), [shown]);
  return null;
}

export const Sidebar = memo(function Sidebar({
  forceExpanded = false,
  sessions,
  executor,
  activeId,
  view,
  places,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  onPin,
  onOpenSettings,
  onNavigate,
  onOpenFolder,
}: {
  forceExpanded?: boolean;
  sessions: Session[];
  executor: string;
  activeId: string | null;
  /** Which top-level destination is showing, so the nav can mark it. */
  view: "chat" | Destination;
  /** Where Home and the projects are, to list the chats by folder: undefined until known, null if they could not be. */
  places?: Places | null;
  onSelect: (id: string) => void;
  /** A chat in `workspace`, or where New starts without one, opened. */
  onNewChat: (workspace?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onOpenSettings: () => void;
  onNavigate: (to: Destination) => void;
  /** The Sessions page, showing only the chats in the folder `key` (see session-folders). */
  onOpenFolder: (key: string) => void;
}) {
  // Not drawn again with every token of a chat, so the language is asked for here.
  useLanguage();
  const entries = useSlot("nav.page");
  // The pages that ask whether they are listed, by their entry's key: those that said yes last.
  const [shownPages, setShownPages] = useState<readonly string[]>([]);
  const pages = entries.filter((page) => !page.useShown || shownPages.includes(page.key));
  const [storedCollapsed, setCollapsed] = useState(() => local.get("sidebarCollapsed") === "true");
  const collapsed = forceExpanded ? false : storedCollapsed;
  const toggleSidebar = () => {
    setCollapsed(value => {
      local.set("sidebarCollapsed", String(!value));
      return !value;
    });
  };
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const newChat = async (workspace?: string) => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await onNewChat(workspace);
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  // Sub-chats are listed under their chat, and counted nowhere on their own (see sub-chats.ts).
  const all = useMemo(() => splitSubChats(sessions), [sessions]);
  // Only worth a field once the list is longer than it shows: below that the
  // chat you want is in front of you, and a search box is one more thing to skip.
  const [query, setQuery] = useState("");
  const searchable = all.top.length > RECENTS_LIMIT;
  // The field goes away when the list shrinks below the limit; what was typed
  // in it must not go on hiding chats from a list that has no box to clear it.
  const searching = searchable && query.trim() !== "";
  // Gathered by folder only where there is more than Home to gather them in.
  const { grouping, sort, order, setGrouping, setSort, move } = useFolderPrefs();
  const hasPlaces = !!places && hasMoreThanHome(places);
  // Until the places are known, the chats are listed as they were: not held back for them.
  const byFolder = grouping === "folders" && hasPlaces;
  // The search goes by what the list shows: the name, and the folder's name where the chats are gathered under it.
  // A pinned chat is listed at the top with no folder next to it, so it is found by its title only, and so are its
  // sub-chats. A sub-chat that is found is shown under its chat (`under`).
  const { top: found, under } = useMemo(() => {
    if (!searching) return all;
    const nameOf = byFolder ? folderNameOf(sessions, places) : undefined;
    return familiesFound(all, filterSessions(sessions, query, nameOf && searchFolderOf(sessions, nameOf)));
  }, [all, sessions, searching, query, byFolder, places]);
  const pinned = found.filter((s) => s.pinned);
  const recents = found.filter((s) => !s.pinned);
  // A search looks through all of them, not only the dozen that are listed.
  const shownRecents = searching ? recents : recents.slice(0, RECENTS_LIMIT);

  // Each folder is counted, marked running and ordered by all its chats, as
  // on the Sessions page, so that the two agree; pinned ones are listed at the
  // top rather than in it (`listed`).
  const { folders, listed } = useMemo(() => {
    const all = byFolder && places ? sortFolders(groupByFolder(found, places), sort, order) : [];
    const listed = new Map(all.map((f) => [f.key, f.sessions.filter((s) => !s.pinned)]));
    return {
      // Elsewhere is only there for chats to show in it; searching, only the folders with a match are.
      folders: all.filter((f) => (f.kind !== "elsewhere" && !searching) || listed.get(f.key)!.length > 0),
      listed,
    };
  }, [byFolder, found, places, sort, order, searching]);
  /** Every folder there can be, for what is kept about them: see folderKeys. */
  const allKeys = useMemo(() => (places ? folderKeys(places) : undefined), [places]);
  const openFolders = useOpenFolders("sidebarFoldersOpen", (key) => key === HOME, searching, allKeys);
  /** The chat listed on its own that the open chat is, or is a sub-chat of. */
  const activeTop = useMemo(() => topOf({ top: found, under }, activeId)?.id, [found, under, activeId]);
  // The chat opened is in a folder that is open, however it was opened — once
  // for each chat opened and the folder it is in: a folder shut while its chat
  // is open stays shut, and a chat first put in Elsewhere, before its project
  // was known, still has its project opened once it is.
  const activeFolder = useMemo(() => folders.find((f) => listed.get(f.key)!.some((s) => s.id === activeTop))?.key, [folders, listed, activeTop]);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    const opened = `${activeId}\n${activeFolder}`;
    if (!activeFolder || openedFor.current === opened) return;
    openedFor.current = opened;
    openFolders.set(activeFolder, true);
  }, [activeId, activeFolder]);
  // A chat's sub-chats are shut until opened, and open while one of them works or waits for you; the one opened is
  // shown the way its folder is, once for each time it is opened.
  const parents = useMemo(() => [...all.under.keys()], [all]);
  const openSubs = useOpenFolders(
    "sidebarSubChatsOpen",
    (id) => (all.under.get(id) ?? []).some((c) => c.status === "running" || c.asking),
    searching,
    parents,
  );
  // The chat whose sub-chat is open, where it is listed with its sub-chats under it.
  const activeParent = sessions.find((s) => s.id === activeId)?.parent;
  const openedUnder = activeParent && all.under.has(activeParent) ? activeParent : null;
  useEffect(() => {
    if (openedUnder) openSubs.set(openedUnder, true);
  }, [activeId, openedUnder]);
  /** The sub-chats shown under a chat's row: none while they are shut. */
  const subsShown = (id: string) => (openSubs.isOpen(id) ? (under.get(id) ?? []) : []);

  const headingProps = { grouping, sort, onGrouping: setGrouping, onSort: setSort };

  // Rows slide to their new places, and new ones come in (see motion.ts): not
  // while a search is typed, which moves them with every key.
  // A chat's sub-chats are rows of their own once shown, after it.
  const rowsOrder = [byFolder ? "folders" : "recents", ...pinned, "|", ...(byFolder ? folders.flatMap((f) => listed.get(f.key)!) : shownRecents)]
    .flatMap((s) => (typeof s === "string" ? [s] : [s.id, ...subsShown(s.id).map((c) => c.id)]))
    .join();
  const list = useFlip<HTMLDivElement>(rowsOrder, searching);
  // The chat that is picked lights up: when the open chat changes, not each time its row is shown again.
  const opened = useRef(activeId);
  useEffect(() => {
    if (opened.current === activeId) return;
    opened.current = activeId;
    if (activeId) pick(list.current?.querySelector(`[data-flip="${CSS.escape(activeId)}"]`));
  }, [activeId]);

  const row = (s: Session, status: ShownStatus, subChats?: readonly Session[], nested = false) => (
    <SessionItem
      key={s.id}
      session={s}
      status={status}
      subChats={subChats}
      nested={nested}
      active={activeId === s.id}
      onSelect={() => onSelect(s.id)}
      onRename={onRename}
      onDelete={onDelete}
      onPin={onPin}
      onError={setStartError}
    />
  );
  /** A chat's row, and its sub-chats under it. */
  const item = (s: Session) => {
    const subs = all.under.get(s.id);
    return (
      <Fragment key={s.id}>
        {row(s, shownStatus(s, subs), subs)}
        <SubChats title={s.title} subs={under.get(s.id) ?? []} open={openSubs.isOpen(s.id)} onToggle={() => openSubs.toggle(s.id)}>
          {(c) => row(c, shownStatus(c), undefined, true)}
        </SubChats>
      </Fragment>
    );
  };

  const destinations: { to: Destination; icon: ReactNode; label: string }[] = [
    { to: "sessions", icon: <LuMessagesSquare />, label: t("Sessions") },
    { to: "projects", icon: <LuFolderKanban />, label: t("Projects") },
    { to: "agents", icon: <LuBot />, label: t("Agents") },
    { to: "routines", icon: <LuClock />, label: t("Routines") },
  ];
  // Last of the destinations, after the extensions' group.
  const audit = { to: "audit" as const, icon: <LuShield />, label: t("Audit") };
  // The pages the installed extensions brought are kept apart from the portal's own: one group, so that
  // many extensions do not fill the sidebar.
  // An extension's icon is a bare <svg>, sized here as the portal's own icons size themselves: by the text beside them.
  const extensionPages: { to: Destination; icon: ReactNode; label: string }[] = pages.map((page) => ({
    to: `x/${page.key}` as const,
    icon: page.icon ? <span className="contents [&>svg]:h-[1em] [&>svg]:w-[1em]"><page.icon /></span> : <LuPuzzle />,
    label: titleOf(page),
  }));
  const extensionCurrent = extensionPages.some((d) => d.to === view);
  const anyRunning = sessions.some((s) => s.status === "running");

  return (
    <aside aria-label={t("Sidebar")} className={`relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-300 ease-in-out motion-reduce:transition-none ${collapsed ? "w-12" : "w-64"}`}>
      {/* One that fails to answer is not listed: its page is at its address all the same. */}
      {entries.filter((page) => page.useShown).map((page) => (
        <ErrorBoundary key={page.key} resetKey={page.key} fallback={() => null} onError={failedIn(page.extension)}>
          <PageShown entry={page} onChange={(shown) => setShownPages((keys) => (shown ? (keys.includes(page.key) ? keys : [...keys, page.key]) : keys.filter((key) => key !== page.key)))} />
        </ErrorBoundary>
      ))}
      <button type="button" onClick={toggleSidebar} aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
        title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")} aria-expanded={!collapsed} aria-controls="sidebar-content"
        className="hidden md:grid absolute right-2 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-canvas hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        {collapsed ? <LuPanelLeftOpen size={18} /> : <LuPanelLeftClose size={18} />}
      </button>
      {/* Folded, the places are still one click away: a rail of their icons. */}
      {collapsed && (
        <nav className="sidebar-rail max-md:hidden" aria-label={t("Destinations")}>
          <RailButton icon={<LuPlus />} label={t("New chat")} onClick={() => newChat()} />
          <hr />
          {destinations.map((d) => (
            <RailButton key={d.to} icon={d.icon} label={d.label} onClick={() => onNavigate(d.to)} current={view === d.to}>
              {d.to === "sessions" && anyRunning && <StatusDot status="running" bare />}
            </RailButton>
          ))}
          {extensionPages.length > 0 && <RailMenu icon={<LuPuzzle />} label={t("Extensions")} items={extensionPages} current={extensionCurrent ? view : null} onPick={onNavigate} />}
          <RailButton icon={audit.icon} label={audit.label} onClick={() => onNavigate(audit.to)} current={view === audit.to} />
          <div className="mt-auto" />
          <RailButton icon={<LuSettings />} label={t("Settings")} onClick={onOpenSettings} />
        </nav>
      )}
      <div id="sidebar-content" className={`sidebar-content min-h-0 w-64 flex-1 flex-col ${collapsed ? "hidden" : "flex"}`}>

      <div className="flex items-center gap-2 pl-3 pr-12 pb-3 pt-4">
        <img
          src="/icon-192.png"
          alt=""
          className="h-6 w-6 shrink-0 object-contain p-[5px]"
          draggable={false}
        />
        <h1 className="text-sm font-semibold tracking-tight text-fg">Pithagoras</h1>
        <span
          className="ml-auto text-[10px] uppercase tracking-wider text-fg-faint"
          title={t("How sessions are executed")}
        >
          {executor}
        </span>
      </div>

      {/* Destinations, above the session lists. */}
      <nav className="px-2 pb-2" aria-label={t("Destinations")}>
        <NavItem icon={<LuPlus />} label={t("New")} onClick={() => newChat()} active={starting} isNew />
        {destinations.map((d) => (
          <NavItem key={d.to} icon={d.icon} label={d.label} onClick={() => onNavigate(d.to)} active={view === d.to} />
        ))}
        {extensionPages.length > 0 && <ExtensionsGroup pages={extensionPages} view={view} onNavigate={onNavigate} />}
        <NavItem icon={audit.icon} label={audit.label} onClick={() => onNavigate(audit.to)} active={view === audit.to} />

        {startError && <p role="alert" className="px-2.5 pt-1 text-xs text-danger">{startError}</p>}
      </nav>

      {searchable && (
        <div className="relative px-2 pb-1">
          <LuSearch aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => isEscape(e) && setQuery("")}
            placeholder={t("Search chats…")}
            aria-label={t("Search chats")}
            className="w-full rounded-lg border border-line bg-raised/60 py-1.5 pl-8 pr-2 text-xs outline-none placeholder:text-fg-faint focus:border-accent/60"
          />
        </div>
      )}

      <div ref={list} className="sidebar-list flex-1 overflow-y-auto px-2 pb-2">
        {/* By folder, each says so itself, and a chat can be started in it. */}
        {sessions.length === 0 && !byFolder && (
          <p className="px-2 py-4 text-xs text-fg-subtle">{t("No sessions yet.")}</p>
        )}
        {sessions.length > 0 && found.length === 0 && (
          <p className="px-2 py-4 text-xs text-fg-subtle">{t("Nothing matches “{query}”.", { query: query.trim() })}</p>
        )}

        {pinned.length > 0 && (
          <>
            <Divider />
            <GroupLabel>{t("Pinned")}</GroupLabel>
            {pinned.map(item)}
          </>
        )}

        {byFolder && folders.length > 0 && (
          <>
            <Divider />
            <ChatsHeading label={t("Folders")} {...headingProps} />
            <FolderTree
              folders={folders}
              isOpen={openFolders.isOpen}
              onToggle={openFolders.toggle}
              running={(s) => familyRunning(s, all.under.get(s.id))}
              onMove={searching || !allKeys ? undefined : (shown, key, to) => move(shown, key, to, allKeys)}
              onNewChat={(f) => newChat(f.path || undefined)}
            >
              {(f) => {
                const chats = listed.get(f.key)!;
                const first = searching ? chats : chats.slice(0, FOLDER_LIMIT);
                // The chat that is open is listed, however far down its folder it is: or the chat it is a sub-chat of.
                const open = first.some((s) => s.id === activeTop) ? null : chats.find((s) => s.id === activeTop);
                const shown = open ? [...first, open] : first;
                return (
                  <>
                    {chats.length === 0 && (
                      <p className="px-2.5 py-1 text-xs text-fg-faint">{f.sessions.length ? t("Only pinned chats, above.") : t("No chats yet.")}</p>
                    )}
                    {shown.map(item)}
                    {chats.length > shown.length && (
                      <button
                        onClick={() => onOpenFolder(f.key)}
                        className="mb-1 w-full rounded-lg px-2.5 py-1 text-left text-xs text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
                      >
                        {t("{n} more in {name}…", { n: chats.length - shown.length, name: folderName(f) })}
                      </button>
                    )}
                  </>
                );
              }}
            </FolderTree>
          </>
        )}

        {!byFolder && shownRecents.length > 0 && (
          <>
            <Divider />
            <ChatsHeading label={t("Recents")} controls={hasPlaces} {...headingProps} />
            {shownRecents.map(item)}
            {recents.length > shownRecents.length && (
              <button
                onClick={() => onNavigate("sessions")}
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
              >
                {t("{n} more…", { n: recents.length - shownRecents.length })}
              </button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-line p-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <NavItem
              icon={<LuSettings />}
              label={t("Settings")}
              onClick={onOpenSettings}
              active={false}
            />
          </div>
          <ThemeSwitcher />
        </div>
      </div>
      </div>
    </aside>
  );
});

const Divider = () => <div className="my-2 h-px bg-line" />;

const GroupLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
    {children}
  </p>
);

/** A page of the portal's, or one an extension brought: `x/<extension>/<page id>`. */
type Destination = "sessions" | "projects" | "agents" | "routines" | "audit" | `x/${string}`;

function RailButton({
  icon,
  label,
  onClick,
  current,
  children,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  current?: boolean;
  children?: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-current={current ? "page" : undefined} className="sidebar-rail-button">
      {icon}
      {children}
    </button>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  isNew,
  fold,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  /** The one that starts a chat: its plus turns. */
  isNew?: boolean;
  /** For the one that opens and shuts a group: whether it is open, and what it opens. */
  fold?: { open: boolean; controls: string; held: boolean };
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-expanded={fold?.open}
      aria-controls={fold?.controls}
      aria-disabled={fold?.held || undefined}
      title={fold?.held ? t("Open while one of its pages is showing") : undefined}
      data-new={isNew || undefined}
      // Held open, it does nothing when pressed, and does not look as if it did.
      className={`nav-item group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        active ? "bg-fg/[0.07] text-fg" : fold?.held ? "cursor-default text-fg-muted" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
      }`}
    >
      <span
        className={`nav-bar absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-accent transition-opacity ${
          active ? "is-on opacity-100" : "opacity-0"
        }`}
      />
      <span className={`nav-icon shrink-0 transition-colors ${active ? "text-accent" : "text-fg-faint group-hover:text-fg-subtle"}`}>
        {icon}
      </span>
      {label}
      {fold && <LuChevronRight aria-hidden className={`ml-auto h-3 w-3 shrink-0 text-fg-faint transition-transform motion-reduce:transition-none ${fold.open ? "rotate-90" : ""} ${fold.held ? "opacity-40" : ""}`} />}
    </button>
  );
}

/**
 * The pages the extensions brought, folded under one line like a folder.
 * Open or shut as it was left in this browser; held open while one of its
 * pages is showing, so that the page marked as the current one is in view.
 */
function ExtensionsGroup({ pages, view, onNavigate }: { pages: { to: Destination; icon: ReactNode; label: string }[]; view: string; onNavigate: (to: Destination) => void }) {
  // Open until it is shut by hand: a portal with one extension does not hide its page behind a fold nobody has met.
  const [chosen, setChosen] = useState(() => local.get("sidebarExtensionsOpen") !== "false");
  const held = pages.some((d) => d.to === view);
  const open = chosen || held;
  const body = useId();
  return (
    <>
      <NavItem
        icon={<LuPuzzle />}
        label={t("Extensions")}
        active={false}
        fold={{ open, controls: body, held }}
        onClick={() => {
          // A click that shut nothing, with its page in view, would still be remembered as shut.
          if (held) return;
          local.set("sidebarExtensionsOpen", String(!chosen));
          setChosen(!chosen);
        }}
      />
      <div id={body} role="group" aria-label={t("Extensions")} hidden={!open} className="pl-3">
        {pages.map((d) => (
          <NavItem key={d.to} icon={d.icon} label={d.label} onClick={() => onNavigate(d.to)} active={view === d.to} />
        ))}
      </div>
    </>
  );
}

/**
 * A button on the rail that opens a menu beside it, for what does not fit on
 * the rail as one button each: arrows move through it, Enter picks, Escape
 * shuts it and gives the focus back to the button. Drawn at the body, as the
 * Select's list is, because the sidebar clips what leaves it.
 */
function RailMenu({
  icon,
  label,
  items,
  current,
  onPick,
}: {
  icon: ReactNode;
  label: string;
  items: { to: Destination; icon: ReactNode; label: string }[];
  /** Which of the items is showing, if any: the button is marked for it. */
  current: string | null;
  onPick: (to: Destination) => void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuRef = useLeaveRef<HTMLDivElement>("menu", menu);
  const menuId = useId();
  useDismiss(open, [menu, button], () => setOpen(false), button);

  const show = () => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    // Beside the button, level with it, and hung from its bottom edge instead where the window ends too soon below.
    const below = window.innerHeight - b.top - 8;
    const flip = below < 220 && b.bottom > below;
    setPlace({ left: b.right + 8, ...(flip ? { bottom: window.innerHeight - b.bottom } : { top: b.top }), maxHeight: Math.max(120, flip ? b.bottom - 8 : below) });
    setOpen(true);
  };
  /** Which entry had the focus last: where it goes if that entry is unlisted. */
  const lastAt = useRef(0);
  const entries = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  // The page showing is where the arrows start, if it is one of these.
  useEffect(() => {
    if (!open) return;
    const at = Math.max(0, items.findIndex((d) => d.to === current));
    entries()[at]?.focus();
  }, [open]);
  // An entry unlisted under the focus takes it along to body, where the arrows are not heard: it goes to the one
  // now in its place, or to the button if none is left.
  const listed = items.map((d) => d.to).join("\n");
  useEffect(() => {
    if (!open || menu.current?.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const all = entries();
    if (all.length) all[Math.min(lastAt.current, all.length - 1)].focus();
    else {
      setOpen(false);
      button.current?.focus();
    }
  }, [listed]);

  const onMenuKey = (e: KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    // Away from the menu with the keys is away from it, and on from where the button is, not from the end of the page
    // the menu is drawn at: the focus goes to the button before the Tab is carried out.
    else if (e.key === "Tab") {
      button.current?.focus();
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-current={current ? "page" : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        className="sidebar-rail-button"
      >
        {icon}
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            onFocus={(e) => (lastAt.current = Math.max(0, entries().indexOf(e.target as HTMLElement)))}
            className={`ui-select-list ${place.bottom !== undefined ? "is-above" : ""}`}
            style={{ left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight, minWidth: 180 }}
          >
            {items.map((d) => (
              <button
                key={d.to}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-current={d.to === current ? "page" : undefined}
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                  onPick(d.to);
                }}
                className="ui-select-option w-full text-left hover:bg-fg/5 hover:text-fg focus:bg-fg/[0.07] focus:text-fg"
              >
                <span className={`shrink-0 ${d.to === current ? "text-accent" : "text-fg-faint"}`}>{d.icon}</span>
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function SessionItem({
  session: s,
  status,
  subChats,
  nested,
  active,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onError,
}: {
  session: Session;
  /** How it shows, with its sub-chats: see shownStatus. */
  status: ShownStatus;
  /** Its sub-chats, which a delete names. */
  subChats?: readonly Session[];
  /** It is shown under its chat. */
  nested: boolean;
  active: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    // A row with buttons in it, so not a button itself: reachable with Tab and
    // opened with Enter all the same, which a bare div with a click was not.
    <div
      data-flip={s.id}
      onClick={onSelect}
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || renaming) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`session-row group mb-0.5 cursor-pointer rounded-lg px-2.5 py-1.5 transition focus-visible:outline-offset-0 ${
        active ? "bg-fg/[0.07]" : "hover:bg-fg/5"
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        {renaming ? (
          <TitleInput
            value={s.title}
            label={t("Session name")}
            className="flex-1 text-sm"
            onCommit={(next) => {
              setRenaming(false);
              onError(null);
              onRename(s.id, next).catch((e) => onError(sessionError("rename", s.title, e)));
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className={`truncate text-sm text-fg ${workingText(status)}`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
            }}
          >
            {s.title}
          </span>
        )}

        {/* Without a mouse there is no hover: the open chat's row keeps them. */}
        <div className={`ml-auto hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex ${active ? "[@media(hover:none)]:flex" : ""}`}>
          <SessionActions session={s} subChats={subChats} nested={nested} small onPin={onPin} onStartRename={() => setRenaming(true)} onDelete={onDelete} onError={onError} />
        </div>
      </div>
    </div>
  );
}
