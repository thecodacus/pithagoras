import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowLeft,
  LuBookOpen,
  LuCode,
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuEye,
  LuEyeOff,
  LuFilePlus,
  LuFileText,
  LuFolder,
  LuFolderPlus,
  LuFolderUp,
  LuLink,
  LuLocateFixed,
  LuMapPin,
  LuPencil,
  LuRefreshCw,
  LuSave,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";
import { api, folderReader, listSources, sourceReader, type FileEntry, type SourceInfo, type Unsaved } from "./files-api";
import type { FileActivity } from "./activity";
import { flushFileDraft, keepFileDraft, readFileDraft } from "./drafts";
import { bytesLabel, isEnter, isEscape, within } from "./helpers";
import { folderPictures } from "./pictures";
import { countFiles, droppedEntries, treeOfEntries, treeOfPaths, uploadTree, type Entry, type Tree } from "./tree";
import { deleteAsking, unsavedNotes } from "./unsaved";
import { confirmDialog, isApiError, local, Markdown, t, tp, useLanguage } from "./portal";

interface Open {
  path: string;
  loading: boolean;
  error?: string;
  binary: boolean;
  size: number;
  /** The file's modification time when it was read: what a save is checked against. */
  mtime: number;
  saved: string;
}

const HIDDEN_KEY = "filesShowHidden";
/** Whether names that start with a dot are shown. Off unless it was turned on: they are mostly settings and tools' own folders. */
const savedShowHidden = (): boolean => local.get(HIDDEN_KEY) === "1";

const RENDERED_KEY = "filesMarkdownRendered";
/** Whether a markdown file is shown as the page it describes rather than as its source. The page unless the source was chosen: most people open a markdown file to read it, and the choice is kept. */
const savedRendered = (): boolean => local.get(RENDERED_KEY) !== "0";
const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

/** By its name only: whether it is one is the server's to say, from its bytes, and a refusal falls back to the note. */
const looksLikePicture = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);

/** A picture, shown instead of the "not text" note; a file that turns out not to be one gets the note after all. */
function FilePicture({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="p-6 text-center text-xs text-fg-subtle">{t("Not a picture that can be shown here. Download it to open it.")}</p>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(rgb(var(--fg)/.05)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
      <img src={src} alt={name} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** How often the file that is open is looked at, to notice a change made outside this panel. */
const WATCH_MS = 3000;

const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * The files in the folder a chat works in: look through them, read and change
 * one, take one or the whole folder away.
 *
 * It follows the agent. When the agent reads a file or changes one, it is shown
 * here, which is what lets you watch what it is doing. Opening something
 * yourself takes over from that, and one button hands it back.
 *
 * Only what the agent does after the panel opens is followed, so opening it does
 * not jump to a file from earlier. `since` moves that line, for a panel that
 * opens because of what the agent just did and should show it.
 *
 * Not drawn again for a draw of the chat that changed none of what it is given.
 */
export const FilesPanel = memo(function FilesPanel({
  sessionId,
  folder,
  activity,
  since,
  reveal,
  onRevealed,
  onDirtyChange,
  keepDraft = false,
}: {
  sessionId: string;
  folder: string;
  activity: FileActivity | null;
  since?: number;
  /** A file somebody asked to see from elsewhere (a panel that lists it) by its path in the folder; a new `seq` is a new ask. */
  reveal?: { path: string; seq: number } | null;
  /** Told once the ask is answered, so that it is not answered again when the panel is drawn anew. */
  onRevealed?: () => void;
  /** Told whether there are changes not saved, so that whoever can close the panel can ask first. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Whether this is the chat's own panel, which brings back the edit it was left
   * with and keeps the next. One more panel of the same chat — the voice stage's —
   * would take over an edit that belongs to the first, and then not follow the agent.
   */
  keepDraft?: boolean;
}) {
  // Its text is in the language chosen: it is drawn for that, as it is not for the chat's draws.
  useLanguage();
  // An edit this chat's panel was left with, from before it was unmounted: the chat was switched or left with it open.
  const [left] = useState(() => (keepDraft ? readFileDraft(sessionId) : null));
  const [dir, setDir] = useState(() => (left ? parentOf(left.path) : ""));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [file, setFile] = useState<Open | null>(() =>
    left ? { path: left.path, loading: false, binary: false, size: left.size, mtime: left.mtime, saved: left.saved } : null,
  );
  const [draft, setDraft] = useState(left?.text ?? "");
  const [saving, setSaving] = useState(false);
  // A save that failed, shown above the editor: the text stays, and so does the button, to try again.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  // The open file being read again where it is (rereadFile), which Refresh turns for, as it does for the folder.
  const [rereading, setRereading] = useState(false);
  // The agent's next file would take an edit away from the screen: it follows only when nothing was left open.
  const [following, setFollowing] = useState(!left);
  const [showHidden, setShowHidden] = useState(savedShowHidden);
  const [rendered, setRendered] = useState(savedRendered);
  // A file made to be written in, or empty, opens as the source whatever the saved choice is: a blank page cannot be typed into. The choice itself is left alone.
  // An edit brought back for a file that was empty on disk is the same case: it comes back as the source, also after it was saved with text and edited again.
  const [writing, setWriting] = useState(() => left?.writing ?? (!!left && !left.saved));
  const asPage = rendered && !writing;
  // The chat's full path is not drawn in the sidebar or the chat's header any more: it is here, on request.
  const [showPath, setShowPath] = useState(false);
  // The entry being given a name, and the name so far.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Something being made here, and its name so far.
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [createName, setCreateName] = useState("");
  // Files on their way up, and whether some are being dragged over the list.
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  // A dropped folder being looked through, before the number of files in it is known.
  const [reading, setReading] = useState(false);
  // The tree being looked at: the chat's folder (null) or a source another extension gave (its id), and the sources there are.
  const [root, setRoot] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const rootRef = useRef(root);
  rootRef.current = root;
  // Counts the changes of tree: work that started in one and ends after a change must not put its result into the other.
  const rootGen = useRef(0);
  // What the chat's folder has to say about work that ended while a source was shown (a failed upload, rename, delete), until the folder is shown again.
  const lateNote = useRef<string | null>(null);
  /** True when the person has gone to a source since work on the chat's folder began: its result is the folder's, so it waits there. */
  const away = (problem: string | null) => {
    if (rootRef.current === null) return false;
    if (problem) lateNote.current = problem;
    return true;
  };
  const home = useMemo(() => folderReader(sessionId), [sessionId]);
  const reader = useMemo(() => (root === null ? home : sourceReader(sessionId, root)), [home, sessionId, root]);
  const source = root === null ? undefined : (sources.find((x) => x.id === root) ?? { id: root, label: root, writable: false });
  // Only the chat's folder is made, uploaded into, renamed in and deleted from here; a source can be saved in where it says so.
  const writable = !source || source.writable;
  // A source that went away while it was shown stays a tab, so that there is a way back.
  const tabs = source && !sources.some((x) => x.id === source.id) ? [...sources, source] : sources;
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  const dirty = !!file && !file.binary && !file.loading && draft !== file.saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const changedRef = useRef(changed);
  changedRef.current = changed;
  // For what finishes later than it started, such as a delete that asked first.
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const fileRef = useRef(file);
  fileRef.current = file;
  const savingRef = useRef(false);
  savingRef.current = saving;
  /** Deletes on their way, by path: asking git first can take a moment, and a second click is not a second delete. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  // Answers that arrive after a newer question was asked are not the answer.
  const listAsk = useRef(0);
  const fileAsk = useRef(0);
  const handled = useRef(since ?? activity?.seq ?? 0);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Gone, so nothing is left to ask about.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // Reloading or closing the tab is a way out too.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // Kept while there are changes, for a panel that is unmounted with them: switching chat or leaving the page.
  useEffect(() => {
    if (!keepDraft) return;
    keepFileDraft(sessionId, dirty && file && root === null ? { path: file.path, text: draft, saved: file.saved, mtime: file.mtime, size: file.size, writing } : null);
  }, [keepDraft, sessionId, dirty, file, draft, writing, root]);
  // Written before it goes: unmounting must not lose what was typed a moment ago. Closing the panel on purpose forgets it first.
  useEffect(() => (keepDraft ? () => flushFileDraft(sessionId) : undefined), [keepDraft, sessionId]);
  // An edit brought back may be of a file that changed meanwhile: told the way a save would, instead of at the save.
  useEffect(() => {
    if (!left) return;
    const ask = fileAsk.current;
    void api
      .readFile(sessionId, left.path)
      .then((r) => {
        if (ask === fileAsk.current && r.mtime !== left.mtime) setChanged(true);
      })
      .catch(() => {
        if (ask === fileAsk.current) setChanged(true);
      });
    // Once, for what the panel opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rootName = folder.split("/").filter(Boolean).pop() || "folder";

  const loadDir = useCallback(
    (path: string) => {
      const ask = ++listAsk.current;
      setListing(true);
      return reader
        .list(path)
        .then((r) => {
          if (ask !== listAsk.current) return;
          setEntries(r.entries);
          setTruncated(r.truncated);
          // The chat's folder shows what its work said while a source was in front (see `away`); a source starts clean.
          setListError(rootRef.current === null ? lateNote.current : null);
          if (rootRef.current === null) lateNote.current = null;
        })
        .catch((e) => {
          if (ask !== listAsk.current) return;
          setEntries([]);
          setListError((e as Error).message);
        })
        .finally(() => {
          if (ask === listAsk.current) setListing(false);
        });
    },
    [reader],
  );

  useEffect(() => {
    void loadDir(dir);
  }, [loadDir, dir]);

  // The trees other extensions gave, asked for on their own: the chat's folder is shown without waiting for them, and without them should the
  // question fail (the ones there were stay).
  const loadSources = useCallback(
    () =>
      listSources(sessionId).then(
        (r) => setSources(r.sources),
        () => {},
      ),
    [sessionId],
  );
  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const loadFile = useCallback(
    (path: string, write = false, from = reader) => {
      const ask = ++fileAsk.current;
      setWriting(write);
      setChanged(false);
      setSaveError(null);
      setFile({ path, loading: true, binary: false, size: 0, mtime: 0, saved: "" });
      setDraft("");
      return from
        .read(path)
        .then((r) => {
          if (ask !== fileAsk.current) return;
          const text = r.binary ? "" : r.content;
          setFile({ path, loading: false, binary: r.binary, size: r.size, mtime: r.mtime, saved: text });
          setDraft(text);
          if (!r.binary && !text) setWriting(true);
        })
        .catch((e) => {
          if (ask !== fileAsk.current) return;
          setFile({ path, loading: false, error: (e as Error).message, binary: false, size: 0, mtime: 0, saved: "" });
        });
    },
    [reader],
  );

  /**
   * The file that is open, read again where it is: for Refresh, and for the
   * agent's write or edit of it. Unlike opening it, the text on screen stays
   * until the new text is here, and so does the view it is shown in, the
   * source or the page.
   *
   * Changes not saved are not replaced. When the file is not what they were
   * made from any more, the bar about a changed file says so, as a save would,
   * and the person chooses; so does a read that fails, as it does for an edit
   * brought back. Without such changes, a read that fails shows its error
   * where the text was, as opening the file would.
   */
  const rereadFile = useCallback(
    (path: string, watching = false) => {
      const known = fileRef.current;
      // Asked on its own, the server leaves out the text when the file is as it was: the server reads nothing and nothing is shown for most looks.
      // With the bar about a changed file up while there are changes not saved, there is nothing more a look could tell.
      if (watching && (savingRef.current || known?.path !== path || known.loading || (dirtyRef.current && changedRef.current))) return Promise.resolve();
      // A look does not count as a new question: a read that is under way (Refresh, the agent's change) must not become stale because of it,
      // or its error would be lost. A read started later still overtakes the look.
      const ask = watching ? fileAsk.current : ++fileAsk.current;
      // What is shown is then the file as it is now, so neither the bar nor an earlier save's error is about it any more.
      const show = (open: Open, text: string) => {
        setFile(open);
        setDraft(text);
        setChanged(false);
        setSaveError(null);
      };
      if (!watching) setRereading(true);
      return (watching && reader.readIfChanged ? reader.readIfChanged(path, known!) : reader.read(path))
        .then((r) => {
          if (ask !== fileAsk.current) return;
          if ("unchanged" in r) return;
          // A save under way: the file may already be the one it writes, which is not a change by somebody else.
          if (watching && savingRef.current) return;
          if (dirtyRef.current) {
            if (r.mtime !== fileRef.current?.mtime) setChanged(true);
            return;
          }
          const text = r.binary ? "" : r.content;
          show({ path, loading: false, binary: r.binary, size: r.size, mtime: r.mtime, saved: text }, text);
          // Emptied, it is shown as the source, as an empty file opens: a blank page cannot be typed into.
          if (!r.binary && !text) setWriting(true);
        })
        .catch((e) => {
          // A look that fails says nothing: the next one tries again, and Refresh shows why.
          if (watching || ask !== fileAsk.current) return;
          if (dirtyRef.current) return setChanged(true);
          show({ path, loading: false, error: (e as Error).message, binary: false, size: 0, mtime: 0, saved: "" }, "");
        })
        .finally(() => {
          if (!watching) setRereading(false);
        });
    },
    [reader],
  );

  // The open file is looked at now and then: a change made outside this panel (another device, a cron job, the agent's shell) shows by itself.
  // Not while the page is hidden, and a look that finds nothing new changes nothing on screen.
  // Not in a source: each look would fetch the whole file from wherever it is (a cloud, over the network), every few seconds, for as long as it is open. Refresh reads it again.
  const watched = file && !file.loading && !file.error && !source ? file.path : null;
  useEffect(() => {
    if (!watched) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void rereadFile(watched, true);
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, [watched, rereadFile]);

  /** True to go on: nothing is lost, or the person said it may be. */
  const mayLeave = async () =>
    !dirtyRef.current ||
    confirmDialog({ title: t("Discard your changes?"), message: t("The file has changes that are not saved."), confirmLabel: t("Discard"), danger: true });

  // The agent read or changed a file: show it, unless somebody is in the middle of editing.
  useEffect(() => {
    if (!activity || activity.seq <= handled.current) return;
    handled.current = activity.seq;
    // The agent works in the chat's folder: its paths mean nothing in a source, which the panel is then not following (looking at one lets go).
    if (rootRef.current !== null) return;
    // What the agent did may have added to a folder, wherever the panel is looking.
    void loadDir(dir);
    // It changed the file that is open: that shows, followed or not, read again where it is. An edit in the way is asked about, not replaced.
    if (activity.tool !== "read" && activity.path === fileRef.current?.path) return void rereadFile(activity.path);
    if (!following) return;
    if (dirtyRef.current) return;
    setDir(parentOf(activity.path));
    void loadFile(activity.path, false, home);
    // Only a new activity should do this, not a change of folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity?.seq]);

  // Asked from elsewhere: shown as a file opened by hand is, so the agent does
  // not take it away again. Said to be answered at once, so that the panel drawn
  // anew is not sent back to it; a later ask overtakes one still waiting on
  // "discard your changes?".
  const revealAsk = useRef(0);
  useEffect(() => {
    if (!reveal) return;
    const ask = ++revealAsk.current;
    const target = reveal.path;
    onRevealed?.();
    void mayLeave().then((ok) => {
      if (!ok || ask !== revealAsk.current) return;
      setFollowing(false);
      // A path of the chat's folder: from a source it is shown after going back to the folder.
      if (rootRef.current !== null) rootGen.current++;
      setRoot(null);
      setDir(parentOf(target));
      void loadFile(target, false, home);
    });
    // Only a new ask, not a new folder or a new file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  const goTo = async (path: string) => {
    if (!(await mayLeave())) return;
    setFollowing(false);
    fileAsk.current++;
    setFile(null);
    setDir(path);
  };

  /** Looks at another tree: the chat's folder (null) or a source. True once it is shown; false if the person kept what they had open. */
  const switchRoot = async (next: string | null): Promise<boolean> => {
    if (next === rootRef.current) return true;
    if (!(await mayLeave())) return false;
    setFollowing(false);
    // What was asked of the one that is left is not the answer for the one that comes: both lists and the file are stale at once.
    fileAsk.current++;
    listAsk.current++;
    rootGen.current++;
    setFile(null);
    setEntries([]);
    setTruncated(false);
    setListError(null);
    setListing(next !== null);
    setRenaming(null);
    setCreating(null);
    setDir("");
    setRoot(next);
    return true;
  };

  const openEntry = async (entry: FileEntry) => {
    if (entry.type === "link") return;
    if (!(await mayLeave())) return;
    setFollowing(false);
    if (entry.type === "dir") {
      fileAsk.current++;
      setFile(null);
      setDir(join(dir, entry.name));
    } else {
      void loadFile(join(dir, entry.name));
    }
  };

  const closeFile = async () => {
    if (!(await mayLeave())) return;
    fileAsk.current++;
    setFile(null);
  };

  // Clicked again while following, it lets go: what is open stays where it is.
  const toggleFollow = async () => {
    if (following) return setFollowing(false);
    // The agent's files are the chat folder's.
    if (!(await switchRoot(null))) return;
    setFollowing(true);
    if (activity && !dirtyRef.current) {
      handled.current = activity.seq;
      setDir(parentOf(activity.path));
      void loadFile(activity.path, false, home);
    }
  };

  const save = async (overwrite = false) => {
    if (!file || file.binary || saving || !writable) return;
    setSaving(true);
    setSaveError(null);
    const gen = rootGen.current;
    try {
      const r = await reader.save(file.path, draft, overwrite ? undefined : file.mtime);
      // The person went to another tree while it was written: the file shown there is not this one.
      if (gen !== rootGen.current) return;
      // A read of the file still out (Refresh, the agent's change) may have found it as it was before this save: shown now, its old text would pass for saved.
      fileAsk.current++;
      setFile({ ...file, saved: draft, mtime: r.mtime, size: r.size, error: undefined });
      setChanged(false);
    } catch (e) {
      if (gen !== rootGen.current) return;
      // By the code, not the sentence: the server's wording is not this page's to depend on.
      if (isApiError(e) && e.body.code === "conflict") setChanged(true);
      else setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    // Not remembered where storage fails, but it works for now.
    local.set(HIDDEN_KEY, next ? "1" : "0");
  };

  const startRename = (entry: FileEntry) => {
    setRenaming(entry.name);
    setNewName(entry.name);
  };

  const finishRename = async (entry: FileEntry) => {
    const name = newName.trim();
    setRenaming(null);
    if (!name || name === entry.name) return;
    let problem: string | null = null;
    try {
      await api.renameFile(sessionId, join(dir, entry.name), name);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (away(problem)) return;
    // After the reload, which clears an error: this one is about what was just tried.
    await loadDir(dir);
    if (problem) setListError(problem);
  };

  /** Whether to delete, and whether git work that only it holds goes with it: null for "no". */
  const askToRemove = async (entry: FileEntry, unsaved: Unsaved | undefined): Promise<boolean | null> => {
    const { lost, risky, sentences } = unsavedNotes(unsaved);
    // A link to a folder is listed as a folder, but only the link goes.
    const what = entry.link
      ? t("This removes the link only. What it points to is not touched.")
      : entry.type === "dir"
        ? t("This removes the folder and everything in it. It cannot be undone.")
        : t("This removes the file. It cannot be undone.");
    const ok = await confirmDialog({
      title: lost
        ? t("Delete \"{name}\" and its unsaved work?", { name: entry.name })
        : risky
          ? t("Delete \"{name}\" anyway?", { name: entry.name })
          : t("Delete \"{name}\"?", { name: entry.name }),
      message: [...sentences, what].join(" "),
      confirmLabel: risky ? t("Delete anyway") : t("Delete"),
      danger: true,
      // Asked whatever Settings says when there is work to lose: the server refuses without it, and it has no copy.
      deletes: !risky,
    });
    return ok ? risky : null;
  };

  const remove = async (entry: FileEntry) => {
    const path = join(dir, entry.name);
    if (removing.has(path)) return;
    setRemoving((now) => new Set(now).add(path));
    let problem: string | null = null;
    try {
      // Only a folder can hold git work, and it is asked first so that the one question names it.
      // When that cannot be asked, the plain question goes first, and the server's refusal brings this one.
      const unsaved = entry.type === "dir" && !entry.link ? await api.fileUnsaved(sessionId, path).then((r) => r.unsaved, () => null) : null;
      const gone = await deleteAsking(unsaved, (u) => askToRemove(entry, u), (discard) => api.deleteFile(sessionId, path, discard));
      if (!gone) return;
      if (away(null)) return;
      // What is open and shown now, not when the delete was clicked: the person may have moved on while it was asked.
      const open = fileRef.current;
      if (open && within(path, open.path)) {
        fileAsk.current++;
        setFile(null);
      }
      // Opened while it was asked, and gone now: up to the folder it was in, which the change of folder loads.
      const shown = dirRef.current;
      if (within(path, shown)) return setDir(parentOf(path));
    } catch (e) {
      problem = (e as Error).message;
    } finally {
      setRemoving((now) => {
        const next = new Set(now);
        next.delete(path);
        return next;
      });
    }
    if (away(problem)) return;
    await loadDir(dirRef.current);
    if (problem) setListError(problem);
  };

  const startCreate = (kind: "file" | "folder") => {
    setCreating(kind);
    setCreateName("");
  };

  const finishCreate = async () => {
    const kind = creating;
    const name = createName.trim();
    setCreating(null);
    if (!kind || !name) return;
    let problem: string | null = null;
    try {
      if (kind === "folder") await api.createFolder(sessionId, dir, name);
      else await api.createFile(sessionId, join(dir, name));
    } catch (e) {
      problem = (e as Error).message;
    }
    if (away(problem)) return;
    await loadDir(dir);
    if (problem) return setListError(problem);
    // A new file is made to be written in.
    if (kind === "file") {
      setFollowing(false);
      void loadFile(join(dir, name), true);
    }
  };

  /**
   * A tree of files and folders into the folder being looked at. The folders are made first, one by one, then each file goes up with the
   * upload route that single files use. A name that is taken gets a number, for a folder as for a file; nothing is replaced.
   * A file that fails does not stop the rest, and the counter counts every file of the tree.
   */
  const upload = async (tree: Tree) => {
    const count = countFiles(tree);
    if (!count && !tree.dirs.length && !tree.problems.length && !tree.unreadable.length) return;
    const into = dir;
    setUploading((n) => n + count);
    const result = await uploadTree(
      { createFolder: (at, name) => api.createFolder(sessionId, at, name), uploadFile: (at, file) => api.uploadFile(sessionId, at, file) },
      (e) => isApiError(e) && e.body.code === "exists",
      into,
      tree,
      () => setUploading((n) => n - 1),
    );
    const problems = [
      ...tree.problems.map((path) => t("Skipped {path}: it is not a path inside the folder.", { path })),
      ...tree.unreadable.map((path) => t("Skipped {path}: it could not be read.", { path })),
      ...result.problems,
    ];
    const note = problems.length ? [...problems.slice(0, 5), ...(problems.length > 5 ? [t("…and {n} more.", { n: problems.length - 5 })] : [])].join(" ") : null;
    if (away(note)) return;
    await loadDir(dirRef.current);
    if (note) setListError(note);
  };
  /** Plain files, as the file picker and a browser without folder drops give them. */
  const uploadFiles = (files: File[]) => upload({ dirs: [], files, problems: [], unreadable: [] });
  /** What was dropped, as the browser's entries (taken during the drop): folders are walked to their end first. */
  const uploadEntries = async (entries: Entry[]) => {
    setReading(true);
    let tree: Tree;
    try {
      tree = await treeOfEntries(entries);
    } finally {
      setReading(false);
    }
    await upload(tree);
  };

  const crumbs = dir ? dir.split("/") : [];
  const shown = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-fg-subtle">
        <nav aria-label={t("Folder")} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 overflow-hidden">
          <button onClick={() => void goTo("")} className="max-w-full truncate rounded px-1 py-0.5 hover:bg-fg/5 hover:text-fg" title={source ? source.label : folder}>
            {source ? source.label : rootName}
          </button>
          {crumbs.map((name, i) => (
            <span key={i} className="flex min-w-0 max-w-full items-center gap-0.5">
              <LuChevronRight aria-hidden className="h-3 w-3 shrink-0 text-fg-faint" />
              <button onClick={() => void goTo(crumbs.slice(0, i + 1).join("/"))} className="min-w-0 truncate rounded px-1 py-0.5 hover:bg-fg/5 hover:text-fg" title={name}>
                {name}
              </button>
            </span>
          ))}
        </nav>
        <button
          onClick={() => void toggleFollow()}
          aria-pressed={following}
          title={following ? t("Stop showing what the agent reads and changes") : t("Show what the agent reads and changes")}
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition ${
            following ? "text-accent" : "text-fg-faint hover:bg-fg/5 hover:text-fg"
          }`}
        >
          <LuLocateFixed aria-hidden className="h-3.5 w-3.5" />
          <span>{following ? t("Following") : t("Follow")}</span>
        </button>
        {!file && !source && (
          <>
            <button
              onClick={() => startCreate("file")}
              title={t("New file here")}
              aria-label={t("New file")}
              className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
            >
              <LuFilePlus aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => startCreate("folder")}
              title={t("New folder here")}
              aria-label={t("New folder")}
              className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
            >
              <LuFolderPlus aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => picker.current?.click()}
              title={t("Upload files here — or drop them on the list")}
              aria-label={t("Upload files")}
              className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
            >
              <LuUpload aria-hidden className="h-3.5 w-3.5" />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void uploadFiles(files);
              }}
            />
            <button
              onClick={() => folderPicker.current?.click()}
              title={t("Upload a folder here, with everything in it — or drop it on the list")}
              aria-label={t("Upload a folder")}
              className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
            >
              <LuFolderUp aria-hidden className="h-3.5 w-3.5" />
            </button>
            <input
              ref={folderPicker}
              type="file"
              hidden
              // Not in React's types: the picker takes a folder and gives every file in it, each with its path from that folder.
              {...({ webkitdirectory: "", directory: "" } as object)}
              data-testid="files-folder-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void upload(treeOfPaths(files));
              }}
            />
          </>
        )}
        {!source && (
          <button
            onClick={() => setShowPath((v) => !v)}
            aria-pressed={showPath}
            title={showPath ? t("Hide the full path") : t("Show the full path of this folder")}
            aria-label={showPath ? t("Hide the full path") : t("Show the full path")}
            className={`shrink-0 rounded p-1 transition hover:bg-fg/5 hover:text-fg ${showPath ? "text-accent" : "text-fg-faint"}`}
          >
            <LuMapPin aria-hidden className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={toggleHidden}
          aria-pressed={showHidden}
          title={showHidden ? t("Hide names that start with a dot") : t("Show names that start with a dot")}
          aria-label={showHidden ? t("Hide hidden files") : t("Show hidden files")}
          className={`shrink-0 rounded p-1 transition hover:bg-fg/5 hover:text-fg ${showHidden ? "text-accent" : "text-fg-faint"}`}
        >
          {showHidden ? <LuEye aria-hidden className="h-3.5 w-3.5" /> : <LuEyeOff aria-hidden className="h-3.5 w-3.5" />}
        </button>
        {/* The folder, which is as it is now when the file is left, and the file that is open, which is drawn instead of it. */}
        <button
          onClick={() => {
            void loadDir(dir);
            void loadSources();
            if (file) void rereadFile(file.path);
          }}
          title={t("Refresh")}
          aria-label={t("Refresh")}
          className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
        >
          <LuRefreshCw aria-hidden className={`h-3.5 w-3.5 ${listing || rereading ? "animate-spin" : ""}`} />
        </button>
        {!source && (
          <a
            href={api.archiveDownloadUrl(sessionId, dir)}
            title={dir ? t("Download this folder as a .tar.gz") : t("Download the whole folder as a .tar.gz")}
            aria-label={t("Download this folder")}
            className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
          >
            <LuDownload aria-hidden className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {/* Only where an extension gave a tree: the chat's folder is then one of two or more, and the others are as near as it is. */}
      {tabs.length > 0 && (
        <div role="group" aria-label={t("What to look at")} className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1 text-xs">
          {[{ id: null, label: rootName, title: folder }, ...tabs.map((x) => ({ id: x.id as string | null, label: x.label, title: x.label }))].map((tab) => (
            <button
              key={tab.id === null ? "folder" : `source:${tab.id}`}
              aria-pressed={tab.id === root}
              onClick={() => void switchRoot(tab.id)}
              title={tab.title}
              className={`max-w-[12rem] truncate rounded-md px-2 py-0.5 transition ${tab.id === root ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25" : "text-fg-subtle hover:bg-fg/5 hover:text-fg"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {showPath && !source && (
        // Cut at the start, not the end: what tells folders apart is the last part. rtl moves the ellipsis; bdi keeps the path itself left to right.
        <div className="shrink-0 truncate border-b border-line px-3 py-1 text-left font-mono text-[11px] text-fg-subtle [direction:rtl]" title={dir ? `${folder}/${dir}` : folder}>
          <bdi data-testid="files-full-path">{dir ? `${folder}/${dir}` : folder}</bdi>
        </div>
      )}

      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
            <button onClick={() => void closeFile()} title={t("Back to the folder")} aria-label={t("Back to the folder")} className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg">
              <LuArrowLeft aria-hidden className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={file.path}>
              {source ? `${source.label}: ` : ""}
              {file.path}
              {dirty && (
                <span className="ml-1 text-accent" title={t("Not saved")}>
                  •
                </span>
              )}
            </span>
            {!file.loading && !file.error && (
              <span className="shrink-0 text-[10px] text-fg-faint">{bytesLabel(file.size)}</span>
            )}
            {!writable && !file.loading && !file.error && (
              <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle" title={t("This source cannot be changed from here")}>
                {t("Read-only")}
              </span>
            )}
            <a href={reader.downloadUrl(file.path)} title={t("Download this file")} aria-label={t("Download this file")} className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg">
              <LuDownload aria-hidden className="h-3.5 w-3.5" />
            </a>
            {!file.binary && !file.loading && !file.error && isMarkdown(file.path) && (
              <button
                onClick={() => {
                  local.set(RENDERED_KEY, asPage ? "0" : "1");
                  setRendered(!asPage);
                  setWriting(false);
                }}
                title={asPage ? t("Show the source") : t("Show the rendered page")}
                aria-label={asPage ? t("Show the source") : t("Show the rendered page")}
                className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg"
              >
                {asPage ? <LuCode aria-hidden className="h-3.5 w-3.5" /> : <LuBookOpen aria-hidden className="h-3.5 w-3.5" />}
              </button>
            )}
            {writable && !file.binary && !file.loading && !file.error && (
              <button
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="flex shrink-0 items-center gap-1 rounded-md bg-accent/12 px-2 py-1 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
              >
                <LuSave aria-hidden className="h-3.5 w-3.5" />
                {saving ? t("Saving…") : t("Save")}
              </button>
            )}
          </div>
          {changed && (
            <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-warn/10 px-3 py-1.5 text-xs text-warn">
              <span className="min-w-0 flex-1">{t("This file changed after you opened it.")}</span>
              <button onClick={() => void loadFile(file.path)} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Load the new version")}
              </button>
              <button onClick={() => void save(true)} className="rounded px-1.5 py-0.5 underline hover:text-fg">
                {t("Save mine anyway")}
              </button>
            </div>
          )}
          {saveError && (
            <p role="alert" className="flex shrink-0 items-start gap-1.5 border-b border-line bg-danger/10 px-3 py-1.5 text-xs text-danger">
              <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {saveError}
            </p>
          )}
          {file.error ? (
            <p role="alert" className="m-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2 py-2 text-xs text-danger">
              <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {file.error}
            </p>
          ) : file.loading ? (
            <p className="px-3 py-3 text-xs text-fg-subtle">{t("Loading…")}</p>
          ) : file.binary && looksLikePicture(file.path) && !source ? (
            <FilePicture key={`${file.path}@${file.mtime}`} src={api.pictureUrl(sessionId, file.path, file.mtime)} name={file.path} />
          ) : file.binary ? (
            <p className="p-6 text-center text-xs text-fg-subtle">{t("Not text, or too large to show. Download it to open it.")}</p>
          ) : asPage && isMarkdown(file.path) ? (
            // The draft, not the saved text: what is typed shows at once, and the page is never behind the source.
            <div role="region" aria-label={t("Rendered {path}", { path: file.path })} className="prose prose-sm min-h-0 max-w-none flex-1 overflow-auto p-3">
              {/* A picture is shown from the chat's folder; a source has no route for pictures, and what its page names is its own. */}
              <Markdown>{source ? draft : folderPictures(draft, folder, (p) => api.pictureUrl(sessionId, p), parentOf(file.path))}</Markdown>
            </div>
          ) : (
            <textarea
              value={draft}
              readOnly={!writable}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (writable && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              spellCheck={false}
              aria-label={t("Contents of {path}", { path: file.path })}
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-fg outline-none"
            />
          )}
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            // Nothing is put into a source from here, and it is said so by the pointer; the drop is still caught, or the browser opens the file.
            e.dataTransfer.dropEffect = source ? "none" : "copy";
            setDropping(!source);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDropping(false);
            if (source) return;
            // Taken now: the entries of a drop cannot be asked for after the event. A browser without them has the plain files, and a folder is no use among those.
            const entries = droppedEntries(e.dataTransfer.items);
            void (entries ? uploadEntries(entries) : uploadFiles([...e.dataTransfer.files]));
          }}
          data-testid="files-list"
          className={`min-h-0 flex-1 overflow-y-auto p-1.5 ${dropping ? "bg-accent/5 ring-2 ring-inset ring-accent/40" : ""}`}
        >
          {listing && !listError && entries.length === 0 && source && <p className="px-2 py-3 text-xs text-fg-subtle">{t("Loading…")}</p>}
          {reading && (
            <p role="status" className="px-2 py-1.5 text-xs text-fg-subtle">
              {t("Looking through the dropped folders…")}
            </p>
          )}
          {uploading > 0 && (
            <p role="status" className="px-2 py-1.5 text-xs text-fg-subtle">
              {tp(uploading, "Uploading {n} file…", "Uploading {n} files…")}
            </p>
          )}
          {creating && (
            <div className="flex items-center gap-2 px-2 py-1">
              {creating === "folder" ? (
                <LuFolder aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
              ) : (
                <LuFileText aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
              )}
              <input
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (isEnter(e)) void finishCreate();
                  else if (isEscape(e)) setCreating(null);
                }}
                onBlur={() => setCreating(null)}
                placeholder={creating === "folder" ? t("Folder name") : t("File name, e.g. notes.md")}
                aria-label={creating === "folder" ? t("Name of the new folder") : t("Name of the new file")}
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-accent/40 bg-transparent px-1.5 py-0.5 text-sm text-fg outline-none"
              />
            </div>
          )}
          {listError && (
            <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2 py-2 text-xs text-danger">
              <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {listError}
            </p>
          )}
          {!listError && !listing && !creating && shown.length === 0 && (
            <p className="px-2 py-3 text-xs text-fg-subtle">
              {entries.length === 0 ? (source ? t("Nothing in this folder.") : t("Nothing in this folder yet — drop files here to upload them.")) : t("Nothing here but hidden files.")}
            </p>
          )}
          {shown.map((entry) => (
            <div key={entry.name} className="group flex items-center rounded-lg px-1 transition hover:bg-fg/5 focus-within:bg-fg/5">
              {renaming === entry.name ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1">
                  {entry.type === "dir" ? (
                    <LuFolder aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
                  ) : entry.type === "link" ? (
                    <LuLink aria-hidden className="h-4 w-4 shrink-0" />
                  ) : (
                    <LuFileText aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
                  )}
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onFocus={(e) => {
                      // The name without its extension is what is usually meant to change.
                      const dot = entry.type === "file" ? e.target.value.lastIndexOf(".") : -1;
                      e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
                    }}
                    onKeyDown={(e) => {
                      if (isEnter(e)) void finishRename(entry);
                      else if (isEscape(e)) setRenaming(null);
                    }}
                    onBlur={() => setRenaming(null)}
                    aria-label={t("New name for {name}", { name: entry.name })}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded border border-accent/40 bg-transparent px-1.5 py-0.5 text-sm text-fg outline-none"
                  />
                </div>
              ) : (
                <>
                  <button
                    onClick={() => void openEntry(entry)}
                    disabled={entry.type === "link"}
                    title={entry.type === "link" ? t("A link that leads out of this folder, or nowhere") : entry.name}
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left text-fg disabled:cursor-default disabled:text-fg-faint"
                  >
                    {entry.type === "dir" ? (
                      <LuFolder aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
                    ) : entry.type === "link" ? (
                      <LuLink aria-hidden className="h-4 w-4 shrink-0" />
                    ) : (
                      <LuFileText aria-hidden className="h-4 w-4 shrink-0 text-fg-faint" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.link && entry.type !== "link" && <LuLink aria-label={t("A link")} className="h-3 w-3 shrink-0 text-fg-faint" />}
                    {entry.type === "file" && <span className="shrink-0 text-[10px] text-fg-faint">{bytesLabel(entry.size)}</span>}
                  </button>
                  {/* Out of the way until the row is pointed at, but always there on a touch screen, which cannot point. */}
                  <div className="files-row-actions flex shrink-0 items-center opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
                    {entry.type !== "link" && !(source && entry.type === "dir") && (
                      <a
                        href={entry.type === "dir" ? api.archiveDownloadUrl(sessionId, join(dir, entry.name)) : reader.downloadUrl(join(dir, entry.name))}
                        title={entry.type === "dir" ? t("Download {name} as a .tar.gz", { name: entry.name }) : t("Download {name}", { name: entry.name })}
                        aria-label={t("Download {name}", { name: entry.name })}
                        className="rounded p-1 text-fg-faint transition hover:bg-fg/10 hover:text-fg"
                      >
                        <LuDownload aria-hidden className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {/* Renamed and deleted in the chat's folder only: a source is read, and saved where it can be. */}
                    {!source && (
                      <>
                        <button
                          onClick={() => startRename(entry)}
                          title={t("Rename {name}", { name: entry.name })}
                          aria-label={t("Rename {name}", { name: entry.name })}
                          className="rounded p-1 text-fg-faint transition hover:bg-fg/10 hover:text-fg"
                        >
                          <LuPencil aria-hidden className="h-3.5 w-3.5" />
                        </button>
                        {/* Off by aria-disabled, not disabled: while the question is open this button is where focus goes back to, and a button that is disabled keeps none. remove() ignores the click. */}
                        <button
                          onClick={() => void remove(entry)}
                          aria-disabled={removing.has(join(dir, entry.name))}
                          aria-busy={removing.has(join(dir, entry.name))}
                          title={t("Delete {name}", { name: entry.name })}
                          aria-label={t("Delete {name}", { name: entry.name })}
                          className="rounded p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger aria-disabled:opacity-60"
                        >
                          {removing.has(join(dir, entry.name)) ? <LuRefreshCw aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 aria-hidden className="h-3.5 w-3.5" />}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          {!showHidden && entries.length > shown.length && (
            <button onClick={toggleHidden} className="px-2 py-2 text-left text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
              {tp(entries.length - shown.length, "{n} hidden file — show", "{n} hidden files — show")}
            </button>
          )}
          {truncated && <p className="px-2 py-2 text-xs text-fg-subtle">{t("This folder has more than is listed here.")}</p>}
        </div>
      )}
    </div>
  );
});
