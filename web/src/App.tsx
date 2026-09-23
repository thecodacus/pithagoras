import { LuMenu, LuX } from "react-icons/lu";
import { appendLiveEvent, resetLiveEvents } from "./live-events";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type PortalEvent, type Session, type SessionStatus, type Workspace } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { ConfigModal } from "./components/ConfigModal";
import { ExtensionDialog, type UiRequest } from "./components/ExtensionDialog";
import { SessionsPage } from "./components/SessionsPage";
import { AgentPage } from "./components/AgentPage";
import { RoutinesPage } from "./components/RoutinesPage";
import { AuditPage } from "./components/AuditPanel";
import { BrowserPage } from "./components/BrowserPage";
import { ThemeSwitcher } from "./components/ThemeSwitcher";

// Legacy routes ("session", "global") still resolve — old links stay valid.
type Tab = "general" | "extensions" | "advanced";
const LEGACY_TABS: Record<string, Tab> = { session: "general", global: "general" };

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">Loading…</div>
    );
  }
  if (!authed) {
    return (
      <>
        <div className="fixed right-4 top-4 z-10">
          <ThemeSwitcher />
        </div>
        <Login onSuccess={() => setAuthed(true)} />
      </>
    );
  }

  // Every meaningful view has a URL: a session, and its settings tabs. Deep
  // links and the back button work, and the server's SPA fallback serves them.
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/sessions" element={<Shell view="sessions" />} />
      <Route path="/agent" element={<Shell view="agent" />} />
      <Route path="/routines" element={<Shell view="routines" />} />
      <Route path="/browser" element={<Shell view="browser" />} />
      <Route path="/audit" element={<Shell view="audit" />} />
      <Route path="/s/:sessionId" element={<Shell />} />
      <Route path="/s/:sessionId/settings" element={<Shell settings />} />
      <Route path="/s/:sessionId/settings/:tab" element={<Shell settings />} />
      <Route path="/settings" element={<Shell settings />} />
      <Route path="/settings/:tab" element={<Shell settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Shell({
  settings = false,
  view = "chat",
}: {
  settings?: boolean;
  view?: "chat" | "sessions" | "agent" | "routines" | "browser" | "audit";
}) {
  const { sessionId, tab } = useParams<{ sessionId?: string; tab?: string }>();
  const navigate = useNavigate();
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { setMobileNav(false); }, [sessionId, view, settings]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  const [sessions, setSessions] = useState<Session[]>([]);
  // The task list deliberately excludes agent and routine sessions, but their
  // URLs still have to open — the Agent and Routines pages link straight to
  // them, and without this those links landed on the empty state.
  const [other, setOther] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [executor, setExecutor] = useState("host");
  // Asked once: the browser is optional, and the answer only changes when
  // somebody starts or stops a container.
  const [hasBrowser, setHasBrowser] = useState(false);
  const [events, setEvents] = useState<PortalEvent[]>([]);
  /** Whether anything older than what we hold is still on the server. */
  const [moreBefore, setMoreBefore] = useState(false);
  const [loadingBefore, setLoadingBefore] = useState(false);
  /**
   * Which session's replay has arrived, so it is not drawn half-built. A session
   * id rather than a flag: the first render after switching still holds the
   * previous session's events, and must not show them under the new title.
   */
  const [loadedSession, setLoadedSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiQueue, setUiQueue] = useState<UiRequest[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    setSessions(r.sessions);
    setExecutor(r.executor);
    return r.sessions;
  }, []);

  useEffect(() => {
    refreshSessions()
      .then((list) => {
        // Landing on "/" opens the most recent session — but only "/". The
        // Sessions and Agents pages have no sessionId either, and without the
        // view check they were redirected away the moment they loaded.
        if (!sessionId && !settings && view === "chat" && list[0]) {
          navigate(`/s/${list[0].id}`, { replace: true });
        }
      })
      .catch((e) => setError(String(e)));
    api
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => {});
    api
      .browser()
      .then((b) => setHasBrowser(b.running || b.sessions.length > 0 || b.routines.length > 0))
      .catch(() => setHasBrowser(false));
    const t = setInterval(() => refreshSessions().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [refreshSessions, sessionId, settings, view, navigate]);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setMoreBefore(false);
    setUiQueue([]);
    setLoadedSession(null);
    if (!sessionId) return;

    let cancelled = false;
    let seq = 0;
    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      esRef.current = es;
      es.addEventListener("live-reset", () => setEvents(resetLiveEvents));
      // Until it has caught up, what arrives is history being replayed. It is
      // gathered and applied in one go: drawing the conversation once per event
      // is what made a long one open at the top, build downwards over seconds and
      // then jump to the end.
      let replay: PortalEvent[] | null = [];
      // Applied straight from the event, not by re-fetching: the round trip
      // is what made the Stop button appear a beat late, or not at all when
      // the reply came back before the list did.
      const applyStatus = (ev: PortalEvent) => {
        if (ev.type !== "portal_status") return;
        const status = (ev.payload as { status?: SessionStatus }).status;
        if (status) {
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, status } : s)),
          );
          // An agent or routine session is not in that list at all — it is
          // fetched once, on its own. Without this it kept whatever status
          // the fetch happened to catch, so a chat either never started
          // working or never stopped, and the activity line ran forever.
          setOther((prev) => (prev?.id === sessionId ? { ...prev, status } : prev));
        }
        refreshSessions().catch(() => {});
      };
      // Dialogs an extension is blocking on. notify/setStatus/setWidget are
      // one-way and must not open a modal.
      const applyDialog = (ev: PortalEvent) => {
        if (ev.type === "extension_ui_request") {
          const req = ev.payload as UiRequest;
          if (["select", "confirm", "input", "editor"].includes(req.method)) {
            setUiQueue((q) => (q.some((x) => x.id === req.id) ? q : [...q, req]));
          }
        }
        if (ev.type === "extension_ui_cancel") {
          const id = (ev.payload as { id: string }).id;
          setUiQueue((q) => q.filter((x) => x.id !== id));
        }
      };
      const flush = () => {
        const batch = replay;
        replay = null;
        if (!batch?.length) return;
        setEvents((prev) => batch.reduce(appendLiveEvent, prev));
        // Only where the session ended up is news; the statuses it passed
        // through on the way were each a request for the session list.
        const last = [...batch].reverse().find((e) => e.type === "portal_status");
        if (last) applyStatus(last);
        batch.forEach(applyDialog);
      };
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // A message was taken out of the conversation: drop what it covered,
        // rather than reloading everything to find out what is left. While the
        // replay is still being gathered that buffer is where they are, so it
        // is filtered instead of the rendered list.
        if (ev.type === "portal_removed") {
          const { from, to } = ev.payload as { from: number; to: number | null };
          const covered = (at: number) => at >= from && (to == null || at < to);
          if (replay) replay = replay.filter((e) => !covered(e.seq));
          else setEvents((prev) => prev.filter((e) => !covered(e.seq)));
          return;
        }
        // Live-only events (dialogs) use a negative seq and must not move the
        // resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        if (replay) {
          replay.push(ev);
          return;
        }
        setEvents((prev) => appendLiveEvent(prev, ev));
        applyStatus(ev);
        applyDialog(ev);
      };
      es.addEventListener("caught-up", () => {
        flush();
        setLoadedSession(sessionId);
        // Only now do we know where the replayed window starts, and therefore
        // whether the conversation continues above it.
        setEvents((prev) => {
          const oldest = prev.find((e) => e.seq > 0)?.seq;
          if (oldest === undefined) return prev;
          api
            .olderEvents(sessionId, oldest, 1)
            .then((r) => setMoreBefore(r.events.length > 0))
            .catch(() => {});
          return prev;
        });
      });
      es.onerror = () => {
        // Keep what arrived: the resume cursor has already moved past it.
        flush();
        es.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [sessionId, refreshSessions]);

  const listed = sessions.find((s) => s.id === sessionId) ?? null;

  useEffect(() => {
    if (!sessionId || listed) return setOther(null);
    let cancelled = false;
    const load = () =>
      api
        .session(sessionId)
        .then((s) => !cancelled && setOther(s))
        .catch(() => !cancelled && setOther(null));
    load();
    // The same five seconds the task list gets. Events keep this current
    // between ticks; the poll is what stops a dropped one from stranding the
    // session on a status it left long ago.
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId, listed]);

  const active = listed ?? (other?.id === sessionId ? other : null);

  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden bg-canvas">
      {mobileNav && <button aria-label="Dismiss navigation" onClick={() => setMobileNav(false)} className="fixed inset-0 z-40 bg-black/50 md:hidden" />}
      <div id="mobile-navigation" className={`${mobileNav ? "fixed inset-y-0 left-0 z-50 flex" : "hidden"} h-full shrink-0 md:static md:z-auto md:flex`}>
      {mobileNav && <button type="button" aria-label="Close navigation" onClick={() => setMobileNav(false)} className="absolute right-2 top-3 z-20 rounded-lg p-2 text-fg md:hidden"><LuX size={20}/></button>}
      <Sidebar
        forceExpanded={mobileNav}
        sessions={sessions}
        workspaces={workspaces}
        executor={executor}
        activeId={sessionId ?? null}
        view={view}
        hasBrowser={hasBrowser}
        onNavigate={(to) => { setMobileNav(false); navigate(`/${to}`); }}
        onSelect={(id) => { setMobileNav(false); navigate(`/s/${id}`); }}
        onCreate={async (workspacePath) => {
          const s = await api.createSession(workspacePath);
          await refreshSessions();
          setMobileNav(false);
          navigate(`/s/${s.id}`);
        }}
        onDelete={async (id) => {
          await api.deleteSession(id);
          const list = await refreshSessions();
          if (sessionId === id) navigate(list[0] ? `/s/${list[0].id}` : "/", { replace: true });
        }}
        onRename={async (id, title) => {
          await api.renameSession(id, title);
          refreshSessions();
        }}
        onPin={async (id, pinned) => {
          await api.pinSession(id, pinned);
          refreshSessions();
        }}
        onOpenSettings={() =>
          navigate(sessionId ? `/s/${sessionId}/settings/general` : "/settings/general")
        }
        onCreateWorkspace={async (name) => {
          const created = await api.createWorkspace(name);
          const list = await api.workspaces();
          setWorkspaces(list.workspaces);
          return created;
        }}
      />

      </div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 md:hidden">
          <button type="button" aria-label="Open navigation" aria-expanded={mobileNav} aria-controls="mobile-navigation" onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-fg hover:bg-fg/10"><LuMenu size={20}/></button>
          <span className="truncate text-sm text-fg">{active?.title || "Pithagoras"}</span>
        </header>
        {error && <div className="bg-danger/10 px-4 py-2 text-sm text-danger">{error}</div>}
        {view === "sessions" ? (
          <SessionsPage
            sessions={sessions}
            onSelect={(id) => navigate(`/s/${id}`)}
            onDelete={async (id) => {
              await api.deleteSession(id);
              await refreshSessions();
            }}
            onPin={async (id, pinned) => {
              await api.pinSession(id, pinned);
              refreshSessions();
            }}
          />
        ) : view === "agent" ? (
          <AgentPage onSelect={(id) => navigate(`/s/${id}`)} />
        ) : view === "routines" ? (
          <RoutinesPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "browser" ? (
          <BrowserPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "audit" ? (
          <AuditPage />
        ) : active ? (
          <Chat
            session={active}
            events={loadedSession === active.id ? events : []}
            loading={loadedSession !== active.id}
            hasEarlier={loadedSession === active.id && moreBefore}
            loadingEarlier={loadingBefore}
            onLoadEarlier={async () => {
              const oldest = events.find((e) => e.seq > 0)?.seq;
              if (!oldest || loadingBefore) return;
              setLoadingBefore(true);
              try {
                const r = await api.olderEvents(active.id, oldest);
                setEvents((prev) => [...r.events, ...prev]);
                setMoreBefore(r.more);
              } catch {
                // Leave the button where it is; trying again is free.
              } finally {
                setLoadingBefore(false);
              }
            }}
            onSend={async (msg, options) => {
              await api.prompt(active.id, msg, options);
              refreshSessions();
            }}
            onEditMessage={async (seq, message) => {
              await api.editMessage(active.id, seq, message);
              refreshSessions();
            }}
            onDeleteMessage={async (seq) => {
              await api.deleteMessage(active.id, seq);
            }}
            onAbort={async () => {
              await api.abort(active.id);
              refreshSessions();
            }}
            onClientCommand={async (name, args) => {
              if (name === "settings") {
                navigate(`/s/${active.id}/settings/general`);
              } else if (name === "new") {
                const s = await api.createSession(active.workspace);
                await refreshSessions();
                setMobileNav(false);
          navigate(`/s/${s.id}`);
              } else if (name === "name" && args.trim()) {
                await api.renameSession(active.id, args.trim());
                refreshSessions();
              }
            }}
          />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
      </main>

      {active && uiQueue[0] && (
        <ExtensionDialog
          sessionId={active.id}
          request={uiQueue[0]}
          onDone={() => setUiQueue((q) => q.slice(1))}
        />
      )}

      {settings && (
        <ConfigModal
          initialTab={LEGACY_TABS[tab ?? ""] ?? (tab as Tab) ?? "general"}
          onClose={() => navigate(active ? `/s/${active.id}` : "/")}
        />
      )}
    </div>
  );
}

function EmptyState({ hasSessions }: { hasSessions: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface text-xl text-fg-faint">
        π
      </div>
      <p className="text-sm text-fg-muted">
        {hasSessions ? "Pick a session on the left." : "Start a session to get going."}
      </p>
      <p className="max-w-xs text-xs text-fg-faint">
        Give it a task and close the tab — it keeps working, and picks up where it left off when you
        come back.
      </p>
    </div>
  );
}
