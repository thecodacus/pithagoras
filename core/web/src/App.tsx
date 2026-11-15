import { LuMenu, LuX } from "react-icons/lu";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, SIGNED_OUT, type SingleSignOn } from "./api";
import { DialogFailed, ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login, Setup } from "./components/Login";
import { isTab, type Tab } from "./settings-tabs";
import { setupDismissed } from "./setup-state";
import { load as loadCached, prefetchSettings } from "./settings-cache";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { lazyComponent } from "./lazy";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { ConfirmHost } from "./components/ConfirmDialog";
import { UpdateNotice } from "./components/UpdateNotice";
import { ExtensionsLeftBehind } from "./components/ExtensionsLeftBehind";
import { ErrorBanner, ghostCls } from "./components/SettingsUi";
import { reconnectDelay } from "./poll";
import { brand } from "./brand";
import { guardStrayDrops } from "./drop-guard";
import { usePlaces } from "./use-session-folders";
import { fancy, keep, swapPages, type Leave } from "./motion";
import { useStable } from "./use-stable";
import { splitSubChats } from "./sub-chats";
import { useDialogFocus } from "./dialog-focus";
import { t, useLanguage } from "./i18n";
import { Here, setNavigate, startExtensions } from "./extensions/loader";
import { alerts, chats, sessions, setOpener } from "./kernel/wire";
import { useOpenChat, useSessions, useUnlisted, useViewport } from "./kernel/use";
import { titleOf, useSlot } from "./extensions/slots";

// What the first draw needs is the shell, the chat and the sign-in page. The other pages, and the dialogs that
// open over them, are fetched when they are first opened, so that they are not in the file everyone waits for.
const SessionsPage = lazyComponent(() => import("./components/SessionsPage"), "SessionsPage");
const ProjectsPage = lazyComponent(() => import("./components/ProjectsPage"), "ProjectsPage");
const AgentPage = lazyComponent(() => import("./components/AgentPage"), "AgentPage");
const RoutinesPage = lazyComponent(() => import("./components/RoutinesPage"), "RoutinesPage");
const AuditPage = lazyComponent(() => import("./components/AuditPanel"), "AuditPage");
const ExtensionPage = lazyComponent(() => import("./components/ExtensionPage"), "ExtensionPage");
const ConfigModal = lazyComponent(() => import("./components/ConfigModal"), "ConfigModal");
const SetupAssistant = lazyComponent(() => import("./components/SetupAssistant"), "SetupAssistant");

// Legacy routes still resolve — old links stay valid: "session" and "global" were the defaults, and "password" and "sso" had a tab each before they were both on Authentication.
const LEGACY_TABS: Record<string, Tab> = { session: "general", global: "general", password: "authentication", sso: "authentication" };

export default function App() {
  // Everything under here is drawn again in a language chosen (see i18n.ts).
  useLanguage();
  const [authed, setAuthed] = useState<boolean | null>(null);
  /** No password has been chosen yet: the first start, or after it was removed with the reset command. */
  const [setup, setSetup] = useState(false);
  /** The single sign-on provider the login page offers, where there is one. */
  const [sso, setSso] = useState<SingleSignOn | undefined>();
  /** The portal did not answer when asked who is signed in: not the same as nobody being. */
  const [unreachable, setUnreachable] = useState(false);
  const failed = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout>>();
  const check = useCallback(() => {
    clearTimeout(retry.current);
    api.authStatus().then(
      (s) => {
        failed.current = 0;
        setUnreachable(false);
        setSetup(Boolean(s.setup));
        setSso(s.oidc);
        setAuthed(s.authed);
      },
      (e) => {
        // Only the portal saying no is a login that is gone. One that is restarting
        // answers 502 or not at all, and the cookie in the browser is still good: the
        // password form would be asking for what is not missing.
        if (e instanceof ApiError && e.status === 401) return setAuthed(false);
        setUnreachable(true);
        retry.current = setTimeout(check, reconnectDelay(++failed.current));
      },
    );
  }, []);

  useEffect(() => {
    check();
    const signedOut = () => setAuthed(false);
    window.addEventListener(SIGNED_OUT, signedOut);
    return () => {
      clearTimeout(retry.current);
      window.removeEventListener(SIGNED_OUT, signedOut);
    };
  }, [check]);

  // A file dropped just beside the message box must not replace the portal.
  useEffect(() => guardStrayDrops(), []);

  if (authed === null && unreachable) {
    return (
      <div role="alert" className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-fg-muted">{t("Cannot reach the portal")}</p>
        <p className="max-w-xs text-xs text-fg-faint">{t("It may be restarting. This page tries again by itself.")}</p>
        <button type="button" onClick={check} className={`mt-2 ${ghostCls}`}>
          {t("Try again")}
        </button>
      </div>
    );
  }
  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>
    );
  }
  if (!authed) {
    return (
      <>
        <div className="fixed right-4 top-4 z-raised">
          <ThemeSwitcher />
        </div>
        {setup ? <Setup onSuccess={() => { setSetup(false); setAuthed(true); }} /> : <Login sso={sso} onSuccess={() => setAuthed(true)} onSetup={() => setSetup(true)} />}
      </>
    );
  }

  // Every meaningful view has a URL: a session, and its settings tabs. Deep
  // links and the back button work, and the server's SPA fallback serves them.
  return (
    <>
      <ConfirmHost />
      <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/sessions" element={<Shell view="sessions" />} />
      <Route path="/projects" element={<Shell view="projects" />} />
      <Route path="/agents" element={<Shell view="agents" />} />
      {/* Where the page was while there was one agent: old links and bookmarks. */}
      <Route path="/agent" element={<Navigate to={{ pathname: "/agents", search: window.location.search }} replace />} />
      <Route path="/routines" element={<Shell view="routines" />} />
      <Route path="/audit" element={<Shell view="audit" />} />
      {/* A page an extension brought: /x/<extension>/<page id>, and an extension's name may have a slash in it. */}
      <Route path="/x/*" element={<Shell view="extension" />} />
      <Route path="/s/:sessionId" element={<Shell />} />
      <Route path="/s/:sessionId/settings" element={<Shell settings />} />
      <Route path="/s/:sessionId/settings/:tab" element={<Shell settings />} />
      {/* An extension's page in Settings, over a chat or not: settings/x/<extension>. */}
      <Route path="/s/:sessionId/settings/x/*" element={<Shell settings />} />
      <Route path="/settings" element={<Shell settings />} />
      <Route path="/settings/:tab" element={<Shell settings />} />
      <Route path="/settings/x/*" element={<Shell settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/** Once per page load, not once per page: the Shell is drawn again on every route. */
let setupAsked = false;

function Shell({
  settings = false,
  view = "chat",
}: {
  settings?: boolean;
  view?: "chat" | "sessions" | "projects" | "agents" | "routines" | "audit" | "extension";
}) {
  // What follows /x/ in the address: `<extension>/<page id>` of a page an extension brought, or `<extension>` of its page in Settings.
  const { sessionId, tab, "*": extensionPart = "" } = useParams<{ sessionId?: string; tab?: string; "*"?: string }>();
  const navigate = useNavigate();
  const { pathname, search, state } = useLocation();
  // What the installed extensions draw in the portal: see extensions/loader.ts.
  useEffect(() => {
    setNavigate(navigate);
    startExtensions();
  }, [navigate]);
  // What a page of an extension's that keeps what it shows in its address reads it from (portal.useLocation).
  const here = useMemo(() => ({ path: pathname, search }), [pathname, search]);
  const pages = useSlot("nav.page");
  // The extension's page shown, which the phone's top bar names as the sidebar does: in the language in effect.
  const extensionPage = view === "extension" ? pages.find((p) => p.key === extensionPart) : undefined;
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { setMobileNav(false); }, [sessionId, view, settings]);
  // The drawer covers the page and keeps the keyboard; widened to a window with the sidebar in place, it is only the sidebar.
  const drawer = useDialogFocus<HTMLDivElement>(mobileNav);
  const viewport = useViewport();
  useEffect(() => {
    if (mobileNav && viewport === "desk") setMobileNav(false);
  }, [mobileNav, viewport]);

  // A moment after the portal has drawn: fetch what Settings opens on, and
  // offer the setup assistant while there is no model to talk to.
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (setupAsked) return;
      setupAsked = true;
      prefetchSettings();
      // The dialog itself too, so that opening it is not a wait for its file.
      void import("./components/ConfigModal");
      if (setupDismissed()) return;
      loadCached("models", api.allModels, 30_000).then((r) => r.models.length === 0 && setSetup(true), () => {});
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  // The chat list, and the chat in the address, are the kernel's (see kernel/): this draws them. What it says to a person
  // who is looking elsewhere (the tab's title, a notification) is the kernel's too, and is started here once signed in.
  const { list: sessionList, status: listStatus, executor, error } = useSessions();
  /** Whether the chats have been asked for yet, and have come or failed to: the projects are asked for then, not before. */
  const sessionsAsked = listStatus !== "loading";
  const { places, reload: reloadPlaces } = usePlaces(sessionList, sessionsAsked);
  const listed = sessionId ? sessionList.find((s) => s.id === sessionId) ?? null : null;
  // The task list deliberately excludes agent and routine sessions, but their URLs still have to open — the Agent and
  // Routines pages link straight to them, and without this those links landed on the empty state.
  const { session: other, missing: missingFromList } = useUnlisted(listed ? undefined : sessionId);
  // Replay-then-tail for whichever session is in the URL. Nothing to read from for a chat the portal says it has none of.
  const chat = useOpenChat(missingFromList ? undefined : sessionId);
  /** The chat the portal says it has none of: deleted, say, on another device, while this one still had it open. */
  const gone = Boolean(sessionId) && (missingFromList || chat.missing);
  const active = listed ?? other;
  /** What a person does in the chat: the kernel asks what must be asked first. */
  const controller = active ? chats.controller(active.id) : null;
  useEffect(() => {
    setOpener((id) => navigate(`/s/${id}`));
    return alerts.start();
  }, [navigate]);
  // Not tied to where the page is: going from chat to chat is no reason to ask for the list again, nor to start its poll over.
  useEffect(() => sessions.start(), []);

  // Landing on "/" opens the most recent session — but only "/". The Sessions
  // and Agents pages have no sessionId either, and without the view check they
  // were redirected away the moment they loaded.
  const latestSessions = useRef(sessionList);
  latestSessions.current = sessionList;
  useEffect(() => {
    if (!sessionsAsked || sessionId || settings || view !== "chat") return;
    // A chat of its own, not a sub-chat, which is listed under its chat.
    const first = splitSubChats(latestSessions.current).top[0];
    if (first) navigate(`/s/${first.id}`, { replace: true });
  }, [sessionsAsked, sessionId, settings, view]);

  /** A chat started in `workspace`, or where "New" goes (the agent picked for new chats) without one, and opened. */
  const startChat = useStable(async (workspace?: string) => {
    const s = await sessions.actions.create(workspace);
    setMobileNav(false);
    navigate(`/s/${s.id}`);
  });

  // The page that is left plays out as a picture of itself over the one that
  // comes (see motion.ts). Taken here, while what is on the page is still the
  // page that was drawn, and put on it once the next one is. A chat to another
  // chat is the same page: only its conversation goes. A chat that was
  // deleted dissolves, and the empty page it is left on for a moment does not.
  const main = useRef<HTMLElement>(null);
  /** The chats the list had when it was last drawn. */
  const knownIds = useRef(new Set<string>());
  useEffect(() => {
    knownIds.current = new Set(sessionList.map((s) => s.id));
  }, [sessionList]);
  const pageKey = view === "chat" ? `chat:${active?.id ?? ""}` : view;
  const leaving = useRef<{ key: string; leave: ((how: Leave) => void) | null; how: Leave }>({ key: pageKey, leave: null, how: "page" });
  if (leaving.current.key !== pageKey) {
    const was = leaving.current.key;
    const page = main.current?.lastElementChild as HTMLElement | null | undefined;
    const betweenChats = was.startsWith("chat:") && pageKey.startsWith("chat:");
    // Gone from the list it was in: not one the list never has (an agent's or a routine's chat is opened by its address).
    const deleted = was.startsWith("chat:") && knownIds.current.has(was.slice(5)) && !sessionList.some((s) => s.id === was.slice(5));
    leaving.current = {
      key: pageKey,
      leave: was === "chat:" ? null : keep((betweenChats && page?.querySelector<HTMLElement>("[data-transcript]")) || page || null),
      how: deleted ? "gone" : "page",
    };
    if (leaving.current.leave && fancy()) swapPages(true);
  }
  useLayoutEffect(() => {
    const { leave, how } = leaving.current;
    leaving.current.leave = null;
    swapPages(false);
    leave?.(how);
  }, [pageKey]);

  // Handed to the sidebar, the sessions page and Settings, which are not drawn
  // again unless what they show changed: events arrive many times a second, and
  // a handler made anew with each of those draws would make them all draw too.
  const onNavigate = useStable((to: string) => {
    setMobileNav(false);
    navigate(`/${to}`);
  });
  const onOpenFolder = useStable((key: string) => {
    setMobileNav(false);
    navigate(`/sessions?folder=${encodeURIComponent(key)}`);
  });
  const onSelect = useStable((id: string) => {
    setMobileNav(false);
    navigate(`/s/${id}`);
  });
  /** False where the person said no to the question the kernel asks first. */
  const onDeleteChat = useStable(async (id: string) => {
    // The chat open is this one, or one of its sub-chats, which go with it.
    // It need not be listed: a sub-chat an extension keeps out of the list is fetched by its id (`active`).
    const open = sessionId === id || active?.parent === id;
    const parent = sessions.find(id)?.parent;
    if (!(await sessions.actions.remove(id))) return false;
    // A sub-chat gone takes its page back to its chat, if that is listed; a chat gone, to the latest chat of its own.
    const list = sessions.store.get().list;
    const next = parent && list.some((s) => s.id === parent) ? parent : splitSubChats(list).top[0]?.id;
    if (open) navigate(next ? `/s/${next}` : "/", { replace: true });
    return true;
  });
  const onRenameChat = useStable((id: string, title: string) => sessions.actions.rename(id, title));
  const onPin = useStable((id: string, pinned: boolean) => sessions.actions.pin(id, pinned));
  const onOpenSettings = useStable(() => navigate(sessionId ? `/s/${sessionId}/settings/general` : "/settings/general"));
  const openUpdate = useStable(() => navigate(sessionId ? `/s/${sessionId}/settings/about` : "/settings/about"));
  // Back to the page that opened Settings where it said which (`state.from`), else to the chat.
  const closeSettings = useStable(() => navigate((state as { from?: string } | null)?.from ?? (active ? `/s/${active.id}` : "/")));
  const setUpModel = useStable(() => {
    navigate(active ? `/s/${active.id}` : "/");
    setSetup(true);
  });
  // The sessions page: its own way of opening a chat, which does not close the drawer.
  const openChat = useStable((id: string) => navigate(`/s/${id}`));
  const deleteListed = onDeleteChat;
  const deleteListedMany = useStable((ids: string[]) => sessions.actions.removeMany(ids));
  const renameListed = onRenameChat;

  return (
    <Here.Provider value={here}>
    <div data-fits-keyboard className="flex h-[calc(100dvh-var(--keyboard,0px))] min-h-0 overflow-hidden bg-canvas">
      {mobileNav && <button aria-label={t("Dismiss navigation")} onClick={() => setMobileNav(false)} className="ui-backdrop fixed inset-0 z-backdrop bg-black/50 md:hidden" />}
      <div
        id="mobile-navigation"
        ref={drawer}
        tabIndex={mobileNav ? -1 : undefined}
        role={mobileNav ? "dialog" : undefined}
        aria-modal={mobileNav ? true : undefined}
        aria-label={mobileNav ? t("Navigation") : undefined}
        className={`${mobileNav ? "mobile-drawer fixed inset-y-0 left-0 z-nav flex outline-none" : "hidden"} h-full shrink-0 md:static md:z-auto md:flex`}>
      {mobileNav && <button type="button" aria-label={t("Close navigation")} onClick={() => setMobileNav(false)} className="absolute right-2 top-3 z-panel rounded-lg p-2 text-fg md:hidden"><LuX size={20}/></button>}
      <Sidebar
        forceExpanded={mobileNav}
        sessions={sessionList}
        executor={executor}
        activeId={sessionId ?? null}
        view={view === "extension" ? `x/${extensionPart}` : view}
        places={places}
        onNavigate={onNavigate}
        onOpenFolder={onOpenFolder}
        onSelect={onSelect}
        onNewChat={startChat}
        onDelete={onDeleteChat}
        onRename={onRenameChat}
        onPin={onPin}
        onOpenSettings={onOpenSettings}
      />

      </div>
      <main ref={main} className="app-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* In a chat the chat's own header has the menu button, and this bar
            would only repeat its title; in voice mode that header is gone. */}
        <header className="app-mobile-bar flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 md:hidden">
          <button type="button" aria-label={t("Open navigation")} aria-expanded={mobileNav} aria-controls="mobile-navigation" onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-fg hover:bg-fg/10"><LuMenu size={20}/></button>
          <span className="truncate text-sm text-fg">{(extensionPage && titleOf(extensionPage)) || active?.title || brand.name}</span>
        </header>
        <UpdateNotice onDetails={openUpdate} />
        <ExtensionsLeftBehind />
        {error && <ErrorBanner className="mx-4 mt-2" onClose={sessions.actions.dismissError}>{error}</ErrorBanner>}
        {/* Not for the first miss: a server restarting, or a wifi that blinked,
            is back before it can be read. Two in a row is an outage. */}
        {sessionId && chat.failures >= 2 && !gone && (
          <div role="status" className="bg-warn/10 px-4 py-2 text-sm text-warn">
            {t("Lost the connection to the portal — trying again. What is shown may be out of date.")}
          </div>
        )}
        {/* One page failing to draw takes down that page, not the portal. */}
        <ErrorBoundary resetKey={`${view}:${sessionId ?? ""}`}>
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>}>
        {view === "sessions" ? (
          <SessionsPage
            sessions={sessionList}
            places={places}
            onSelect={openChat}
            onNewChat={startChat}
            onDelete={deleteListed}
            onDeleteMany={deleteListedMany}
            onPin={onPin}
            onRename={renameListed}
          />
        ) : view === "projects" ? (
          <ProjectsPage
            sessions={sessionList}
            onOpenChat={(id) => navigate(`/s/${id}`)}
            onNewChat={async (workspace) => {
              const s = await sessions.actions.create(workspace);
              navigate(`/s/${s.id}`);
            }}
            onChanged={() => {
              sessions.refresh().catch(() => {});
              reloadPlaces();
            }}
          />
        ) : view === "agents" ? (
          <AgentPage onSelect={(id) => navigate(`/s/${id}`)} onNewChat={startChat} reloadPlaces={reloadPlaces} />
        ) : view === "routines" ? (
          <RoutinesPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "audit" ? (
          <AuditPage />
        ) : view === "extension" ? (
          <ExtensionPage entryKey={extensionPart} />
        ) : active ? (
          <Chat
            session={active}
            events={chat.loaded ? chat.events : []}
            loading={!chat.loaded}
            hasEarlier={chat.loaded && chat.moreBefore}
            loadingEarlier={chat.loadingBefore}
            onLoadEarlier={controller!.loadEarlier}
            onSend={controller!.send}
            versions={chat.versions}
            onEditMessage={controller!.edit}
            onDeleteMessage={controller!.deleteMessage}
            onTakeBackQueued={controller!.queued.takeBack}
            onSendQueuedNow={controller!.queued.sendNow}
            onAbort={controller!.abort}
            onRename={controller!.rename}
            onSetMode={controller!.setMode}
            onTrustFlagged={controller!.trustFlagged}
            onSwitchVersion={controller!.switchVersion}
            onOpenNavigation={() => setMobileNav(true)}
            parentTitle={active.parent ? sessionList.find((s) => s.id === active.parent)?.title : undefined}
            onClientCommand={async (name, args) => {
              if (name === "settings") {
                navigate(`/s/${active.id}/settings/general`);
              } else if (name === "new" || name === "clear") {
                // A fresh chat in the same project, or in Home.
                const s = await sessions.actions.create(active.workspace);
                setMobileNav(false);
                navigate(`/s/${s.id}`);
              } else if (name === "name" && args.trim()) {
                await controller!.rename(args.trim());
              }
            }}
          />
        ) : gone ? (
          <GoneState onSessions={() => navigate("/sessions")} />
        ) : (
          <EmptyState hasSessions={sessionList.length > 0} />
        )}
        </Suspense>
        </ErrorBoundary>
      </main>

      {active && chat.dialogs[0] && (
        <ExtensionDialog
          // One dialog per question: what the last was answered, or failed with, is not this one's.
          key={chat.dialogs[0].id}
          sessionId={active.id}
          request={chat.dialogs[0]}
          onDone={() => chats.dismissDialog(active.id, chat.dialogs[0].id)}
        />
      )}

      {/* Their code is fetched when one opens, and a file that is gone must not take the portal with it. */}
      <ErrorBoundary resetKey={`${settings}:${setup}`} fallback={(error) => <DialogFailed error={error} onClose={() => { setSetup(false); if (settings) closeSettings(); }} />}>
      <Suspense fallback={null}>
        {settings && (
          <ConfigModal
            initialTab={LEGACY_TABS[tab ?? ""] ?? (tab && isTab(tab) ? tab : "general")}
            extension={extensionPart || undefined}
            onClose={closeSettings}
            onSetup={setUpModel}
          />
        )}

        {setup && (
          <SetupAssistant
            onClose={() => setSetup(false)}
            onStartChat={async () => {
              const s = await sessions.actions.create();
              navigate(`/s/${s.id}`);
            }}
          />
        )}
      </Suspense>
      </ErrorBoundary>
    </div>
    </Here.Provider>
  );
}

function GoneState({ onSessions }: { onSessions: () => void }) {
  return (
    <div className="chat-empty flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm text-fg-muted">{t("This chat no longer exists.")}</p>
      <button type="button" onClick={onSessions} className={ghostCls}>
        {t("Back to Sessions")}
      </button>
    </div>
  );
}

function EmptyState({ hasSessions }: { hasSessions: boolean }) {
  return (
    <div className="chat-empty flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <img src="/icon-192.png" alt="" draggable={false} className="chat-empty-mark mb-2 h-12 w-12 object-contain" />
      <p className="text-sm text-fg-muted">
        {/* On a phone the list is behind the menu, not on the left. */}
        {hasSessions ? t("Pick a session from the list.") : t("Start a session to get going.")}
      </p>
      <p className="max-w-xs text-xs text-fg-faint">
        {t("Give it a task and close the tab — it keeps working, and picks up where it left off when you come back.")}
      </p>
    </div>
  );
}
