import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  LuBrain,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuCircleCheck,
  LuEraser,
  LuFilter,
  LuFileText,
  LuFolder,
  LuHistory,
  LuMessageCircle,
  LuPencil,
  LuRefreshCw,
  LuSearch,
  LuSquare,
  LuTrash2,
  LuTriangleAlert,
  LuWaypoints,
  LuX,
} from "react-icons/lu";
import {
  api,
  type MemoryChange,
  type MemoryConcept,
  type MemoryGraph,
  type MemoryHealth,
  type MemoryHit,
  type MemoryNode,
  type MemoryTrace,
  type MemoryTraceRun,
  type MemoryValidation,
} from "./api";
import { colours } from "./memory-graph";
import { colourFrom, SKY_THEMES, skyThemeFrom, type SkyTheme } from "./memory-sky";
import { MemorySky } from "./MemorySky";
import { pathOf, type TracePath } from "./memory-trace";
import { ColourPicker } from "./ColourPicker";
import { useDismiss } from "./use-dismiss";
import { applyChunk, eventReader, history, textOf, toolName, usedTools, type ChatMessage, type ToolPart, type Turn } from "./memory-chat";
import { NOTE_LINK, linkNotes } from "./memory-links";
import { forgetNoteDraft, forgetNoteDrafts, keepNoteDraft, readNoteDraft, type NoteDraft } from "./note-drafts";
import { formatTokens } from "./helpers";
import { Link, Markdown, Select, confirmDialog, formatDateTime, isApiError, local, msg, portal, settingsPage, t, tp, tx } from "../portal";

/** What the page shows in place of a note: the log of changes, the graph of links, the librarian chat, or what the health check found. */
type View = "log" | "graph" | "chat" | "issues";

/** The colour of each type of note, the same in the list, a note and the graph. */
const Colours = createContext<(type: string | undefined) => string>(colours([]));

const typesIn = (node: MemoryNode | null): string[] =>
  !node ? [] : [...(node.type ? [node.type] : []), ...(node.children ?? []).flatMap(typesIn)];

/** A note's type: its colour as a dot, its name in the page's own ink, readable on either theme. */
function TypeBadge({ type, className = "" }: { type: string; className?: string }) {
  const colourOf = useContext(Colours);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-muted ${className}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colourOf(type) }} />
      <span className="truncate">{type}</span>
    </span>
  );
}

/** The tree and its health check: the check failing is not the tree failing. */
const readTree = () => Promise.all([api.memoryTree(), api.memoryValidate().catch(() => null)]);

/**
 * The agent's memory in Understory, laid out as Understory's own page lays it
 * out: its folders and notes with a search down the side, and a note, the log
 * of changes or the graph of links beside them. Read only — the agent keeps
 * its memory, through its tools. Everything is asked through the server half
 * (src/server/memory.ts), so it works wherever the portal does.
 *
 * What is open is in the address: `?note=<path>`, or `?view=log|graph|issues`,
 * so it can be linked to and Back goes back through it.
 */
export function MemoryPage() {
  portal.locale.use();
  const { ui } = portal;
  const { path: here, search } = portal.useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  /** The page with this query in its address: a step of its own in the history, so that Back goes back through it. */
  const setParams = (next: Record<string, string>) => {
    const query = new URLSearchParams(next).toString();
    portal.navigate(query ? `${here}?${query}` : here);
  };
  const note = params.get("note");
  const asView = params.get("view");
  const view: View | null = asView === "log" || asView === "graph" || asView === "chat" || asView === "issues" ? asView : null;
  // Whether the open note is being edited, with something changed in it: it is told by the note.
  const [editing, setEditing] = useState(false);
  /**
   * Said before what is open is left by one of the page's own buttons. Back and
   * Forward, and the links to other pages, cannot be asked: the note keeps its
   * edit for those, and brings it back when it is opened again.
   */
  const settled = async () => {
    if (!editing) return true;
    const ok = await confirmDialog({ title: t("Discard your changes?"), message: t("The note you are editing has changes that are not saved."), confirmLabel: t("Discard"), danger: true });
    // Given up on purpose: nothing is to be brought back when the note is opened again.
    if (ok && note) forgetNoteDraft(note);
    return ok;
  };
  const openNote = async (path: string) => {
    if (path !== note && (await settled())) setParams({ note: path });
  };
  const openView = async (v: View) => {
    if (await settled()) setParams({ view: v });
  };
  const close = async () => {
    if (await settled()) setParams({});
  };
  // A reload of the page, or leaving it, is asked about by the browser.
  useEffect(() => {
    if (!editing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing]);

  const [tree, setTree] = useState<MemoryNode | null>(null);
  const [validation, setValidation] = useState<MemoryValidation | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by the refresh button: what is open reads itself again.
  const [round, setRound] = useState(0);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  // Apart from `failed`, which a search must not set: nothing takes that back until the whole tree is read again.
  const [searchFailed, setSearchFailed] = useState<string | null>(null);

  // Whether notes can be changed here, and what the last change left behind.
  const [writable, setWritable] = useState(false);
  const [after, setAfter] = useState<{ what: "saved" | "deleted"; health: MemoryHealth } | null>(null);
  useEffect(() => {
    api.memoryHealth().then((r) => setWritable(r.writable), () => {});
  }, []);

  /** Reads what a change moved — the tree, the counts, what a search finds — without leaving what is open. */
  const refresh = () => {
    readTree().then(([t, v]) => {
      setTree(t);
      setValidation(v);
    }, () => {});
    if (asked) api.memorySearch(asked).then(setHits, () => {});
  };
  // The librarian chat lives here, not in its view: it goes on while a note is open, and is there again when the view is.
  const librarian = useLibrarian((changed) => changed && refresh());
  const [wiping, setWiping] = useState(false);
  /** The memory from nothing, after asking. */
  const wipe = async () => {
    const ok = await confirmDialog({
      title: t("Clear the whole memory?"),
      message: t("Every note and folder is deleted, and the index and log start empty, as in a new memory. The agent forgets everything it kept here. This cannot be undone."),
      confirmLabel: t("Clear the memory"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    setWiping(true);
    try {
      await api.wipeMemory();
      forgetNoteDrafts();
      setParams({});
      // Nothing found is left to show: what it found is gone.
      setQuery("");
      load();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setWiping(false);
    }
  };

  const changed = (what: "saved" | "deleted", health: MemoryHealth) => {
    // A deleted note is not there to show any more.
    if (what === "deleted") setParams({});
    refresh();
    setAfter({ what, health });
  };

  const load = () => {
    setLoading(true);
    setFailed(null);
    setRound((r) => r + 1);
    readTree()
      .then(([t, v]) => {
        setTree(t);
        setValidation(v);
      })
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Asked a moment after the last key, not on every one; the latest asked is what shows.
  useEffect(() => {
    const t = setTimeout(() => setAsked(query.trim()), query ? 300 : 0);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    // A new question is not the old one's failure.
    setSearchFailed(null);
    if (!asked) {
      setHits(null);
      return;
    }
    let current = true;
    api.memorySearch(asked).then(
      (found) => current && setHits(found),
      (e: Error) => current && setSearchFailed(e.message),
    );
    return () => {
      current = false;
    };
  }, [asked]);

  const palette = useMemo(() => colours(typesIn(tree)), [tree]);
  // The graph's own state, kept while a note is open: the note last opened is the one it lights, and what its filter hides stays hidden.
  const [chosen, setChosen] = useState<string | null>(note);
  useEffect(() => {
    if (note) setChosen(note);
  }, [note]);
  const [hiddenTypes, setHiddenTypes] = useState<Hidden>(() => new Set());
  const found = useMemo(() => (hits ? new Set(hits.map((h) => h.path)) : null), [hits]);

  if (failed && !tree) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-dashed border-line px-6 py-8 text-center">
          <LuBrain className="mx-auto h-6 w-6 text-fg-faint" />
          <p className="mt-3 text-sm text-fg-muted">{t("The memory could not be read.")}</p>
          <p className="mt-2 text-xs text-fg-faint">{failed}</p>
          <div className="mt-4 flex items-center justify-center gap-4 text-xs">
            <button type="button" onClick={load} className="text-accent hover:underline">
              {t("Try again")}
            </button>
            <Link to={settingsPage()} className="text-accent hover:underline">
              {t("Settings → Memory")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const open = Boolean(note || view);
  return (
    <Colours.Provider value={palette}>
      <div className="flex h-full min-h-0">
        {/* On a phone, the side or what is open: one at a time. */}
        <aside aria-label={t("Memory")} className={`${open ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-line md:w-72`}>
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            <LuBrain className="h-4 w-4 text-accent" />
            <h1 className="text-sm font-medium text-fg">{t("Memory")}</h1>
            {validation && (
              <button
                type="button"
                onClick={() => openView("issues")}
                title={validation.conformant ? t("The bundle is well-formed") : tp(validation.issues.length, "{n} issue in the bundle", "{n} issues in the bundle")}
                className={`rounded px-1.5 py-0.5 text-[10px] ${validation.conformant ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}
              >
                {validation.conformant ? t("conformant") : tp(validation.issues.length, "{n} issue", "{n} issues")}
              </button>
            )}
            {writable && (
              <button
                type="button"
                onClick={() => void wipe()}
                disabled={loading || wiping}
                aria-label={t("Clear the memory")}
                title={t("Clear the memory: every note, and an empty index and log")}
                className="ml-auto rounded p-1.5 text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
              >
                {wiping ? <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={async () => (await settled()) && load()}
              disabled={loading}
              aria-label={t("Read the memory again")}
              title={t("Read the memory again")}
              className={`${writable ? "" : "ml-auto "}rounded p-1.5 text-fg-subtle transition hover:bg-fg/5 hover:text-fg disabled:opacity-40`}
            >
              <LuRefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="relative px-3">
            <LuSearch className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search…")}
              aria-label={t("Search the memory")}
              className={`w-full rounded-lg border border-line bg-raised/60 py-1.5 pl-8 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60 ${query ? "pr-8" : "pr-3"}`}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("Clear the search")}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-1 text-fg-faint hover:text-fg"
              >
                <LuX className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {failed && tree && <p role="alert" className="px-3 pt-2 text-xs text-warn">{failed}</p>}
          {searchFailed && <p role="alert" className="px-3 pt-2 text-xs text-warn">{searchFailed}</p>}
          <nav aria-label={t("Notes")} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {hits ? (
              <Hits hits={hits} asked={asked} open={note} onOpen={openNote} />
            ) : !tree ? (
              <ui.SkeletonGroup className="space-y-1.5 px-1" label={t("Loading the memory")}>
                {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-6 w-full" />)}
              </ui.SkeletonGroup>
            ) : !tree.children?.length ? (
              <p className="px-2 py-6 text-center text-xs text-fg-subtle">{t("Nothing is in the memory yet. The agent adds to it as it learns.")}</p>
            ) : (
              <ul className="space-y-0.5">
                {tree.children.map((n) => (
                  <TreeNode key={n.path} node={n} depth={0} open={note} onOpen={openNote} />
                ))}
              </ul>
            )}
          </nav>
          <div className={`grid border-t border-line ${writable ? "grid-cols-3" : "grid-cols-2"}`}>
            {(writable ? (["chat", "log", "graph"] as const) : (["log", "graph"] as const)).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => (view === v ? close() : openView(v))}
                aria-pressed={view === v}
                className={`flex items-center justify-center gap-1.5 py-2.5 text-xs transition ${
                  view === v ? "bg-accent/10 text-accent" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
                }`}
              >
                {v === "chat" ? <LuMessageCircle className="h-3.5 w-3.5" /> : v === "log" ? <LuHistory className="h-3.5 w-3.5" /> : <LuWaypoints className="h-3.5 w-3.5" />}
                {v === "chat" ? t("Librarian") : v === "log" ? t("Log") : t("Graph")}
              </button>
            ))}
          </div>
        </aside>

        <main className={`${open ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
          {note ? (
            <Note key={`${note}#${round}`} path={note} writable={writable} onOpen={openNote} onBack={close} onChanged={changed} onEditing={setEditing} />
          ) : view === "log" ? (
            <LogView key={round} writable={writable} onOpen={openNote} onBack={close} onCleared={refresh} />
          ) : view === "graph" ? (
            <GraphView key={round} onOpen={openNote} onBack={close} selected={chosen} onSelect={setChosen} hidden={hiddenTypes} onHide={setHiddenTypes} found={found} />
          ) : view === "chat" && writable ? (
            <LibrarianView chat={librarian} onOpen={openNote} onBack={close} />
          ) : view === "issues" ? (
            <Issues validation={validation} onOpen={openNote} onBack={close} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-fg-subtle">
              <div>
                <p>{t("Choose a note, or open the log or the graph.")}</p>
                {validation?.conceptCount !== undefined && (
                  <p className="mt-1 text-xs text-fg-faint">
                    {t("{notes} in {folders}", { notes: tp(validation.conceptCount, "{n} note", "{n} notes"), folders: tp(validation.directoryCount ?? 0, "{n} folder", "{n} folders") })}
                  </p>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      {after && <AfterChange what={after.what} health={after.health} onOpen={openNote} onClose={() => setAfter(null)} onRefresh={refresh} />}
    </Colours.Provider>
  );
}

/** A heading over what is open, with the way back on a phone. */
function Bar({ title, onBack, children }: { title: ReactNode; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <button type="button" onClick={onBack} aria-label={t("Back to the notes")} className="-ml-1 rounded p-1 text-fg-subtle hover:text-fg md:hidden">
        <LuChevronLeft className="h-4 w-4" />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h2>
      {children}
    </div>
  );
}

const countNotes = (node: MemoryNode): number =>
  node.kind === "concept" ? 1 : (node.children ?? []).reduce((n, c) => n + countNotes(c), 0);

function TreeNode({ node, depth, open, onOpen }: { node: MemoryNode; depth: number; open: string | null; onOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const pad = { paddingLeft: `${0.5 + depth * 0.875}rem` };
  if (node.kind === "directory") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          style={pad}
          className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs text-fg-muted transition hover:bg-fg/5"
        >
          {expanded ? <LuChevronDown className="h-3 w-3 shrink-0" /> : <LuChevronRight className="h-3 w-3 shrink-0" />}
          <LuFolder className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <span className="min-w-0 flex-1 truncate">{node.name}/</span>
          <span className="shrink-0 text-[10px] text-fg-faint">{countNotes(node)}</span>
        </button>
        {expanded && (
          <ul className="space-y-0.5">
            {(node.children ?? []).map((c) => (
              <TreeNode key={c.path} node={c} depth={depth + 1} open={open} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const here = open === node.path;
  // Understory's own index and log are files too, set apart as its page sets them.
  const reserved = node.kind === "reserved";
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        aria-current={here ? "page" : undefined}
        title={node.description ?? node.path}
        style={pad}
        className={`flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs transition ${
          here ? "bg-accent/12 text-accent" : reserved ? "text-fg-faint hover:bg-fg/5" : "text-fg hover:bg-fg/5"
        }`}
      >
        <span className="w-3 shrink-0" />
        <LuFileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className={`min-w-0 flex-1 truncate ${reserved ? "italic" : ""}`}>{node.title || node.name}</span>
        {node.type && <TypeBadge type={node.type} className="max-w-[45%] shrink-0" />}
      </button>
    </li>
  );
}

function Hits({ hits, asked, open, onOpen }: { hits: MemoryHit[]; asked: string; open: string | null; onOpen: (path: string) => void }) {
  if (!hits.length) return <p className="px-2 py-6 text-center text-xs text-fg-subtle">{t("Nothing in the memory matches “{query}”.", { query: asked })}</p>;
  return (
    <ul aria-label={t("Found in the memory")} className="space-y-1">
      {hits.map((h) => (
        <li key={h.path}>
          <button
            type="button"
            onClick={() => onOpen(h.path)}
            aria-current={open === h.path ? "page" : undefined}
            className={`w-full rounded-lg px-2.5 py-2 text-left transition ${open === h.path ? "bg-accent/12" : "hover:bg-fg/5"}`}
          >
            <p className={`truncate text-xs ${open === h.path ? "text-accent" : "text-fg"}`}>{h.title || h.path}</p>
            {(h.description || h.snippet) && <p className="mt-0.5 line-clamp-2 text-[11px] text-fg-faint">{h.description || h.snippet}</p>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Markdown from the memory. A link to another of its notes opens it here;
 * one to the web opens in a tab of its own.
 */
function MemoryMarkdown({ text, from, onOpen }: { text: string; from: string; onOpen: (path: string) => void }) {
  const opener = useRef(onOpen);
  opener.current = onOpen;
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) =>
        href?.startsWith(NOTE_LINK) ? (
          <a
            href={href}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              opener.current(decodeURIComponent(href.slice(NOTE_LINK.length)));
            }}
            className="text-accent hover:underline"
          >
            {children}
          </a>
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {children}
          </a>
        ),
    }),
    [],
  );
  const linked = useMemo(() => linkNotes(text, from), [text, from]);
  return <Markdown components={components}>{linked}</Markdown>;
}

/** Understory's own index and log: written by it, never by hand. */
const reservedNote = (path: string) => /(^|\/)(index|log)\.md$/.test(path);

/** The draft of a note as it starts, from the note as it is. */
const startedFrom = (c: MemoryConcept): NoteDraft => ({
  title: String(c.frontmatter?.title ?? ""),
  type: String(c.frontmatter?.type ?? ""),
  description: String(c.frontmatter?.description ?? ""),
  tags: (Array.isArray(c.frontmatter?.tags) ? c.frontmatter.tags : []).map(String).join(", "),
  body: c.body,
});

/** A note as an edit of it says it, for the form to be shown over a note that is no longer there. */
const conceptOf = (path: string, d: NoteDraft): MemoryConcept => ({
  path,
  frontmatter: { title: d.title, type: d.type, description: d.description, tags: d.tags.split(",").map((x) => x.trim()).filter(Boolean) },
  body: d.body,
});

/** What a draft is started from: the note's words, and the time Understory wrote them, which it sets on every write. */
// The body without the newlines it ends in: the file a save writes ends in one that the answer to the save does not have.
const baseOf = (c: MemoryConcept): string => JSON.stringify([{ ...startedFrom(c), body: c.body.replace(/\n+$/, "") }, c.frontmatter?.timestamp ?? null]);

/** What a note's form holds while it is edited. */
function Note({
  path,
  writable,
  onOpen,
  onBack,
  onChanged,
  onEditing,
}: {
  path: string;
  writable: boolean;
  onOpen: (path: string) => void;
  onBack: () => void;
  /** After it was saved or deleted, with what Understory said of the memory then. */
  onChanged: (what: "saved" | "deleted", health: MemoryHealth) => void;
  /** Whether a draft with something changed in it is open: what the page asks about before it leaves. */
  onEditing: (editing: boolean) => void;
}) {
  const { ui } = portal;
  const { input: inputCls, codeArea: codeAreaCls, primarySmall: primarySmCls } = ui.classes;
  const [concept, setConcept] = useState<MemoryConcept | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  // What the draft was started from, and whether the note is something else by now.
  const [base, setBase] = useState("");
  const [changed, setChanged] = useState(false);
  // The note is not there any more, rather than written differently.
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the read said when the note was gone and only an edit it was left with is shown: giving the edit up goes back to that.
  const missing = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    missing.current = null;
    api.memoryConcept(path).then(
      (c) => {
        if (!current) return;
        setConcept(c);
        // The edit this note was left with, if the page was taken away from it. The note may have been
        // written meanwhile, by the agent: said, before a save puts the old text over what it learnt.
        const left = readNoteDraft(path);
        if (left) {
          setDraft(left.draft);
          setBase(left.base);
          setChanged(left.base !== baseOf(c));
        }
      },
      (e: Error) => {
        if (!current) return;
        // Deleted while the page was away from it, and an edit was left on it: the edit is not lost with the
        // note. It is shown as one over a note that was deleted, and "Save mine anyway" writes the note again.
        const left = isApiError(e) && e.status === 404 ? readNoteDraft(path) : null;
        if (!left) return setFailed(e.message);
        missing.current = e.message;
        setConcept(conceptOf(path, left.draft));
        setDraft(left.draft);
        setBase(left.base);
        setGone(true);
        setChanged(true);
      },
    );
    return () => {
      current = false;
    };
  }, [path]);
  const f = concept?.frontmatter;
  const when = typeof f?.timestamp === "string" ? new Date(f.timestamp) : null;
  const title = f?.title || path.split("/").pop();
  const canChange = writable && !reservedNote(path) && !!concept;

  const edit = () => {
    if (!concept) return;
    setDraft(startedFrom(concept));
    setBase(baseOf(concept));
  };
  // One over a note that is gone is the only copy of it, whatever the note it was started from says.
  const changedDraft = !!draft && !!concept && (gone || JSON.stringify(draft) !== JSON.stringify(startedFrom(concept)));
  useEffect(() => {
    onEditing(changedDraft);
    return () => onEditing(false);
  }, [changedDraft]);
  // Kept as it changes, for a note that goes away with it: Back, Forward, another page. Not before the note is read, which is when a draft left earlier is brought back.
  useEffect(() => {
    if (!draft || !concept) return;
    if (changedDraft) keepNoteDraft(path, draft, base);
    else forgetNoteDraft(path);
  }, [path, draft, concept, changedDraft, base]);
  /** The edit is over, saved or not: nothing of it is to come back. */
  const endEdit = () => {
    setDraft(null);
    setChanged(false);
    setGone(false);
    forgetNoteDraft(path);
  };
  /** Cancel: over a note that is gone, what the edit stood in for is not there to be shown. */
  const cancelEdit = () => {
    endEdit();
    if (missing.current === null) return;
    setConcept(null);
    setFailed(missing.current);
    missing.current = null;
  };

  /** `anyway` puts the draft over a note that changed since it was started, as the person was told it would. */
  const save = async (anyway = false) => {
    if (!draft || !concept) return;
    setBusy(true);
    setError(null);
    try {
      let now = concept;
      if (!anyway) {
        // Read again: the agent may have written the note since the edit began, and nothing else would say so.
        try {
          now = await api.memoryConcept(path);
        } catch (e) {
          // Deleted meanwhile: the edit is not lost with it, and "Save mine anyway" writes the note again.
          if (!(isApiError(e) && e.status === 404)) throw e;
          // Given up, the edit goes back to what the read said: the note is not there to be shown.
          missing.current = e.message;
          setGone(true);
          setChanged(true);
          return;
        }
        // It is there: written again since it was found gone, or never gone.
        missing.current = null;
        setGone(false);
        if (baseOf(now) !== base) {
          missing.current = null;
          setConcept(now);
          setChanged(true);
          return;
        }
      }
      const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
      // Whatever else its frontmatter says is kept as it was; Understory sets the time.
      const { timestamp: _t, ...rest } = now.frontmatter;
      const frontmatter = { ...rest, title: draft.title.trim(), type: draft.type.trim(), description: draft.description.trim(), ...(tags.length ? { tags } : {}) };
      if (!tags.length) delete (frontmatter as Record<string, unknown>).tags;
      const r = await api.saveMemoryNote(path, frontmatter, draft.body);
      // As a read has it, which the answer to the write is not quite: the file it made ends in a newline
      // the answer does not, and the next edit is compared with what is read.
      setConcept(await api.memoryConcept(path).catch(() => r.concept));
      missing.current = null;
      endEdit();
      onChanged("saved", r.health);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t("Delete “{name}”?", { name: title ?? "" }),
      message: t("It is gone from the memory, and the agent no longer knows it. Links to it from other notes then lead nowhere."),
      confirmLabel: t("Delete"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.deleteMemoryNote(path);
      onChanged("deleted", r.health);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Bar title={title} onBack={onBack}>
        {canChange && !draft && (
          <>
            <button type="button" onClick={edit} disabled={busy} aria-label={t("Edit the note")} title={t("Edit")} className="rounded p-1.5 text-fg-subtle transition hover:bg-fg/5 hover:text-fg disabled:opacity-40">
              <LuPencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} aria-label={t("Delete the note")} title={t("Delete")} className="rounded p-1.5 text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40">
              <LuTrash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </Bar>
      <article aria-label={title} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          {changed && draft && (
            <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
              <span className="min-w-0 flex-1">{gone ? t("This note was deleted after you started editing it.") : t("This note changed after you started editing it.")}</span>
              {!gone && (
                <button type="button" onClick={endEdit} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                  {t("Load the new version")}
                </button>
              )}
              <button type="button" onClick={() => void save(true)} disabled={busy} className="rounded px-1.5 py-0.5 underline hover:text-fg disabled:opacity-40">
                {t("Save mine anyway")}
              </button>
            </div>
          )}
          {failed ? (
            <p role="alert" className="text-sm text-warn">{failed}</p>
          ) : !concept ? (
            <ui.SkeletonGroup className="space-y-2" label={t("Loading the note")}>
              <div className="skeleton h-24 w-full" />
              <div className="skeleton h-40 w-full" />
            </ui.SkeletonGroup>
          ) : draft ? (
            <form
              aria-label={t("Edit the note")}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-fg-muted">
                  {t("Title")}
                  <input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={`${inputCls} mt-1`} />
                </label>
                <label className="block text-xs text-fg-muted">
                  {t("Type")}
                  <input required value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className={`${inputCls} mt-1`} />
                </label>
              </div>
              <label className="block text-xs text-fg-muted">
                {t("Description")}
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inputCls} mt-1`} />
              </label>
              <label className="block text-xs text-fg-muted">
                {t("Tags, separated by commas")}
                <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} className={`${inputCls} mt-1`} />
              </label>
              <label className="block text-xs text-fg-muted">
                {t("Text, in markdown")}
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={16}
                  spellCheck={false}
                  className={`${codeAreaCls} mt-1 resize-y`}
                />
              </label>
              <p className="font-mono text-[10px] text-fg-faint">{path}</p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={cancelEdit} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5">
                  {t("Cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy || !draft.title.trim() || !draft.type.trim()}
                  className={primarySmCls}
                >
                  {busy && <LuRefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {t("Save")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <header className="rounded-xl border border-line bg-raised/40 p-4">
                {(f?.type || (Array.isArray(f?.tags) && f.tags.length) || when) && (
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    {f?.type && <TypeBadge type={f.type} className="text-[11px]" />}
                    {(Array.isArray(f?.tags) ? f.tags : []).map((t) => (
                      <span key={String(t)} className="rounded bg-fg/5 px-1.5 py-0.5 text-fg-subtle">
                        #{String(t)}
                      </span>
                    ))}
                    {when && !Number.isNaN(when.getTime()) && <span className="ml-auto text-fg-faint">{formatDateTime(when)}</span>}
                  </p>
                )}
                <h3 className="mt-2 text-lg font-semibold text-fg">{title}</h3>
                {f?.description && <p className="mt-1 text-sm text-fg-muted">{f.description}</p>}
                <p className="mt-2 font-mono text-[10px] text-fg-faint">{path}</p>
              </header>
              <div className="md prose prose-sm mt-4 max-w-none text-sm text-fg">
                <MemoryMarkdown text={concept.body} from={path} onOpen={onOpen} />
              </div>
            </>
          )}
        </div>
      </article>
    </>
  );
}

/**
 * After a note was changed or deleted by hand: what Understory says the
 * memory looks like now, and the two ways to put it right — its indexes
 * written anew (no model), or its own pass over the whole memory with the
 * model, which also mends links and wires in what nothing links to.
 */
function AfterChange({
  what,
  health: first,
  onOpen,
  onClose,
  onRefresh,
}: {
  what: "saved" | "deleted";
  health: MemoryHealth;
  onOpen: (path: string) => void;
  onClose: () => void;
  /** The memory changed again: the page reads it anew. */
  onRefresh: () => void;
}) {
  const { ui } = portal;
  const primarySmCls = ui.classes.primarySmall;
  const [health, setHealth] = useState(first);
  const [busy, setBusy] = useState<string | null>(null);
  // What came of it, said in the language shown when it is drawn.
  const [said, setSaid] = useState<(() => string) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (what: string, run: () => Promise<() => string>) => {
    setBusy(what);
    setError(null);
    setSaid(null);
    try {
      const came = await run();
      setSaid(() => came);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reindex = () =>
    act(msg("Writing the indexes anew…"), async () => {
      const r = await api.reindexMemory();
      setHealth(r.health);
      return () => {
        const written = tp(r.reindexed, "{n} index written anew", "{n} indexes written anew");
        return r.pruned.length ? `${written}, ${tp(r.pruned.length, "{n} empty folder removed", "{n} empty folders removed")}.` : `${written}.`;
      };
    });
  // What the model said it did, whole, beside the one line.
  const [told, setTold] = useState<string | null>(null);
  const repair = () =>
    act(msg("Repairing with the model — this takes as long as the model needs…"), async () => {
      setTold(null);
      const r = await api.repairMemory();
      setHealth(r.health);
      if (!r.ran) return () => t("Nothing for the model to repair.");
      if (r.summary) setTold(r.summary);
      return () => tp(r.filesChanged?.length ?? 0, "The model changed {n} file.", "The model changed {n} files.");
    });
  const nothingToRepair = health.brokenLinks.length === 0 && health.orphans.length === 0;

  const open = (path: string) => {
    onOpen(path);
    onClose();
  };
  const problems = health.brokenLinks.length + health.orphans.length + health.issues.length;
  return (
    <ui.Modal
      title={what === "deleted" ? t("The note is deleted") : t("The note is saved")}
      subtitle={t("Understory has updated its index and log. Check what the change left behind.")}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy !== null} className="mr-auto rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5">
            {t("Leave it")}
          </button>
          <button
            type="button"
            onClick={() => void reindex()}
            disabled={busy !== null}
            className="rounded-lg bg-fg/5 px-3 py-1.5 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40"
          >
            {t("Rebuild the index")}
          </button>
          <button
            type="button"
            onClick={() => void repair()}
            disabled={busy !== null || nothingToRepair}
            title={nothingToRepair ? t("No links to nothing and no notes nothing links to: nothing for the model to do") : undefined}
            className={primarySmCls}
          >
            {t("Repair with the model")}
          </button>
        </div>
      }
    >
      <div role="status" className="space-y-3 text-sm">
        {problems === 0 ? (
          <p className="flex items-center gap-2 text-ok">
            <LuCircleCheck className="h-4 w-4 shrink-0" /> {t("Every link leads somewhere and every note is linked in.")}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-warn">
            <LuTriangleAlert className="h-4 w-4 shrink-0" /> {tp(problems, "The memory has {n} thing to put right.", "The memory has {n} things to put right.")}
          </p>
        )}
        {health.brokenLinks.length > 0 && (
          <section>
            <h4 className="text-xs font-medium text-fg-muted">{t("Links to nothing")}</h4>
            <ul className="mt-1 space-y-1 text-xs">
              {health.brokenLinks.map((b, i) => (
                <li key={i}>
                  <button type="button" onClick={() => open(b.path)} className="font-mono text-accent hover:underline">
                    {b.path}
                  </button>{" "}
                  → <span className="font-mono text-fg-subtle">{b.target}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {health.orphans.length > 0 && (
          <section>
            <h4 className="text-xs font-medium text-fg-muted">{t("Notes nothing links to")}</h4>
            <ul className="mt-1 space-y-1 text-xs">
              {health.orphans.map((o) => (
                <li key={o.path}>
                  <button type="button" onClick={() => open(o.path)} className="text-accent hover:underline">
                    {o.title || o.path}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {health.issues.length > 0 && (
          <section>
            <h4 className="text-xs font-medium text-fg-muted">{t("Against the format")}</h4>
            <ul className="mt-1 space-y-1 text-xs">
              {health.issues.map((issue, i) => (
                <li key={i}>
                  <span className="font-mono text-fg-subtle">{issue.path}</span> — {issue.message}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-xs text-fg-faint">
          {tx("{rebuild} writes every folder's index.md anew and removes empty folders, without the model.", { rebuild: <strong className="font-medium text-fg-muted">{t("Rebuild the index")}</strong> })}{" "}
          {tx("{repair} has the model mend the links to nothing and wire in the notes nothing links to — only when there are any; it takes a while and costs tokens.", { repair: <strong className="font-medium text-fg-muted">{t("Repair with the model")}</strong> })}
        </p>
        {busy && (
          <p className="flex items-center gap-2 text-xs text-fg-subtle">
            <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t(busy)}
          </p>
        )}
        {said && !busy && <p className="text-xs text-fg-muted">{said()}</p>}
        {told && !busy && (
          <details className="rounded-lg border border-line px-3 py-2 text-xs">
            <summary className="cursor-pointer text-fg-muted">{t("What the model said")}</summary>
            <div className="md mt-2 max-h-60 overflow-y-auto text-fg">
              <Markdown>{told}</Markdown>
            </div>
          </details>
        )}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </ui.Modal>
  );
}

function LogView({ writable, onOpen, onBack, onCleared }: { writable: boolean; onOpen: (path: string) => void; onBack: () => void; onCleared: () => void }) {
  const { ui } = portal;
  const [log, setLog] = useState<MemoryChange[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.memoryLog().then(setLog, (e: Error) => setFailed(e.message));
  }, []);

  /** The record starts over; what it records stays. */
  const clear = async () => {
    const ok = await confirmDialog({
      title: t("Clear the log?"),
      message: t("The record of what changed in the memory is emptied, and so are the paths Understory's queries took (the graph's Query paths). The notes stay as they are."),
      confirmLabel: t("Clear it"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    setBusy(true);
    setFailed(null);
    try {
      await api.clearMemoryLog();
      setLog(await api.memoryLog());
      onCleared();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Newest first, as Understory keeps it: each change is written at the top.
  const recent = log ?? [];
  return (
    <>
      <Bar title={t("Log")} onBack={onBack}>
        {writable && log && log.length > 0 && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          >
            <LuTrash2 className="h-3.5 w-3.5" /> {t("Clear the log")}
          </button>
        )}
      </Bar>
      <section aria-label={t("Changes to the memory")} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          {failed ? (
            <p role="alert" className="text-sm text-warn">{failed}</p>
          ) : !log ? (
            <ui.SkeletonGroup className="space-y-2" label={t("Loading the log")}>
              {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
            </ui.SkeletonGroup>
          ) : recent.length === 0 ? (
            <p className="text-sm text-fg-subtle">{t("Nothing has changed yet.")}</p>
          ) : (
            <ol className="space-y-3 border-l border-line pl-4">
              {recent.map((c, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-accent/60" />
                  <p className="flex items-center gap-2 text-[11px] text-fg-faint">
                    {c.date}
                    <span className="rounded bg-fg/5 px-1.5 py-0.5 text-fg-subtle">{c.action}</span>
                  </p>
                  <div className="md mt-0.5 text-fg">
                    <MemoryMarkdown text={c.summary} from="/" onOpen={onOpen} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </>
  );
}

/** What a librarian chat is, for the page that holds it. */
interface Librarian {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  send: (text: string) => void;
  stop: () => void;
  clear: () => void;
}

/**
 * The conversation with Understory's librarian, and the turn it is in the
 * middle of. `onTurnEnded` is told whether the turn called any tool, since
 * the librarian writes to the memory with them.
 */
function useLibrarian(onTurnEnded: (usedTools: boolean) => void): Librarian {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const ended = useRef(onTurnEnded);
  ended.current = onTurnEnded;
  // A count, not a clock: ids must differ however fast the questions come.
  const counter = useRef(0);
  // A page that is left stops listening; Understory's librarian may still finish what it started.
  useEffect(() => () => running.current?.abort(), []);

  const send = async (text: string) => {
    if (running.current || !text.trim()) return;
    const question: ChatMessage = { id: `q${++counter.current}`, role: "user", parts: [{ type: "text", text }] };
    const asked = [...messages, question];
    let turn: Turn = { message: { id: `a${++counter.current}`, role: "assistant", parts: [] } };
    const control = new AbortController();
    running.current = control;
    setMessages([...asked, turn.message]);
    setBusy(true);
    setError(null);
    try {
      const answer = await api.askLibrarian(history(asked), control.signal);
      const reader = answer.body!.getReader();
      const decoder = new TextDecoder();
      const events = eventReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of events.feed(decoder.decode(value, { stream: true }))) turn = applyChunk(turn, chunk);
        if (control.signal.aborted) break;
        setMessages([...asked, turn.message]);
      }
      if (turn.error && !control.signal.aborted) setError(turn.error);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      // Clearing the chat or leaving the page has taken its place already.
      if (running.current === control) {
        running.current = null;
        setBusy(false);
      }
      ended.current(usedTools(turn.message));
    }
  };
  /** Stops listening to the turn under way; what was said so far stays. Understory's librarian is not cut off by it. */
  const stop = () => running.current?.abort();
  /** The conversation from nothing — and a turn in the middle of it ended. */
  const clear = () => {
    const was = running.current;
    running.current = null;
    was?.abort();
    setBusy(false);
    setMessages([]);
    setError(null);
  };
  return { messages, busy, error, send: (text) => void send(text), stop, clear };
}

/** A tool the librarian called, by its name, and whether it has answered. */
function ToolCall({ part }: { part: ToolPart }) {
  const state = part.state === "output-available" ? "done" : part.state === "output-error" ? "failed" : "running";
  return (
    <span
      title={part.errorText || undefined}
      className={`inline-flex items-center gap-1 rounded bg-fg/5 px-1.5 py-0.5 font-mono text-[11px] ${state === "failed" ? "text-warn" : "text-fg-subtle"}`}
    >
      {state === "running" ? <LuRefreshCw className="h-3 w-3 animate-spin" /> : state === "failed" ? <LuTriangleAlert className="h-3 w-3" /> : <LuCircleCheck className="h-3 w-3 text-ok" />}
      {toolName(part)}
    </span>
  );
}

/** The librarian: Understory's own agent, asked about the memory or told what to keep, as in Understory's web UI. */
function LibrarianView({ chat, onOpen, onBack }: { chat: Librarian; onOpen: (path: string) => void; onBack: () => void }) {
  const { messages, busy, error, send, stop, clear } = chat;
  const { input: inputCls, primarySmall: primarySmCls } = portal.ui.classes;
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLElement>(null);
  // Followed to the newest words, unless the reader has scrolled up to read.
  const following = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !draft.trim()) return;
    following.current = true;
    send(draft.trim());
    setDraft("");
  };
  return (
    <>
      <Bar title={t("Librarian")} onBack={onBack}>
        <button
          type="button"
          onClick={clear}
          disabled={!messages.length}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-subtle transition hover:bg-fg/5 hover:text-fg disabled:opacity-40"
        >
          <LuEraser className="h-3.5 w-3.5" /> {t("Clear chat")}
        </button>
      </Bar>
      <section
        ref={scroller}
        role="log"
        aria-label={t("Conversation with the librarian")}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"
      >
        <div className="mx-auto max-w-3xl space-y-4 text-sm">
          {!messages.length && (
            <p className="py-8 text-center text-fg-subtle">{t("Ask the librarian about the memory, or tell it what to keep. It reads and writes the notes with the same tools the agent has.")}</p>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-accent/10 px-3 py-2 text-fg">
                {textOf(m)}
              </div>
            ) : (
              <div key={m.id} className="space-y-2">
                {m.parts.map((p, n) =>
                  p.type === "text" ? (
                    p.text && (
                      <div key={n} className="md text-fg">
                        <MemoryMarkdown text={p.text} from="/" onOpen={onOpen} />
                      </div>
                    )
                  ) : p.type === "step-start" ? null : (
                    <div key={n}>
                      <ToolCall part={p} />
                    </div>
                  ),
                )}
                {busy && i === messages.length - 1 && !m.parts.length && <p className="text-xs text-fg-faint">{t("The librarian is thinking…")}</p>}
              </div>
            ),
          )}
          {error && (
            <p role="alert" className="text-xs text-warn">
              {t("The librarian could not answer: {why}", { why: error })}
            </p>
          )}
        </div>
      </section>
      <form onSubmit={submit} className="border-t border-line px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
            rows={2}
            placeholder={t("Ask the librarian…")}
            aria-label={t("Ask the librarian")}
            className={`${inputCls} min-w-0 flex-1 resize-none`}
          />
          {busy ? (
            <button type="button" onClick={stop} className={`${primarySmCls} inline-flex items-center gap-1.5`}>
              <LuSquare className="h-3.5 w-3.5" /> {t("Stop")}
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()} className={`${primarySmCls} disabled:opacity-40`}>
              {t("Send")}
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function Issues({ validation, onOpen, onBack }: { validation: MemoryValidation | null; onOpen: (path: string) => void; onBack: () => void }) {
  return (
    <>
      <Bar title={t("Is the bundle well-formed?")} onBack={onBack} />
      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto max-w-3xl text-sm">
          {!validation ? (
            <p className="text-fg-subtle">{t("Understory did not say.")}</p>
          ) : validation.conformant && !validation.issues.length ? (
            <p className="flex items-center gap-2 text-ok">
              <LuCircleCheck className="h-4 w-4" /> {t("Every note is where and how the format wants it.")}
            </p>
          ) : (
            <ul className="space-y-2">
              {validation.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2">
                  <LuTriangleAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${issue.severity === "error" ? "text-danger" : "text-warn"}`} />
                  <div className="min-w-0">
                    <button type="button" onClick={() => onOpen(issue.path)} className="font-mono text-[11px] text-accent hover:underline">
                      {issue.path}
                    </button>
                    <p className="text-xs text-fg-muted">{issue.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

/** Tokens as the chat writes them (9.7k, 2k), or a ? where the trace kept none. */
const tokens = (n?: number) => (n === undefined ? "?" : formatTokens(n));

/** The key the filter hides notes nothing links to by, beside their types; no type is called this. */
const ORPHANS = "\u0000orphans";

/** What the graph's filter hides, by type ("" for notes without one) and `ORPHANS`. */
export type Hidden = ReadonlySet<string>;

const THEME_KEY = "memoryGraph.theme";
const OUTLINE_KEY = "memoryGraph.outline";

/**
 * The routes Understory's own runs took, a row each: a button that keeps the run
 * lit (its question, the tokens it cost, and a dot that is warm when it changed
 * the memory) and a toggle that opens its steps below, drawn as a path, a note a
 * step names marked with a glow in its type's colour. Pointing at a run (or
 * reaching it with Tab) lights its notes and the links between them in the
 * graph, shut or open; a click on its button keeps it lit. A run that lights
 * nothing says why in the button's tooltip and description, and has a hollow dot.
 */
function TracePaths({
  traces,
  paths,
  types,
  colourOf,
  opened,
  pinned,
  onOpen,
  onPoint,
  onPin,
}: {
  traces: MemoryTrace[];
  /** What the graph shows of each run, by the run's id. */
  paths: Map<string, TracePath>;
  /** The type of each note of the graph, by path. */
  types: Map<string, string | undefined>;
  colourOf: (type: string | undefined) => string;
  /** The runs the person has opened with their toggles. */
  opened: ReadonlySet<string>;
  /** The run kept lit. */
  pinned: string | null;
  /** A run's toggle was used: it opens if it was shut, and shuts if it was open. */
  onOpen: (id: string) => void;
  /** The run being pointed at or reached with Tab, or null: lit in the graph, closed or open. */
  onPoint: (id: string | null) => void;
  onPin: (id: string | null) => void;
}) {
  const base = useId();
  // A run is a row of its question, its cost and a toggle for its steps. Shut to begin with, so that a long list is short, and opened only with its toggle: pointing at a run, reaching it with Tab or keeping it lit lights its notes in the graph and leaves the row as it is.
  return (
    <ul aria-label={t("Query paths")} className="-mx-1 max-h-[50vh] space-y-0.5 overflow-y-auto px-1">
      {traces.slice(0, 30).map((trace) => {
        const path = paths.get(trace.id);
        const steps = path?.steps ?? [];
        const kept = pinned === trace.id;
        const open = opened.has(trace.id);
        const change = path?.changed ?? trace.kind === "mutation";
        // Why a run that is known to light nothing does: said on its row too, shut, where pointing at it would otherwise seem to do nothing.
        const nothing = path?.known && path.notes.length === 0 ? (path.touched === 0 ? t("This run touched no note") : t("No note of this path is in the graph")) : undefined;
        const id = `${base}-${trace.id}`;
        return (
          <li
            key={trace.id}
            onPointerEnter={() => onPoint(trace.id)}
            onPointerLeave={() => onPoint(null)}
            onFocus={() => onPoint(trace.id)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onPoint(null)}
            className={`rounded-lg border transition ${kept ? "border-accent/50 bg-accent/10" : "border-transparent"}`}
          >
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-pressed={kept}
                aria-description={nothing}
                title={nothing ? `${trace.input}\n${nothing}` : trace.input}
                onClick={() => onPin(kept ? null : trace.id)}
                className={`flex min-w-0 flex-1 gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-fg/5 focus-visible:bg-fg/5 ${open ? "items-start" : "items-center"}`}
              >
                <span
                  data-run-dot={nothing ? "dark" : "lit"}
                  className={`h-2 w-2 shrink-0 rounded-full ${nothing ? "border-[1.5px] border-current" : "bg-current shadow-[0_0_8px_currentColor]"} ${open ? "mt-1.5" : ""} ${change ? "text-warn" : "text-accent"}`}
                  aria-hidden
                />
                <span id={`${id}-question`} className={`min-w-0 flex-1 text-sm text-fg ${open ? "line-clamp-3 break-words" : "truncate"}`}>{trace.input}</span>
                <span className="shrink-0 font-mono text-sm text-fg-muted">
                  {tokens(trace.usage?.inputTokens)}→{tokens(trace.usage?.outputTokens)} {t("tok")}
                </span>
              </button>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? `${id}-steps` : undefined}
                aria-labelledby={`${id}-toggle ${id}-question`}
                onClick={() => onOpen(trace.id)}
                className="shrink-0 rounded-md p-1.5 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
              >
                <span id={`${id}-toggle`} className="sr-only">{open ? t("Hide the steps") : t("Show the steps")}</span>
                <LuChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
              </button>
            </div>
            {open && (
              <div id={`${id}-steps`} className="pb-2 pl-7 pr-2">
                {steps.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5">
                    {steps.map((step, k) => (
                      <span key={k} className="inline-flex min-w-0 max-w-full items-center gap-0.5">
                        {k > 0 && <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden />}
                        {step.end ? (
                          <span className="inline-flex items-center gap-1 text-sm text-fg">
                            <span className={`h-2 w-2 rounded-full bg-current ${step.end === "ok" ? "text-ok" : step.end === "partial" ? "text-warn" : "text-danger"}`} aria-hidden />
                            {step.text}
                          </span>
                        ) : (
                          <span className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-sm ${step.notes.length ? "border-line bg-surface text-fg" : "border-line/60 text-fg-muted"}`}>
                            {step.notes.map((note) => (
                              <span key={note} className="h-2 w-2 shrink-0 rounded-full" style={{ background: colourOf(types.get(note)), boxShadow: `0 0 6px ${colourOf(types.get(note))}` }} aria-hidden />
                            ))}
                            <span className="shrink-0 text-fg-faint">{step.verb}</span>
                            {step.target && <span className="truncate font-mono">{step.target}</span>}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {/* Said only once the run's own steps are known: before, there is nothing yet to say of its notes. */}
                {nothing && <p className="mt-1 text-sm text-fg-faint">{nothing}</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GraphView({
  onOpen,
  onBack,
  selected,
  onSelect,
  hidden,
  onHide,
  found,
}: {
  onOpen: (path: string) => void;
  onBack: () => void;
  /** The note last opened: lit in the graph, and what its look flies to. */
  selected: string | null;
  onSelect: (path: string | null) => void;
  hidden: Hidden;
  onHide: (hidden: Hidden) => void;
  /** What the search found, or null while nothing is searched for. */
  found: ReadonlySet<string> | null;
}) {
  const colourOf = useContext(Colours);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [traces, setTraces] = useState<MemoryTrace[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.memoryGraph().then(setGraph, (e: Error) => setFailed(e.message));
    api.memoryTraces().then(setTraces, () => {});
  }, []);

  // The look, and the brain's colour: kept in this browser.
  const [theme, setThemeNow] = useState<SkyTheme>(() => skyThemeFrom(local.get(THEME_KEY)));
  const [outline, setOutlineNow] = useState(() => colourFrom(local.get(OUTLINE_KEY)));
  const setTheme = (s: SkyTheme) => (setThemeNow(s), local.set(THEME_KEY, s));
  const setOutline = (c: string) => (setOutlineNow(colourFrom(c)), local.set(OUTLINE_KEY, colourFrom(c)));

  const types = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.type).filter((t): t is string => !!t))].sort(), [graph]);
  const untyped = useMemo(() => (graph?.nodes ?? []).some((n) => !n.type), [graph]);
  const orphans = useMemo(() => (graph?.nodes ?? []).some((n) => n.links === 0), [graph]);
  const shown = useMemo(
    () => new Set((graph?.nodes ?? []).filter((n) => !hidden.has(n.type ?? "") && !(n.links === 0 && hidden.has(ORPHANS))).map((n) => n.path)),
    [graph, hidden],
  );
  const shownEdges = useMemo(() => (graph?.edges ?? []).filter((e) => shown.has(e.source) && shown.has(e.target)), [graph, shown]);
  const foundShown = useMemo(() => (found ? new Set([...found].filter((p) => shown.has(p))) : null), [found, shown]);
  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onHide(next);
  };

  // The filter and the query paths are popovers, as the composer's are: shut by a press outside them or Escape.
  const [filtering, setFiltering] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterMenu = useRef<HTMLDivElement>(null);
  useDismiss(filtering, [filterMenu, filterButton], () => setFiltering(false), filterButton);
  const [tracing, setTracing] = useState(false);
  const traceButton = useRef<HTMLButtonElement>(null);
  const traceMenu = useRef<HTMLDivElement>(null);
  useDismiss(tracing, [traceMenu, traceButton], () => setTracing(false), traceButton);

  // The run pointed at, or else the one kept lit: its notes and the links between them are lit in the graph, the rest steps back. A path kept lit stays when the list is shut.
  const [pointed, setPointed] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  // The runs the person opened: they stay open, with the list shut and opened again, and the others stay shut.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!tracing) setPointed(null);
  }, [tracing]);
  // What each run did, step by step, as Understory keeps it: asked when the list is first opened, for the notes a step touched are in these and not in the notation.
  const [runs, setRuns] = useState<Map<string, MemoryTraceRun | "failed">>(new Map());
  const askedRuns = useRef(new Set<string>());
  useEffect(() => {
    if (!tracing) return;
    for (const trace of traces.slice(0, 30)) {
      if (askedRuns.current.has(trace.id)) continue;
      askedRuns.current.add(trace.id);
      api.memoryTrace(trace.id).then(
        (run) => setRuns((was) => new Map(was).set(trace.id, run)),
        () => setRuns((was) => new Map(was).set(trace.id, "failed")),
      );
    }
  }, [tracing, traces]);
  const inGraph = useMemo(() => new Set((graph?.nodes ?? []).map((n) => n.path)), [graph]);
  const paths = useMemo(
    () =>
      new Map(
        traces.map((trace) => {
          const run = runs.get(trace.id);
          return [trace.id, pathOf(trace, run && run !== "failed" ? run : undefined, inGraph)] as const;
        }),
      ),
    [traces, runs, inGraph],
  );
  const typeOf = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.path, n.type])), [graph]);
  const lit = pointed ?? kept;
  const trail = useMemo(() => {
    const path = lit ? paths.get(lit) : undefined;
    return path ? new Set(path.notes) : null;
  }, [lit, paths]);

  const label = graph ? t("The memory's notes and their links: {notes}, {links}", { notes: tp(shown.size, "{n} note", "{n} notes"), links: tp(shownEdges.length, "{n} link", "{n} links") }) : "";

  /** The types as switches: what the colours are, and which of them are shown. */
  const legend = graph && (types.length > 0 || orphans) && (
    <ul aria-label={t("What the colours are")} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
      {[...types.map((ty) => ({ key: ty, name: ty, colour: colourOf(ty) })), ...(untyped && types.length ? [{ key: "", name: t("no type"), colour: colourOf(undefined) }] : [])].map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => toggle(c.key)}
            aria-pressed={!hidden.has(c.key)}
            title={hidden.has(c.key) ? t("Show these notes") : t("Hide these notes")}
            className={`inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border px-2 py-0.5 transition ${hidden.has(c.key) ? "border-line text-fg-faint line-through" : "border-line bg-surface/80 text-fg-muted hover:text-fg"}`}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: hidden.has(c.key) ? "transparent" : c.colour, boxShadow: hidden.has(c.key) ? `inset 0 0 0 1.5px ${c.colour}` : `0 0 8px ${c.colour}` }} />
            <span className="truncate">{c.name}</span>
          </button>
        </li>
      ))}
      {orphans && (
        <li>
          <button
            type="button"
            onClick={() => toggle(ORPHANS)}
            aria-pressed={!hidden.has(ORPHANS)}
            title={hidden.has(ORPHANS) ? t("Show these notes") : t("Hide these notes")}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition ${hidden.has(ORPHANS) ? "border-line text-fg-faint line-through" : "border-line bg-surface/80 text-fg-muted hover:text-fg"}`}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-fg-muted" />
            {t("orphan (unlinked)")}
          </button>
        </li>
      )}
    </ul>
  );

  return (
    <>
      <Bar title={t("Graph")} onBack={onBack}>
        {legend && (
          <div className="relative">
            <button
              ref={filterButton}
              type="button"
              onClick={() => setFiltering(!filtering)}
              aria-label={t("Which notes are shown")}
              title={t("Which notes are shown")}
              aria-expanded={filtering}
              className={`ui-select ui-select-sm ${filtering ? "is-open" : ""} ${hidden.size ? "text-accent" : ""}`}
            >
              <LuFilter className="h-3.5 w-3.5" />
              <LuChevronDown className="ui-select-chevron" aria-hidden />
            </button>
            {filtering && (
              <div ref={filterMenu} className="float-in-down absolute right-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-line bg-surface p-3 shadow-pop max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:mt-3 max-sm:w-auto">
                <p className="mb-2 text-sm text-fg-muted">{t("Which notes are shown")}</p>
                {legend}
              </div>
            )}
          </div>
        )}
        {traces.length > 0 && graph && (
          <div className="relative">
            <button
              ref={traceButton}
              type="button"
              onClick={() => setTracing(!tracing)}
              aria-label={t("Query paths")}
              title={t("Query paths")}
              aria-expanded={tracing}
              className={`ui-select ui-select-sm ${tracing ? "is-open" : ""} ${kept ? "text-accent" : ""}`}
            >
              <LuWaypoints className="h-3.5 w-3.5" />
              <span className="max-sm:hidden">{t("Query paths")}</span>
              <LuChevronDown className="ui-select-chevron" aria-hidden />
            </button>
            {tracing && (
              <div ref={traceMenu} className="float-in-down absolute right-0 top-full z-20 mt-1.5 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-3 shadow-pop max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:mt-3 max-sm:w-auto max-sm:max-w-none">
                <p className="mb-2 text-sm text-fg-muted">{t("Point at a path to light it in the graph; click to keep it lit")}</p>
                <TracePaths traces={traces} paths={paths} types={typeOf} colourOf={colourOf} opened={opened} pinned={kept} onOpen={(id) => setOpened((was) => (was.has(id) ? new Set([...was].filter((x) => x !== id)) : new Set(was).add(id)))} onPoint={setPointed} onPin={setKept} />
              </div>
            )}
          </div>
        )}
        <Select
          size="sm"
          aria-label={t("Look of the 3D view")}
          value={theme}
          onChange={setTheme}
          options={SKY_THEMES.map((s) => ({
            value: s,
            label: s === "stellar" ? t("Constellation") : s === "galaxy" ? t("Galaxy") : s === "brain" ? t("Brain") : s === "fireflies" ? t("Fireflies") : t("Double helix"),
          }))}
        />
        {theme === "brain" && <ColourPicker value={outline} onChange={setOutline} label={t("Colour of the brain's outline")} />}
      </Bar>
      {failed ? (
        <p role="alert" className="p-4 text-sm text-warn">{failed}</p>
      ) : !graph ? (
        <div className="skeleton m-4 h-64" role="status"><span className="sr-only">{t("Loading the graph")}</span></div>
      ) : (
        <MemorySky notes={graph.nodes} edges={graph.edges} shown={shown} colourOf={colourOf} found={foundShown} trail={trail} selected={selected} theme={theme} outline={outline} label={label} onOpen={onOpen} onSelect={onSelect} />
      )}
    </>
  );
}
