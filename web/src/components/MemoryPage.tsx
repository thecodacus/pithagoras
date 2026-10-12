import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Markdown } from "./Markdown";
import {
  LuBrain,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuCircleCheck,
  LuEraser,
  LuFileText,
  LuFolder,
  LuHistory,
  LuLocateFixed,
  LuMessageCircle,
  LuMinus,
  LuPencil,
  LuPlus,
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
  ApiError,
  type MemoryChange,
  type MemoryConcept,
  type MemoryGraph,
  type MemoryHealth,
  type MemoryHit,
  type MemoryNode,
  type MemoryTrace,
  type MemoryValidation,
} from "../api";
import { bounds, colours, layoutKept } from "../memory-graph";
import { applyChunk, eventReader, history, textOf, toolName, usedTools, type ChatMessage, type ToolPart, type Turn } from "../memory-chat";
import { NOTE_LINK, linkNotes } from "../memory-links";
import { forgetNoteDraft, forgetNoteDrafts, keepNoteDraft, readNoteDraft, type NoteDraft } from "../note-drafts";
import { confirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { codeAreaCls, inputCls, primarySmCls } from "./SettingsUi";
import { formatDateTime, msg, t, tp, tx } from "../i18n";
import { SkeletonGroup } from "./Skeleton";
import { formatTokens } from "../transcript";

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
 * its memory, through its tools. Everything is asked through the portal (see
 * server/src/api/memory.ts), so it works wherever the portal does.
 *
 * What is open is in the address: `?note=<path>`, or `?view=log|graph|issues`,
 * so it can be linked to and Back goes back through it.
 */
export function MemoryPage() {
  const [params, setParams] = useSearchParams();
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
            <Link to="/settings/add-ons" className="text-accent hover:underline">
              {t("Settings → Add-ons → Memory")}
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
              <SkeletonGroup className="space-y-1.5 px-1" label={t("Loading the memory")}>
                {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-6 w-full" />)}
              </SkeletonGroup>
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
            <GraphView key={round} onOpen={openNote} onBack={close} />
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
        const left = e instanceof ApiError && e.status === 404 ? readNoteDraft(path) : null;
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
          if (!(e instanceof ApiError && e.status === 404)) throw e;
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
            <SkeletonGroup className="space-y-2" label={t("Loading the note")}>
              <div className="skeleton h-24 w-full" />
              <div className="skeleton h-40 w-full" />
            </SkeletonGroup>
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
    <Modal
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
    </Modal>
  );
}

function LogView({ writable, onOpen, onBack, onCleared }: { writable: boolean; onOpen: (path: string) => void; onBack: () => void; onCleared: () => void }) {
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
            <SkeletonGroup className="space-y-2" label={t("Loading the log")}>
              {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
            </SkeletonGroup>
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

function GraphView({ onOpen, onBack }: { onOpen: (path: string) => void; onBack: () => void }) {
  const colourOf = useContext(Colours);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [traces, setTraces] = useState<MemoryTrace[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.memoryGraph().then(setGraph, (e: Error) => setFailed(e.message));
    api.memoryTraces().then(setTraces, () => {});
  }, []);

  const placed = useMemo(() => (graph ? layoutKept(graph.nodes.map((n) => n.path), graph.edges) : []), [graph]);
  const where = useMemo(() => new Map(placed.map((p) => [p.path, p])), [placed]);
  const fit = useMemo(() => bounds(placed), [placed]);
  const [box, setBox] = useState(fit);
  useEffect(() => setBox(fit), [fit]);
  const types = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.type).filter((t): t is string => !!t))].sort(), [graph]);

  // The notes and links, kept as they are drawn while the view moves: a pan or a zoom changes the box many times a second, and a thousand notes drawn again each time stutters.
  const drawn = useMemo(
    () =>
      graph && (
        <>
          {graph.edges.map((e, i) => {
            const a = where.get(e.source);
            const b = where.get(e.target);
            return a && b ? <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className="text-fg/20" strokeWidth={1.2} /> : null;
          })}
          {graph.nodes.map((n) => {
            const p = where.get(n.path)!;
            const r = 6 + Math.min(n.links, 10) * 0.8;
            const title = n.title || n.path;
            return (
              <g
                key={n.path}
                data-note
                role="button"
                tabIndex={0}
                aria-label={title}
                onClick={() => onOpen(n.path)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(n.path))}
                className="cursor-pointer outline-none [&:focus-visible_circle]:stroke-accent"
              >
                <title>{n.description ? `${title} — ${n.description}` : title}</title>
                {n.links === 0 && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" className="stroke-danger" strokeWidth={1.5} />}
                <circle cx={p.x} cy={p.y} r={r} fill={colourOf(n.type)} stroke="transparent" strokeWidth={3} />
                <text x={p.x} y={p.y + r + 13} textAnchor="middle" className="fill-fg text-[11px]">
                  {title.length > 32 ? `${title.slice(0, 31)}…` : title}
                </text>
              </g>
            );
          })}
        </>
      ),
    [graph, where, colourOf, onOpen],
  );

  const svg = useRef<SVGSVGElement>(null);
  /** Zoom by `factor` around a point in the drawing's own units. */
  const zoom = (factor: number, cx = box.x + box.width / 2, cy = box.y + box.height / 2) =>
    setBox((b) => ({ x: cx - (cx - b.x) * factor, y: cy - (cy - b.y) * factor, width: b.width * factor, height: b.height * factor }));
  // Not passive: a wheel over the graph zooms it rather than scrolling the page.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setBox((b) => {
        const scale = Math.max(b.width / r.width, b.height / r.height);
        const cx = b.x + b.width / 2 + (e.clientX - r.left - r.width / 2) * scale;
        const cy = b.y + b.height / 2 + (e.clientY - r.top - r.height / 2) * scale;
        const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        return { x: cx - (cx - b.x) * f, y: cy - (cy - b.y) * f, width: b.width * f, height: b.height * f };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [graph]);

  const drag = useRef<{ x: number; y: number } | null>(null);
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-note]")) return;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setBox((b) => {
      const scale = Math.max(b.width / r.width, b.height / r.height);
      return { ...b, x: b.x - dx * scale, y: b.y - dy * scale };
    });
  };
  const up = () => (drag.current = null);

  return (
    <>
      <Bar title={t("Graph")} onBack={onBack} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {failed ? (
          <p role="alert" className="p-4 text-sm text-warn">{failed}</p>
        ) : !graph ? (
          <div className="skeleton m-4 h-64" role="status"><span className="sr-only">{t("Loading the graph")}</span></div>
        ) : (
          <>
            <svg
              ref={svg}
              // A group, not a picture: the notes in it are links, which a picture would hide from a screen reader while Tab still lands on them.
              role="group"
              aria-label={t("The memory's notes and their links: {notes}, {links}", { notes: tp(graph.nodes.length, "{n} note", "{n} notes"), links: tp(graph.edges.length, "{n} link", "{n} links") })}
              viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
              className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            >
              {drawn}
            </svg>

            {(types.length > 0 || graph.nodes.some((n) => n.links === 0)) && (
              <ul aria-label={t("What the colours are")} className="absolute left-3 top-3 max-w-[45%] space-y-1 rounded-lg border border-line bg-surface/90 px-3 py-2 text-[11px] text-fg-muted">
                {types.map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colourOf(t) }} />
                    <span className="truncate">{t}</span>
                  </li>
                ))}
                {graph.nodes.some((n) => n.links === 0) && (
                  <li className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-danger" />
                    {t("orphan (unlinked)")}
                  </li>
                )}
              </ul>
            )}

            {traces.length > 0 && (
              <details className="absolute right-3 top-3 w-72 max-w-[calc(100%-1.5rem)] rounded-lg border border-line bg-surface/90 text-[11px] max-md:hidden">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg">{t("Query paths")}</summary>
                <ul className="max-h-72 space-y-2 overflow-y-auto px-3 pb-3">
                  {traces.slice(0, 30).map((trace) => (
                    <li key={trace.id} title={trace.input}>
                      <p className="flex items-center gap-1.5 text-fg">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${trace.kind === "mutation" ? "bg-warn" : "bg-accent"}`} />
                        <span className="truncate">{trace.input}</span>
                      </p>
                      <p className="mt-0.5 flex gap-2 font-mono text-[10px] text-fg-faint">
                        <span className="min-w-0 flex-1 truncate">{trace.notation}</span>
                        <span className="shrink-0">
                          {tokens(trace.usage?.inputTokens)}→{tokens(trace.usage?.outputTokens)} {t("tok")}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="absolute bottom-10 right-3 flex flex-col overflow-hidden rounded-lg border border-line bg-surface/90">
              <button type="button" onClick={() => zoom(1 / 1.3)} aria-label={t("Zoom in")} className="p-2 text-fg-muted hover:bg-fg/5 hover:text-fg">
                <LuPlus className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => zoom(1.3)} aria-label={t("Zoom out")} className="border-y border-line p-2 text-fg-muted hover:bg-fg/5 hover:text-fg">
                <LuMinus className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setBox(fit)} aria-label={t("Show all of it")} className="p-2 text-fg-muted hover:bg-fg/5 hover:text-fg">
                <LuLocateFixed className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="absolute bottom-3 left-3 text-[11px] text-fg-faint">
              {tp(graph.nodes.length, "{n} note", "{n} notes")} · {tp(graph.edges.length, "{n} link", "{n} links")} {t("— drag to move · scroll to zoom · click to open")}
            </p>
          </>
        )}
      </div>
    </>
  );
}
