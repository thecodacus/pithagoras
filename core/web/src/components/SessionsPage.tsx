import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuFilter, LuMessagesSquare, LuPin, LuSearch, LuX } from "react-icons/lu";
import { PageHeader, Stat } from "./PageHeader";
import type { Session } from "../api";
import { when } from "../time";
import { filterSessions } from "../session-filter";
import { SessionActions, sessionError } from "./SessionActions";
import { ErrorBanner } from "./SettingsUi";
import { StatusDot, workingText } from "./StatusDot";
import { TitleInput } from "./TitleInput";
import { ChatsHeading, FolderTree } from "./FolderTree";
import { RowsSkeleton } from "./Skeleton";
import { folderFrom, folderKeys, hasMoreThanHome, folderName, folderNameOf, groupByFolder, sortFolders, type Places } from "../session-folders";
import { useFolderPrefs, useOpenFolders } from "../use-session-folders";
import { useFlip } from "../motion";
import { useNow } from "../use-now";
import { t, useLanguage } from "../i18n";
import { SubChats } from "./SubChats";
import { familiesFound, familyRunning, shownStatus, splitSubChats, type ShownStatus } from "../sub-chats";

/**
 * How long a click on a name waits for a second one. The chat opens on a click
 * and this page goes with it, so a double-click to rename would never arrive.
 */
const DOUBLE_CLICK_MS = 300;

/**
 * Every session, not just the dozen the sidebar has room for — with search,
 * since the sidebar list is capped and old sessions otherwise become
 * unreachable once they fall off the end. Gathered by folder as the sidebar
 * has them, or as one list; `?folder=` shows only one folder's. A chat's
 * sub-chats are under it, as in the sidebar, and counted nowhere on their own.
 */
export const SessionsPage = memo(function SessionsPage({
  sessions,
  places,
  onSelect,
  onNewChat,
  onDelete,
  onPin,
  onRename,
}: {
  sessions: Session[];
  /** Where Home and the projects are, to list the chats by folder: undefined until known, null if they could not be. */
  places?: Places | null;
  onSelect: (id: string) => void;
  /** A chat in `workspace`, or where New starts without one, opened. */
  onNewChat?: (workspace?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
}) {
  useLanguage();
  // How long ago each chat changed is told in minutes, from the clock when it is drawn: and a list that has not changed is not drawn again.
  useNow(true, 60_000);
  const [query, setQuery] = useState("");
  /** The session whose name is being edited in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** A new name on its way to the server, shown until the list has it. `n` tells one rename from the next. */
  const [pending, setPending] = useState<{ id: string; title: string; n: number } | null>(null);
  const renames = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /** The chat a click on its name opens, unless a second click makes it a rename. */
  const opening = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(opening.current), []);
  /**
   * The press that ends a rename, by leaving the field for the rest of its row.
   * The field closes on the press, before the click, so by the click the row
   * no longer looks as if it were being renamed; it is told here instead.
   */
  const endingRename = useRef(false);

  const rename = (s: Session, title: string) => {
    setRenaming(null);
    const n = ++renames.current;
    setPending({ id: s.id, title, n });
    setError(null);
    onRename(s.id, title)
      .catch((e) => setError(sessionError("rename", s.title, e)))
      // Only its own: a later rename's name stays until that one is done.
      .finally(() => setPending((p) => (p?.n === n ? null : p)));
  };

  // The chats listed on their own, and the sub-chats under each (see sub-chats.ts): only the first are counted.
  const all = useMemo(() => splitSubChats(sessions), [sessions]);
  // A chat runs also while one of its sub-chats works.
  const running = all.top.filter((s) => familyRunning(s, all.under.get(s.id))).length;
  const pinnedCount = all.top.filter((s) => s.pinned).length;

  // Each row names its folder (not the path it works in), and the search goes by that name. A sub-chat that is
  // found is shown under its chat (`under`).
  const folderOf = useMemo(() => folderNameOf(sessions, places), [sessions, places]);
  const { top: matches, under } = useMemo(
    () => (query.trim() ? familiesFound(all, filterSessions(sessions, query, folderOf)) : all),
    [all, sessions, query, folderOf],
  );

  const { grouping, sort, order, setGrouping, setSort, move } = useFolderPrefs();
  const hasPlaces = !!places && hasMoreThanHome(places);
  const folders = useMemo(() => (places ? sortFolders(groupByFolder(matches, places), sort, order) : []), [matches, places, sort, order]);
  const [params, setParams] = useSearchParams();
  /** The one folder shown, with all its chats, when a link or its filter asked for it. */
  const asked = params.get("folder");
  const only = useMemo(
    // Elsewhere too while it is empty: a link to it is to a folder that is there, with nothing in it now.
    () => (places && asked ? folderFrom(groupByFolder(all.top, places, { elsewhere: true }), asked) : null),
    [all, places, asked],
  );
  /** A folder asked for by a link that is not there — a project deleted since — or cannot be told yet. */
  const gone = asked !== null && !only && places !== undefined;
  const waiting = asked !== null && places === undefined;
  const showOnly = (key: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key) next.set("folder", key);
      else next.delete("folder");
      return next;
    });
  const searching = query.trim() !== "";
  const byFolder = asked === null && grouping === "folders" && hasPlaces;
  // Every folder, not only those a search shows: what is kept for one hidden by it must not be let go.
  const allKeys = useMemo(() => (places ? folderKeys(places) : undefined), [places]);
  const openFolders = useOpenFolders("sessionsFoldersOpen", () => true, searching, allKeys);
  // A chat's sub-chats are shut until opened, and open while one of them works or waits for you, as in the sidebar.
  const parents = useMemo(() => [...all.under.keys()], [all]);
  const openSubs = useOpenFolders("sessionsSubChatsOpen", (id) => (all.under.get(id) ?? []).some((c) => c.status === "running" || c.asking), searching, parents);
  /** The sub-chats shown under a chat's row: none while they are shut. */
  const subsShown = (id: string) => (openSubs.isOpen(id) ? (under.get(id) ?? []) : []);
  // A folder asked for shows only its chats — none while it cannot be told which they are.
  const onlyFound = useMemo(() => {
    const ids = new Set(only?.sessions.map((s) => s.id));
    return matches.filter((s) => ids.has(s.id));
  }, [only, matches]);
  const shown = only ? onlyFound : asked !== null ? [] : matches;
  // Rows slide to their new places (see motion.ts); a new one comes in with the list's own stagger. A chat's
  // sub-chats are rows of their own once shown, after it.
  const rowsOrder = [byFolder ? "folders" : "list", ...(byFolder ? folders.flatMap((f) => f.sessions) : shown).flatMap((s) => [s.id, ...subsShown(s.id).map((c) => c.id)])].join();
  const list = useFlip<HTMLDivElement>(rowsOrder, searching, false);
  const [startError, setStartError] = useState<string | null>(null);
  /** A chat on its way: a second press of + would start another. */
  const starting = useRef(false);
  const start = (workspace?: string) => {
    if (!onNewChat || starting.current) return;
    starting.current = true;
    setStartError(null);
    onNewChat(workspace)
      .catch((e) => setStartError((e as Error).message))
      .finally(() => {
        starting.current = false;
      });
  };

  /** A chat's row, and its sub-chats under it. */
  const family = (s: Session) => {
    const subs = all.under.get(s.id);
    return (
      <Fragment key={s.id}>
        {row(s, shownStatus(s, subs), { subChats: subs })}
        <SubChats size="md" title={s.title} subs={under.get(s.id) ?? []} open={openSubs.isOpen(s.id)} onToggle={() => openSubs.toggle(s.id)}>
          {(c) => row(c, shownStatus(c), { nested: true })}
        </SubChats>
      </Fragment>
    );
  };

  /** `subChats`: those a delete names; `nested`: shown under its chat. */
  const row = (s: Session, status: ShownStatus, { subChats, nested = false }: { subChats?: readonly Session[]; nested?: boolean } = {}) => (
      <li
        key={s.id}
        data-flip={s.id}
        onMouseDown={() => {
          endingRename.current = renaming === s.id;
        }}
        onClick={() => {
          // A click on a name that is waiting for a second one is overtaken by this one.
          window.clearTimeout(opening.current);
          if (endingRename.current || renaming === s.id) {
            endingRename.current = false;
            return;
          }
          onSelect(s.id);
        }}
        // A row with buttons in it, so not a button itself: reached with Tab and opened with Enter, as in the sidebar.
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(s.id);
          }
        }}
        className="group flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5 transition hover:bg-fg/5"
      >
        <StatusDot status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {renaming === s.id ? (
              <TitleInput
                value={s.title}
                label={t("Session name")}
                className="flex-1 text-sm"
                onCommit={(next) => rename(s, next)}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <p
                className={`truncate text-sm text-fg ${workingText(status)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  window.clearTimeout(opening.current);
                  if (e.detail > 1) return;
                  opening.current = window.setTimeout(() => onSelect(s.id), DOUBLE_CLICK_MS);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  window.clearTimeout(opening.current);
                  setRenaming(s.id);
                }}
              >
                {pending?.id === s.id ? pending.title : s.title}
              </p>
            )}
            {s.pinned && (
              <LuPin className="h-3 w-3 shrink-0 text-accent/70" title={t("Pinned")} />
            )}
          </div>
          {/* Under a folder's heading, or on the one folder shown, its name is already there; under its chat, too. */}
          {!byFolder && !only && !nested && <p className="truncate text-[11px] text-fg-faint">{folderOf(s)}</p>}
        </div>
        <span className="shrink-0 text-[11px] text-fg-faint">{when(s.updated_at)}</span>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <SessionActions session={s} subChats={subChats} nested={nested} onPin={onPin} onStartRename={() => setRenaming(s.id)} onDelete={onDelete} onError={setError} />
        </div>
      </li>
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={list} className="sessions-list flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader
            icon={<LuMessagesSquare />}
            title={t("Sessions")}
            description={
              <>
                {t("Every task you have handed to pi. Each one runs on the server, so you can close the tab and pick it back up here once it is done.")}
              </>
            }
          >
            <div className="mt-4 flex flex-wrap gap-2">
              <Stat label={t("total")} value={all.top.length} />
              <Stat label={t("running")} value={running} tone="text-accent" />
              <Stat label={t("pinned")} value={pinnedCount} />
            </div>
          </PageHeader>

          <div className="relative mt-4">
            <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search by name or folder…")}
              aria-label={t("Search by name or folder…")}
              className="w-full rounded-lg border border-line bg-raised/60 py-2 pl-9 pr-3 text-sm outline-none placeholder:text-fg-faint focus:border-accent/60"
            />
            {query && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-faint">
                {t("{n} of {all}", { n: shown.length, all: only ? only.sessions.length : all.top.length })}
              </span>
            )}
          </div>

          {error && <ErrorBanner className="mt-3" onClose={() => setError(null)}>{error}</ErrorBanner>}
          {startError && <ErrorBanner className="mt-3" onClose={() => setStartError(null)}>{startError}</ErrorBanner>}

          {asked !== null ? (
            <div className="mt-3 flex items-center gap-1">
              <span className={`inline-flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-2.5 pr-1 text-xs ring-1 ring-inset ${gone ? "bg-warn/10 text-warn ring-warn/25" : "bg-accent/12 text-accent ring-accent/25"}`}>
                <LuFilter aria-hidden className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {only ? t("Only {name}", { name: folderName(only) }) : gone ? t("There is no folder “{name}” any more", { name: asked.replace(/^project:/, "") }) : t("Only one folder")}
                </span>
                <button type="button" onClick={() => showOnly(null)} aria-label={t("Show every folder")} title={t("Show every folder")} className="rounded p-0.5 hover:bg-fg/10">
                  <LuX className="h-3 w-3" />
                </button>
              </span>
            </div>
          ) : (
            hasPlaces && (
              <div className="mt-3">
                <ChatsHeading size="md" label={byFolder ? t("Folders") : t("All chats")} grouping={grouping} sort={sort} onGrouping={setGrouping} onSort={setSort} />
              </div>
            )
          )}

          {waiting ? (
            <RowsSkeleton />
          ) : gone ? null : shown.length === 0 && !byFolder ? (
            <p className="py-12 text-center text-sm text-fg-subtle">
              {all.top.length === 0 ? t("No sessions yet.") : only && !searching ? t("No chats in {name} yet.", { name: folderName(only) }) : t("Nothing matches that.")}
            </p>
          ) : byFolder ? (
            <div className="mt-2">
              {searching && folders.every((f) => f.sessions.length === 0) && (
                <p className="py-12 text-center text-sm text-fg-subtle">{t("Nothing matches that.")}</p>
              )}
              <FolderTree
                size="md"
                folders={searching ? folders.filter((f) => f.sessions.length > 0) : folders}
                isOpen={openFolders.isOpen}
                onToggle={openFolders.toggle}
                running={(s) => familyRunning(s, all.under.get(s.id))}
                onMove={searching || !allKeys ? undefined : (keys, key, to) => move(keys, key, to, allKeys)}
                onNewChat={onNewChat ? (f) => start(f.path || undefined) : undefined}
                extra={(f) => (
                  <button
                    type="button"
                    onClick={() => showOnly(f.key)}
                    aria-label={t("Only {name}", { name: folderName(f) })}
                    title={t("Only {name}", { name: folderName(f) })}
                    className="shrink-0 rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover/folder:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <LuFilter className="h-3 w-3" />
                  </button>
                )}
              >
                {(f) =>
                  f.sessions.length === 0 ? (
                    <p className="px-3 py-1 text-xs text-fg-faint">{t("No chats yet.")}</p>
                  ) : (
                    <ul className="space-y-1">{f.sessions.map(family)}</ul>
                  )
                }
              </FolderTree>
            </div>
          ) : (
            <ul className="stagger-in mt-3 space-y-1">{shown.map(family)}</ul>
          )}
        </div>
      </div>
    </div>
  );
});
