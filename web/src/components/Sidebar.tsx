import { useState, type ReactNode } from "react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import {
  LuBot,
  LuClock,

  LuMessagesSquare,
  LuPin,
  LuPinOff,
  LuPlus,
  LuSettings,
  LuTrash2,
} from "react-icons/lu";
import type { Session, SessionStatus, Workspace } from "../api";

const STATUS_STYLE: Record<SessionStatus, string> = {
  running: "bg-accent animate-pulse",
  idle: "bg-fg-faint",
  error: "bg-danger",
  interrupted: "bg-warn",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "running",
  idle: "idle",
  error: "error",
  interrupted: "interrupted — server restarted mid-run",
};

/** How many unpinned sessions the sidebar shows before deferring to Sessions. */
const RECENTS_LIMIT = 12;

/** Mirrors the server's slugify so the preview matches what actually gets created. */
function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}

// Sentinel for the dropdown — a new workspace is the default choice.
const NEW = "__new__";

export function Sidebar({
  sessions,
  workspaces,
  executor,
  activeId,
  view,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onPin,
  onCreateWorkspace,
  onOpenSettings,
  onNavigate,
}: {
  sessions: Session[];
  workspaces: Workspace[];
  executor: string;
  activeId: string | null;
  /** Which top-level destination is showing, so the nav can mark it. */
  view: "chat" | "sessions" | "agent" | "routines";
  onSelect: (id: string) => void;
  onCreate: (workspacePath: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onCreateWorkspace: (name: string) => Promise<Workspace>;
  onOpenSettings: () => void;
  onNavigate: (to: "sessions" | "agent" | "routines") => void;
}) {
  const [creating, setCreating] = useState(false);
  const [choice, setChoice] = useState<string>(NEW);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const makingNew = choice === NEW;
  const slug = slugify(name);
  const canSubmit = makingNew ? slug.length > 0 : Boolean(choice);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      // Either branch produces a workspace path; the session takes its name
      // from that folder.
      const workspacePath = makingNew ? (await onCreateWorkspace(name.trim())).path : choice;
      await onCreate(workspacePath);
      setName("");
      setChoice(NEW);
      setCreating(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pinned = sessions.filter((s) => s.pinned);
  const recents = sessions.filter((s) => !s.pinned);
  const shownRecents = recents.slice(0, RECENTS_LIMIT);

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      session={s}
      active={activeId === s.id}
      onSelect={() => onSelect(s.id)}
      onRename={onRename}
      onDelete={onDelete}
      onPin={onPin}
    />
  );

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-3 pb-3 pt-4">
        <img
          src="/logo-192.png"
          alt=""
          className="h-6 w-6 shrink-0 object-contain"
          draggable={false}
        />
        <h1 className="text-sm font-semibold tracking-tight text-fg">Pithagoras</h1>
        <span
          className="ml-auto text-[10px] uppercase tracking-wider text-fg-faint"
          title="How sessions are executed"
        >
          {executor}
        </span>
      </div>

      {/* Destinations, above the session lists. */}
      <nav className="px-2 pb-2">
        <NavItem icon={<LuPlus />} label="New" onClick={() => setCreating((v) => !v)} active={creating} />
        <NavItem
          icon={<LuMessagesSquare />}
          label="Sessions"
          onClick={() => onNavigate("sessions")}
          active={view === "sessions"}
        />
        <NavItem
          icon={<LuBot />}
          label="Agent"
          onClick={() => onNavigate("agent")}
          active={view === "agent"}
        />
        <NavItem
          icon={<LuClock />}
          label="Routines"
          onClick={() => onNavigate("routines")}
          active={view === "routines"}
        />

        {creating && (
          <div className="mt-2 space-y-2 px-1">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="w-full rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-sm text-fg-muted"
            >
              <option value={NEW}>New workspace</option>
              {workspaces.length > 0 && (
                <optgroup label="Existing workspaces">
                  {workspaces.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.name}
                      {w.isGit ? " (git)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            {makingNew && (
              <div>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="Cool Project"
                  className="w-full rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-sm outline-none focus:border-accent/60"
                />
                {name.trim() && (
                  <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">
                    {slug ? `→ ${slug}` : "needs at least one letter or digit"}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}
            <button
              onClick={submit}
              disabled={busy || !canSubmit}
              className="w-full rounded-lg bg-accent/12 px-2 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Start session"}
            </button>
          </div>
        )}
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-fg-subtle">No sessions yet.</p>
        )}

        {pinned.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Pinned</GroupLabel>
            {pinned.map(item)}
          </>
        )}

        {shownRecents.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Recents</GroupLabel>
            {shownRecents.map(item)}
            {recents.length > shownRecents.length && (
              <button
                onClick={() => onNavigate("sessions")}
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
              >
                {recents.length - shownRecents.length} more…
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
              label="Settings"
              onClick={onOpenSettings}
              active={false}
            />
          </div>
          <ThemeSwitcher />
        </div>
      </div>
    </aside>
  );
}

const Divider = () => <div className="my-2 h-px bg-line" />;

const GroupLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
    {children}
  </p>
);

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        active ? "bg-fg/[0.07] text-fg" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
      }`}
    >
      <span
        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-accent transition-opacity ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <span className={`shrink-0 transition-colors ${active ? "text-accent" : "text-fg-faint group-hover:text-fg-subtle"}`}>
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
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group mb-0.5 cursor-pointer rounded-lg px-2.5 py-1.5 transition ${
        active ? "bg-fg/[0.07]" : "hover:bg-fg/5"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status]}`}
          title={STATUS_LABEL[s.status]}
        />
        <span
          className="truncate text-sm text-fg"
          onDoubleClick={(e) => {
            e.stopPropagation();
            const next = prompt("Rename session", s.title);
            if (next?.trim()) onRename(s.id, next.trim());
          }}
        >
          {s.title}
        </span>

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPin(s.id, !s.pinned);
            }}
            className="rounded p-1 text-fg-subtle hover:text-accent"
            title={s.pinned ? "Unpin" : "Pin"}
          >
            {s.pinned ? <LuPinOff className="h-3 w-3" /> : <LuPin className="h-3 w-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete "${s.title}"? This stops it if it is running.`)) {
                onDelete(s.id);
              }
            }}
            className="rounded p-1 text-fg-subtle hover:text-danger"
            title="Delete session"
          >
            <LuTrash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="truncate pl-4 text-[11px] text-fg-subtle">{s.workspace.split("/").pop()}</div>
    </div>
  );
}
