import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type PortalEvent, type Session, type Workspace } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { ConfigModal } from "./components/ConfigModal";
import { ExtensionDialog, type UiRequest } from "./components/ExtensionDialog";
import { SessionsPage } from "./components/SessionsPage";
import { AgentPage } from "./components/AgentPage";
import { RoutinesPage } from "./components/RoutinesPage";
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
  view?: "chat" | "sessions" | "agent" | "routines";
}) {
  const { sessionId, tab } = useParams<{ sessionId?: string; tab?: string }>();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [executor, setExecutor] = useState("host");
  const [events, setEvents] = useState<PortalEvent[]>([]);
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
    const t = setInterval(() => refreshSessions().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [refreshSessions, sessionId, settings, view, navigate]);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setUiQueue([]);
    if (!sessionId) return;

    let cancelled = false;
    let seq = 0;
    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      esRef.current = es;
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // Live-only events (dialogs) use a negative seq and must not move the
        // resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "portal_status") refreshSessions().catch(() => {});
        // Dialogs an extension is blocking on. notify/setStatus/setWidget are
        // one-way and must not open a modal.
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
      es.onerror = () => {
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

  // The task list deliberately excludes agent and routine sessions, but their
  // URLs still have to open — the Agent and Routines pages link straight to
  // them, and without this those links landed on the empty state.
  const [other, setOther] = useState<Session | null>(null);
  const listed = sessions.find((s) => s.id === sessionId) ?? null;

  useEffect(() => {
    if (!sessionId || listed) return setOther(null);
    let cancelled = false;
    api
      .session(sessionId)
      .then((s) => !cancelled && setOther(s))
      .catch(() => !cancelled && setOther(null));
    return () => {
      cancelled = true;
    };
  }, [sessionId, listed]);

  const active = listed ?? (other?.id === sessionId ? other : null);

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar
        sessions={sessions}
        workspaces={workspaces}
        executor={executor}
        activeId={sessionId ?? null}
        view={view}
        onNavigate={(to) => navigate(`/${to}`)}
        onSelect={(id) => navigate(`/s/${id}`)}
        onCreate={async (workspacePath) => {
          const s = await api.createSession(workspacePath);
          await refreshSessions();
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

      <main className="flex min-w-0 flex-1 flex-col">
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
        ) : active ? (
          <Chat
            session={active}
            events={events}
            onSend={async (msg) => {
              await api.prompt(active.id, msg);
              refreshSessions();
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
