import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  LuGlobe,
  LuBrain,
  LuImages,
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
import { pick, useFlip } from "../motion";
import { HOME, folderKeys, hasMoreThanHome, folderName, folderNameOf, groupByFolder, sortFolders, type Places } from "../session-folders";
import { useFolderPrefs, useOpenFolders } from "../use-session-folders";
import { t, useLanguage } from "../i18n";
import { useSlot } from "../extensions/slots";

/** How many unpinned sessions the sidebar shows before deferring to Sessions. */
const RECENTS_LIMIT = 12;
/** How many of a folder's chats the sidebar shows before deferring to Sessions, opened at that folder. */
const FOLDER_LIMIT = 8;

export const Sidebar = memo(function Sidebar({
  forceExpanded = false,
  sessions,
  executor,
  activeId,
  view,
  hasBrowser,
  hasMemory = false,
  hasMedia = false,
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
  /** Whether the optional browser service is there at all. */
  hasBrowser: boolean;
  /** Understory is the agent's memory: its page is there to read. */
  hasMemory?: boolean;
  /** Image or video generation is on and has an address: the Media page is there to make pictures and videos in and to look through them. */
  hasMedia?: boolean;
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
  const pages = useSlot("nav.page");
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

  // Only worth a field once the list is longer than it shows: below that the
  // chat you want is in front of you, and a search box is one more thing to skip.
  const [query, setQuery] = useState("");
  const searchable = sessions.length > RECENTS_LIMIT;
  // The field goes away when the list shrinks below the limit; what was typed
  // in it must not go on hiding chats from a list that has no box to clear it.
  const searching = searchable && query.trim() !== "";
  // Gathered by folder only where there is more than Home to gather them in.
  const { grouping, sort, order, setGrouping, setSort, move } = useFolderPrefs();
  const hasPlaces = !!places && hasMoreThanHome(places);
  // Until the places are known, the chats are listed as they were: not held back for them.
  const byFolder = grouping === "folders" && hasPlaces;
  // The search goes by what the list shows: the name, and the folder's name where the chats are gathered under it.
  // A pinned chat is listed at the top with no folder next to it, so it is found by its title only.
  const found = useMemo(() => {
    const nameOf = searching && byFolder ? folderNameOf(sessions, places) : undefined;
    return filterSessions(sessions, searching ? query : "", nameOf && ((s) => (s.pinned ? "" : nameOf(s))));
  }, [sessions, searching, query, byFolder, places]);
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
  // The chat opened is in a folder that is open, however it was opened — once
  // for each chat opened and the folder it is in: a folder shut while its chat
  // is open stays shut, and a chat first put in Elsewhere, before its project
  // was known, still has its project opened once it is.
  const activeFolder = useMemo(() => folders.find((f) => listed.get(f.key)!.some((s) => s.id === activeId))?.key, [folders, listed, activeId]);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    const opened = `${activeId}\n${activeFolder}`;
    if (!activeFolder || openedFor.current === opened) return;
    openedFor.current = opened;
    openFolders.set(activeFolder, true);
  }, [activeId, activeFolder]);

  const headingProps = { grouping, sort, onGrouping: setGrouping, onSort: setSort };

  // Rows slide to their new places, and new ones come in (see motion.ts): not
  // while a search is typed, which moves them with every key.
  const rowsOrder = [byFolder ? "folders" : "recents", ...pinned.map((s) => s.id), "|", ...(byFolder ? folders.flatMap((f) => listed.get(f.key)!) : shownRecents).map((s) => s.id)].join();
  const list = useFlip<HTMLDivElement>(rowsOrder, searching);
  // The chat that is picked lights up: when the open chat changes, not each time its row is shown again.
  const opened = useRef(activeId);
  useEffect(() => {
    if (opened.current === activeId) return;
    opened.current = activeId;
    if (activeId) pick(list.current?.querySelector(`[data-flip="${CSS.escape(activeId)}"]`));
  }, [activeId]);

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      session={s}
      active={activeId === s.id}
      onSelect={() => onSelect(s.id)}
      onRename={onRename}
      onDelete={onDelete}
      onPin={onPin}
      onError={setStartError}
    />
  );

  const destinations: { to: Destination; icon: ReactNode; label: string }[] = [
    { to: "sessions", icon: <LuMessagesSquare />, label: t("Sessions") },
    { to: "projects", icon: <LuFolderKanban />, label: t("Projects") },
    { to: "agents", icon: <LuBot />, label: t("Agents") },
    { to: "routines", icon: <LuClock />, label: t("Routines") },
    // Hidden unless there is one. The browser is an optional service, and
    // a dead link to a feature you did not install is just clutter.
    ...(hasBrowser ? [{ to: "browser" as const, icon: <LuGlobe />, label: t("Browser") }] : []),
    // Likewise: only while Understory holds the agent's memory.
    ...(hasMemory ? [{ to: "memory" as const, icon: <LuBrain />, label: t("Memory") }] : []),
    // And only while there is an endpoint to make pictures or videos with.
    ...(hasMedia ? [{ to: "media" as const, icon: <LuImages />, label: t("Media") }] : []),
    { to: "audit", icon: <LuShield />, label: t("Audit") },
    // The pages the installed extensions brought, after the portal's own.
    // An extension's icon is a bare <svg>, sized here as the portal's own icons size themselves: by the text beside them.
    ...pages.map((page) => ({
      to: `x/${page.key}` as const,
      icon: page.icon ? <span className="contents [&>svg]:h-[1em] [&>svg]:w-[1em]"><page.icon /></span> : <LuPuzzle />,
      label: page.title,
    })),
  ];
  const anyRunning = sessions.some((s) => s.status === "running");

  return (
    <aside aria-label={t("Sidebar")} className={`relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-300 ease-in-out motion-reduce:transition-none ${collapsed ? "w-12" : "w-64"}`}>
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
              onMove={searching || !allKeys ? undefined : (shown, key, to) => move(shown, key, to, allKeys)}
              onNewChat={(f) => newChat(f.path || undefined)}
            >
              {(f) => {
                const chats = listed.get(f.key)!;
                const first = searching ? chats : chats.slice(0, FOLDER_LIMIT);
                // The chat that is open is listed, however far down its folder it is.
                const open = first.some((s) => s.id === activeId) ? null : chats.find((s) => s.id === activeId);
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
type Destination = "sessions" | "projects" | "agents" | "routines" | "browser" | "memory" | "media" | "audit" | `x/${string}`;

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
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  /** The one that starts a chat: its plus turns. */
  isNew?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      data-new={isNew || undefined}
      className={`nav-item group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        active ? "bg-fg/[0.07] text-fg" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
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
    </button>
  );
}

function SessionItem({
  session: s,
  active,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onError,
}: {
  session: Session;
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
        <StatusDot status={s.status} />
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
            className={`truncate text-sm text-fg ${workingText(s.status)}`}
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
          <SessionActions session={s} small onPin={onPin} onStartRename={() => setRenaming(true)} onDelete={onDelete} onError={onError} />
        </div>
      </div>
    </div>
  );
}
