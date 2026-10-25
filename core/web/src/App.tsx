import { LuMenu, LuX } from "react-icons/lu";
import { appendLiveEvents, resetLiveEvents } from "./live-events";
import { fillFrom } from "./editor-fills";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, SIGNED_OUT, type PortalEvent, type Session, type SessionStatus, type SingleSignOn } from "./api";
import { DialogFailed, ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login, Setup } from "./components/Login";
import { isTab, type Tab } from "./settings-tabs";
import { setupDismissed } from "./setup-state";
import { load as loadCached, prefetchSettings } from "./settings-cache";
import { ExtensionDialog, type UiRequest } from "./components/ExtensionDialog";
import { lazyComponent } from "./lazy";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { ConfirmHost } from "./components/ConfirmDialog";
import { UpdateNotice } from "./components/UpdateNotice";
import { ExtensionsLeftBehind } from "./components/ExtensionsLeftBehind";
import { ErrorBanner, ghostCls } from "./components/SettingsUi";
import { pollWhileVisible, reconnectDelay } from "./poll";
import { APP_NAME, finishedRuns, tabTitle } from "./attention";
import { notifyIfAway, notifyState } from "./notify";
import { guardStrayDrops } from "./drop-guard";
import { usePlaces } from "./use-session-folders";
import { fancy, keep, swapPages, type Leave } from "./motion";
import { reconcile } from "./reconcile";
import { useStable } from "./use-stable";
import { splitSubChats } from "./sub-chats";
import { useDialogFocus } from "./dialog-focus";
import { t, useLanguage } from "./i18n";
import { followInstalled, Here, setNavigate, startExtensions } from "./extensions/loader";
import { extensionMessage } from "./extensions/channel";
import { serverPush, setChatOnScreen } from "./extensions/server-feed";
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
        <div className="fixed right-4 top-4 z-10">
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
  useEffect(() => {
    if (!mobileNav) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const onChange = () => wide.matches && setMobileNav(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [mobileNav]);

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

  const [sessions, setSessions] = useState<Session[]>([]);
  // The task list deliberately excludes agent and routine sessions, but their
  // URLs still have to open — the Agent and Routines pages link straight to
  // them, and without this those links landed on the empty state.
  const [other, setOther] = useState<Session | null>(null);
  const [executor, setExecutor] = useState("host");
  const [events, setEvents] = useState<PortalEvent[]>([]);
  /** The versions of the chat's messages, as its stream says: see messageVersions on the server. */
  const [versions, setVersions] = useState<Record<number, number[]>>({});
  /** How often the chat shown was loaded again from the start: see portal_reload. */
  const loadedAgain = useRef(0);
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
  /** Connection attempts to the open conversation that have failed in a row. */
  const [failures, setFailures] = useState(0);
  /** The chat the portal says it has none of: deleted, say, on another device, while this one still had it open. */
  const [missing, setMissing] = useState<string | null>(null);

  /**
   * Whether the chats have been asked for yet, and have come or failed to: the
   * projects are asked for then, not before and again once the chats are there
   * — and not never, when the chats cannot be had and the projects can.
   */
  const [sessionsAsked, setSessionsAsked] = useState(false);
  const { places, reload: reloadPlaces } = usePlaces(sessions, sessionsAsked);

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    // What is installed changed since the page last went through it, wherever it was changed: it goes through it again.
    followInstalled(r.extensions);
    // Kept as it was when it says the same: a list asked for every few seconds is
    // mostly unchanged, and a new array is a draw of the portal for nothing.
    setSessions((prev) => reconcile(prev, r.sessions));
    setSessionsAsked(true);
    setExecutor(r.executor);
    // A list that came is the end of the outage the first one reported.
    setError(null);
    return r.sessions;
  }, []);

  /** A chat started in `workspace`, or where "New" goes (the agent picked for new chats) without one, and opened. */
  const startChat = useStable(async (workspace?: string) => {
    const s = await api.createSession(workspace);
    await refreshSessions();
    setMobileNav(false);
    navigate(`/s/${s.id}`);
  });

  // Not tied to where the page is: going from chat to chat is no reason to ask
  // for the list again, nor to start its poll over.
  useEffect(() => {
    refreshSessions().catch((e) => {
      setSessionsAsked(true);
      setError((e as Error).message);
    });
    return pollWhileVisible(() => refreshSessions().catch(() => {}), 5000);
  }, [refreshSessions]);

  // Landing on "/" opens the most recent session — but only "/". The Sessions
  // and Agents pages have no sessionId either, and without the view check they
  // were redirected away the moment they loaded.
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  useEffect(() => {
    if (!sessionsAsked || sessionId || settings || view !== "chat") return;
    // A chat of its own, not a sub-chat, which is listed under its chat.
    const first = splitSubChats(latestSessions.current).top[0];
    if (first) navigate(`/s/${first.id}`, { replace: true });
  }, [sessionsAsked, sessionId, settings, view]);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setVersions({});
    setMoreBefore(false);
    // An earlier page that is still on its way is the left chat's: it is dropped when it arrives, and this chat asks for its own.
    loadedAgain.current++;
    setLoadingBefore(false);
    setUiQueue([]);
    setLoadedSession(null);
    setFailures(0);
    // Nothing to read from: the stream of a chat that is gone only fails, and was retried as an outage.
    if (!sessionId || missing === sessionId) return;

    // The chat whose stream is open, for an extension that comes into the page later: see extensions/loader.ts.
    setChatOnScreen(sessionId);
    let cancelled = false;
    let seq = 0;
    let failed = 0;
    // Loading the chat again, from the start: what arrives replaces what is
    // held, once it has all come. See portal_reload.
    let replacing = false;
    // How often the chat's events were put back under seqs this page had read
    // past, as its stream last said: see bumpReloads on the server.
    let reloads: number | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Once caught up, what arrives is applied a frame at a time, not an event at
    // a time: a reply is a token every few milliseconds, and each was a draw of
    // the chat. The timer is for a tab nobody sees, where frames are not drawn.
    let pending: PortalEvent[] = [];
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = timer = undefined;
      const batch = pending;
      pending = [];
      if (batch.length) setEvents((prev) => appendLiveEvents(prev, batch));
    };
    const soon = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(drain);
      timer = setTimeout(drain, 120);
    };
    const connect = () => {
      if (cancelled) return;
      const fresh = seq === 0;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      /** Reads the chat again from the start, keeping what is shown until it has all come. */
      const reload = () => {
        es.close();
        seq = 0;
        replacing = true;
        connect();
      };
      esRef.current = es;
      es.onopen = () => {
        failed = 0;
        setFailures(0);
      };
      // A count other than the last one seen: events came back while this page
      // was away, under seqs it had read past, and going on from its cursor
      // would never show them. A stream reading from the start has them all.
      es.addEventListener("reloads", (m) => {
        const now = (JSON.parse((m as MessageEvent).data) as { reloads: number }).reloads;
        const missed = reloads !== undefined && now !== reloads && !fresh;
        reloads = now;
        if (missed) reload();
      });
      es.addEventListener("versions", (m) => setVersions((JSON.parse((m as MessageEvent).data) as { versions: Record<number, number[]> }).versions));
      es.addEventListener("live-reset", () => {
        drain();
        setEvents(resetLiveEvents);
      });
      // What the installed extensions' server halves tell what they drew on this chat: see extensions/server-feed.ts.
      es.addEventListener("extension", (m) => {
        const { extension, data } = JSON.parse((m as MessageEvent).data) as { extension: string; data: unknown };
        serverPush(sessionId, extension, data);
      });
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
            prev.some((s) => s.id === sessionId && s.status !== status)
              ? prev.map((s) => (s.id === sessionId ? { ...s, status } : s))
              : prev,
          );
          // An agent or routine session is not in that list at all — it is
          // fetched once, on its own. Without this it kept whatever status
          // the fetch happened to catch, so a chat either never started
          // working or never stopped, and the activity line ran forever.
          setOther((prev) => (prev?.id === sessionId && prev.status !== status ? { ...prev, status } : prev));
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
        if (!batch) return;
        if (replacing) {
          replacing = false;
          // What was being fetched from above the old list belongs to it.
          loadedAgain.current++;
          setLoadingBefore(false);
          setEvents(appendLiveEvents([], batch));
        } else if (batch.length) setEvents((prev) => appendLiveEvents(prev, batch));
        if (!batch.length) return;
        // Only where the session ended up is news; the statuses it passed
        // through on the way were each a request for the session list.
        const last = [...batch].reverse().find((e) => e.type === "portal_status");
        if (last) applyStatus(last);
        batch.forEach(applyDialog);
        for (const ev of batch) fillFrom(sessionId, ev);
      };
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // A message was taken out of the conversation: drop what it covered,
        // rather than reloading everything to find out what is left. While the
        // replay is still being gathered that buffer is where they are, so it
        // is filtered instead of the rendered list.
        if (ev.type === "portal_removed") {
          // What arrived before it is in the list it filters.
          drain();
          // `also` and `kept`: messages sent into a run go with the stretch the
          // agent read them in, not the one whose seq range they were sent in.
          const { from, to, also = [], kept = [], reloads: now } = ev.payload as { from: number; to: number | null; also?: number[]; kept?: number[]; reloads?: number };
          // Heard, so not missed: the count this brings is not a reason to load again.
          if (now !== undefined) reloads = now;
          const covered = (at: number) =>
            also.includes(at) || (at >= from && (to == null || at < to) && !kept.includes(at));
          if (replay) replay = replay.filter((e) => !covered(e.seq));
          else setEvents((prev) => prev.filter((e) => !covered(e.seq)));
          return;
        }
        // Another version of a message was brought back, or an edit undone:
        // events came back under seqs this stream has read past, so it reads
        // the chat again from the start.
        if (ev.type === "portal_versions") {
          setVersions((ev.payload as { versions: Record<number, number[]> }).versions);
          return;
        }
        if (ev.type === "portal_reload") {
          reloads = (ev.payload as { reloads?: number }).reloads ?? reloads;
          drain();
          reload();
          return;
        }
        // An extension to what its browser half drew in this chat: theirs, and nothing of the conversation.
        if (ev.type === "portal_extension_ui") {
          const { extension, data } = ev.payload as { extension: string; data: unknown };
          extensionMessage(sessionId, extension, data);
          return;
        }
        // Live-only events (dialogs) use a negative seq and must not move the
        // resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        if (replay) {
          replay.push(ev);
          return;
        }
        pending.push(ev);
        soon();
        applyStatus(ev);
        applyDialog(ev);
        fillFrom(sessionId, ev);
      };
      es.addEventListener("caught-up", () => {
        flush();
        setLoadedSession(sessionId);
        // Only now do we know where the replayed window starts, and therefore
        // whether the conversation continues above it.
        const asked = loadedAgain.current;
        setEvents((prev) => {
          const oldest = prev.find((e) => e.seq > 0)?.seq;
          if (oldest === undefined) return prev;
          api
            .olderEvents(sessionId, oldest, 1)
            // The answer for a chat that was left, or one loaded again since, says nothing of the one shown now.
            .then((r) => asked === loadedAgain.current && setMoreBefore(r.events.length > 0))
            .catch(() => {});
          return prev;
        });
      });
      es.onerror = () => {
        drain();
        // Keep what arrived: the resume cursor has already moved past it.
        // Unless the chat is being read again: part of it would replace all
        // of what is shown, so that stays, and the reading starts over.
        if (replacing) {
          replay = null;
          seq = 0;
        } else flush();
        es.close();
        failed += 1;
        setFailures(failed);
        retry = setTimeout(connect, reconnectDelay(failed));
      };
    };
    connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      esRef.current?.close();
      setChatOnScreen(undefined);
    };
  }, [sessionId, missing, refreshSessions]);

  const listed = sessions.find((s) => s.id === sessionId) ?? null;

  useEffect(() => {
    if (!sessionId || listed || missing === sessionId) return setOther(null);
    let cancelled = false;
    const load = () =>
      api
        .session(sessionId)
        .then((s) => !cancelled && setOther((prev) => reconcile(prev, s)))
        .catch((e) => {
          if (cancelled) return;
          setOther(null);
          // Said by the portal: it has no such chat, which is not an outage to keep retrying.
          if (e instanceof ApiError && e.status === 404) setMissing(sessionId);
        });
    load();
    // The same five seconds the task list gets. Events keep this current
    // between ticks; the poll is what stops a dropped one from stranding the
    // session on a status it left long ago.
    const stop = pollWhileVisible(load, 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [sessionId, listed, missing]);

  const active = listed ?? (other?.id === sessionId ? other : null);

  // The page that is left plays out as a picture of itself over the one that
  // comes (see motion.ts). Taken here, while what is on the page is still the
  // page that was drawn, and put on it once the next one is. A chat to another
  // chat is the same page: only its conversation goes. A chat that was
  // deleted dissolves, and the empty page it is left on for a moment does not.
  const main = useRef<HTMLElement>(null);
  /** The chats the list had when it was last drawn. */
  const knownIds = useRef(new Set<string>());
  useEffect(() => {
    knownIds.current = new Set(sessions.map((s) => s.id));
  }, [sessions]);
  const pageKey = view === "chat" ? `chat:${active?.id ?? ""}` : view;
  const leaving = useRef<{ key: string; leave: ((how: Leave) => void) | null; how: Leave }>({ key: pageKey, leave: null, how: "page" });
  if (leaving.current.key !== pageKey) {
    const was = leaving.current.key;
    const page = main.current?.lastElementChild as HTMLElement | null | undefined;
    const chats = was.startsWith("chat:") && pageKey.startsWith("chat:");
    // Gone from the list it was in: not one the list never has (an agent's or a routine's chat is opened by its address).
    const deleted = was.startsWith("chat:") && knownIds.current.has(was.slice(5)) && !sessions.some((s) => s.id === was.slice(5));
    leaving.current = {
      key: pageKey,
      leave: was === "chat:" ? null : keep((chats && page?.querySelector<HTMLElement>("[data-transcript]")) || page || null),
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

  // What the tab says while you are looking at something else, and — if you
  // asked for them — a notification when a chat you left running is done.
  const waiting = Boolean(active && uiQueue[0]);
  const lang = useLanguage();
  useEffect(() => {
    document.title = tabTitle(active ? { title: active.title, status: active.status } : null, waiting);
    return () => {
      document.title = APP_NAME;
    };
  }, [active?.title, active?.status, waiting, lang]);

  // The list stops being polled while the page is hidden, but a chat left
  // running there can only be seen finishing through it — the open one has its
  // stream, the rest do not. So while someone asked to be told and something
  // is running, a hidden page keeps asking, more slowly.
  const anyRunning = sessions.some((s) => s.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      if (document.hidden && notifyState() === "on") refreshSessions().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [anyRunning, refreshSessions]);

  const lastStatus = useRef(new Map<string, SessionStatus>());
  useEffect(() => {
    for (const s of finishedRuns(lastStatus.current, sessions)) {
      notifyIfAway(s.title, s.status === "error" ? t("Stopped with an error") : t("Finished"), s.id, () =>
        navigate(`/s/${s.id}`),
      );
    }
    lastStatus.current = new Map(sessions.map((s) => [s.id, s.status]));
  }, [sessions]);

  const askedId = active ? uiQueue[0]?.id : undefined;
  useEffect(() => {
    if (!active || !askedId) return;
    notifyIfAway(active.title, t("Waiting for your answer"), `ask-${active.id}`, () => navigate(`/s/${active.id}`));
  }, [askedId]);

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
  const onDeleteChat = useStable(async (id: string) => {
    const gone = sessions.find((s) => s.id === id);
    // The chat open is this one, or one of its sub-chats, which go with it.
    // It need not be listed: a sub-chat an extension keeps out of the list is fetched by its id (`active`).
    const open = sessionId === id || active?.parent === id;
    await api.deleteSession(id);
    const list = await refreshSessions();
    // A sub-chat gone takes its page back to its chat, if that is listed; a chat gone, to the latest chat of its own.
    const parent = gone?.parent;
    const next = parent && sessions.some((s) => s.id === parent) ? parent : splitSubChats(list).top[0]?.id;
    if (open) navigate(next ? `/s/${next}` : "/", { replace: true });
  });
  const onRenameChat = useStable(async (id: string, title: string) => {
    await api.renameSession(id, title);
    refreshSessions();
  });
  const onPin = useStable(async (id: string, pinned: boolean) => {
    await api.pinSession(id, pinned);
    refreshSessions();
  });
  const onOpenSettings = useStable(() => navigate(sessionId ? `/s/${sessionId}/settings/general` : "/settings/general"));
  const openUpdate = useStable(() => navigate(sessionId ? `/s/${sessionId}/settings/about` : "/settings/about"));
  // Back to the page that opened Settings where it said which (`state.from`), else to the chat.
  const closeSettings = useStable(() => navigate((state as { from?: string } | null)?.from ?? (active ? `/s/${active.id}` : "/")));
  const setUpModel = useStable(() => {
    navigate(active ? `/s/${active.id}` : "/");
    setSetup(true);
  });
  // The sessions page: its own way of opening a chat, which does not close the drawer, and of renaming one.
  const openChat = useStable((id: string) => navigate(`/s/${id}`));
  const deleteListed = useStable(async (id: string) => {
    await api.deleteSession(id);
    await refreshSessions();
  });
  const renameListed = useStable(async (id: string, title: string) => {
    await api.renameSession(id, title);
    // Saved by now, and shown so, whether or not the list then loads:
    // a list that fails to load is not a rename that failed.
    setSessions((all) => all.map((s) => (s.id === id ? { ...s, title } : s)));
    await refreshSessions().catch(() => {});
  });

  return (
    <Here.Provider value={here}>
    <div data-fits-keyboard className="flex h-[calc(100dvh-var(--keyboard,0px))] min-h-0 overflow-hidden bg-canvas">
      {mobileNav && <button aria-label={t("Dismiss navigation")} onClick={() => setMobileNav(false)} className="ui-backdrop fixed inset-0 z-40 bg-black/50 md:hidden" />}
      <div
        id="mobile-navigation"
        ref={drawer}
        tabIndex={mobileNav ? -1 : undefined}
        role={mobileNav ? "dialog" : undefined}
        aria-modal={mobileNav ? true : undefined}
        aria-label={mobileNav ? t("Navigation") : undefined}
        className={`${mobileNav ? "mobile-drawer fixed inset-y-0 left-0 z-50 flex outline-none" : "hidden"} h-full shrink-0 md:static md:z-auto md:flex`}>
      {mobileNav && <button type="button" aria-label={t("Close navigation")} onClick={() => setMobileNav(false)} className="absolute right-2 top-3 z-20 rounded-lg p-2 text-fg md:hidden"><LuX size={20}/></button>}
      <Sidebar
        forceExpanded={mobileNav}
        sessions={sessions}
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
          <span className="truncate text-sm text-fg">{(extensionPage && titleOf(extensionPage)) || active?.title || "Pithagoras"}</span>
        </header>
        <UpdateNotice onDetails={openUpdate} />
        <ExtensionsLeftBehind />
        {error && <ErrorBanner className="mx-4 mt-2" onClose={() => setError(null)}>{error}</ErrorBanner>}
        {/* Not for the first miss: a server restarting, or a wifi that blinked,
            is back before it can be read. Two in a row is an outage. */}
        {sessionId && failures >= 2 && missing !== sessionId && (
          <div role="status" className="bg-warn/10 px-4 py-2 text-sm text-warn">
            {t("Lost the connection to the portal — trying again. What is shown may be out of date.")}
          </div>
        )}
        {/* One page failing to draw takes down that page, not the portal. */}
        <ErrorBoundary resetKey={`${view}:${sessionId ?? ""}`}>
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>}>
        {view === "sessions" ? (
          <SessionsPage
            sessions={sessions}
            places={places}
            onSelect={openChat}
            onNewChat={startChat}
            onDelete={deleteListed}
            onPin={onPin}
            onRename={renameListed}
          />
        ) : view === "projects" ? (
          <ProjectsPage
            sessions={sessions}
            onOpenChat={(id) => navigate(`/s/${id}`)}
            onNewChat={async (workspace) => {
              const s = await api.createSession(workspace);
              await refreshSessions();
              navigate(`/s/${s.id}`);
            }}
            onChanged={() => {
              refreshSessions();
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
            events={loadedSession === active.id ? events : []}
            loading={loadedSession !== active.id}
            hasEarlier={loadedSession === active.id && moreBefore}
            loadingEarlier={loadingBefore}
            onLoadEarlier={async () => {
              const oldest = events.find((e) => e.seq > 0)?.seq;
              if (!oldest || loadingBefore) return;
              setLoadingBefore(true);
              const asked = loadedAgain.current;
              try {
                const r = await api.olderEvents(active.id, oldest);
                // Loaded again, or another chat opened, meanwhile: what is above the new list is another question.
                if (asked !== loadedAgain.current) return;
                setEvents((prev) => [...r.events, ...prev]);
                setMoreBefore(r.more);
              } catch {
                // Leave the button where it is; trying again is free.
              } finally {
                // Not the flag of what was asked since: it was reset when the list was replaced, and may be set again.
                if (asked === loadedAgain.current) setLoadingBefore(false);
              }
            }}
            onSend={async (msg, options) => {
              await api.prompt(active.id, msg, options);
              refreshSessions();
            }}
            versions={versions}
            onEditMessage={async (seq, message) => {
              await api.editMessage(active.id, seq, message);
              refreshSessions();
            }}
            onDeleteMessage={async (seq) => {
              await api.deleteMessage(active.id, seq);
            }}
            onTakeBackQueued={async (seq) => {
              await api.takeBackQueued(active.id, seq);
            }}
            onSendQueuedNow={async (seq) => {
              await api.sendQueuedNow(active.id, seq);
              refreshSessions();
            }}
            onAbort={async () => {
              await api.abort(active.id);
              refreshSessions();
            }}
            onRename={async (title) => {
              await api.renameSession(active.id, title);
              await refreshSessions();
            }}
            onSetMode={async (mode, confirmed) => {
              await api.setMode(active.id, mode, confirmed);
              await refreshSessions();
            }}
            onOpenNavigation={() => setMobileNav(true)}
            parentTitle={active.parent ? sessions.find((s) => s.id === active.parent)?.title : undefined}
            onClientCommand={async (name, args) => {
              if (name === "settings") {
                navigate(`/s/${active.id}/settings/general`);
              } else if (name === "new" || name === "clear") {
                // A fresh chat in the same project, or in Home.
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
        ) : missing === sessionId ? (
          <GoneState onSessions={() => navigate("/sessions")} />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
        </Suspense>
        </ErrorBoundary>
      </main>

      {active && uiQueue[0] && (
        <ExtensionDialog
          // One dialog per question: what the last was answered, or failed with, is not this one's.
          key={uiQueue[0].id}
          sessionId={active.id}
          request={uiQueue[0]}
          onDone={() => setUiQueue((q) => q.slice(1))}
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
              const s = await api.createSession();
              await refreshSessions();
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
