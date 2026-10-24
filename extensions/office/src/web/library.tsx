import { useEffect, useMemo, useState } from "react";
import { LuDownload, LuFileText, LuPresentation, LuRefreshCw, LuTable, LuTrash2, LuUsers, LuUpload } from "react-icons/lu";
import { officeUrl, portal, t } from "../portal";
import { compareDocs, loadSort, saveSort, SortBar, workspaceLabel, type SortChoice } from "./sort";
import { api, sayError, type OfficeDoc, type OfficeState } from "./api";
import { editorsIn } from "../office-ui";
import { parseDocQuery } from "../office-ui";
import { OfficeEditor } from "./office-editor";
import { refreshOfficeState, useOfficeState } from "./state";

/**
 * The Office page -- the global tab's view of the library. With `?doc=<id>` in its address it is the full-bleed
 * editor (the docs extension keeps its opened document in the page the same way); without it, the workbench:
 * a new-document line and the list of every document with who owns it and who is in it. The list itself is the
 * workspace scan -- every .docx/.xlsx of the agent homes and projects, indexed at boot and on Rescan, each in
 * place (its file IS the document) -- plus what was made here.
 */

// How the list sorts and where that choice sticks live in web/sort.tsx, shared with the sidebar panel:
// one of five keys (name / modified / size / type / workspace), one direction, persisted under "po-sort".

function extMark(doc: OfficeDoc) {
  return doc.ext === "docx" ? (
    <LuFileText className="po-ext po-ext-word" aria-hidden />
  ) : (
    <LuTable className="po-ext po-ext-cell" aria-hidden />
  );
}

/** How the document's mtimeMs reads: when it last changed on disk, which IS its revision. */
const when = (doc: OfficeDoc) => portal.format.dateTime(doc.mtimeMs);

function ownerChips(doc: OfficeDoc) {
  return (
    <>
      {doc.owner ? (
        <span className="po-chip po-chip-owner" title={t("Owned by this agent/project's home")}>
          {t("owned")} · {doc.owner}
        </span>
      ) : (
        <span className="po-chip">{t("unowned")}</span>
      )}
      {doc.grants.length > 0 && (
        <span className="po-chip" title={doc.grants.map((g) => g.chatId).join(", ")}>
          {doc.grants.length === 1 ? t("1 granted") : t("{n} granted", { n: doc.grants.length })}
        </span>
      )}
    </>
  );
}

/** The document's editing badge, straight out of the polled /state: every doc has a locks entry. */
function lockChip(state: OfficeState, doc: OfficeDoc) {
  const n = editorsIn(state.locks, doc.docId);
  return n > 0 ? (
    <span className="po-chip po-chip-lock">
      <LuUsers aria-hidden />
      {n === 1 ? t("1 editing now") : t("{n} editing now", { n })}
    </span>
  ) : null;
}

/**
 * One document in the library, with what can be done to it: opened (the row's title), downloaded or exported as a
 * file (plain addresses -- the session rides along), renamed in place (a form takes the row's title), deleted after
 * the portal's question, which says where it goes: the office trash, swept after 7 days. The action buttons are out
 * of the way until the row is pointed at or has focus (and always there on a screen without pointing).
 */
function DocRow({ doc }: { doc: OfficeDoc }) {
  portal.locale.use();
  const state = useOfficeState();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setTitle(doc.title), [doc.title]);

  const saveRename = async () => {
    const next = title.trim();
    if (next === "" || next === doc.title) return setRenaming(false);
    setBusy(true);
    setProblem(null);
    try {
      await api.renameDocument(doc.docId, next);
      setRenaming(false);
      void refreshOfficeState();
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = await portal.ui.confirm({
      title: t("Delete “{title}”?", { title: doc.title }),
      message: t("The document is moved to the office trash, which is swept after 7 days. Its revisions and history go with it."),
      confirmLabel: t("Delete"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteDocument(doc.docId);
      void refreshOfficeState();
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="po-row">
      {renaming ? (
        <form
          className="po-form"
          style={{ flex: 1, border: "none", padding: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void saveRename();
          }}
        >
          <input
            className={`po-grow ${portal.ui.classes.input}`}
            value={title}
            maxLength={200}
            aria-label={t("New title for {title}", { title: doc.title })}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || title.trim() === ""}>
            {t("Save")}
          </button>
          <button type="button" className={portal.ui.classes.ghost} onClick={() => setRenaming(false)}>
            {t("Cancel")}
          </button>
        </form>
      ) : (
        <button type="button" className="po-open" onClick={() => portal.navigate(officeUrl(doc.docId))}>
          {extMark(doc)}
          <span style={{ minWidth: 0 }}>
            <span className="po-title">{doc.title}</span>
            <span className="po-meta">
              {t("{title}.{ext}", { title: doc.title, ext: doc.ext })} · {when(doc)} · {workspaceLabel(doc)}
            </span>
          </span>
        </button>
      )}
      {state && !renaming && (
        <span className="po-chips">
          {ownerChips(doc)}
          {lockChip(state, doc)}
        </span>
      )}
      {!renaming && (
        <span className="po-row-actions">
          <a className={portal.ui.classes.iconButton} href={api.downloadUrl(doc.docId)} title={t("Download {title}", { title: doc.title })} aria-label={t("Download {title}", { title: doc.title })}>
            <LuDownload aria-hidden />
          </a>
          <a className={portal.ui.classes.iconButton} href={api.exportUrl(doc.docId)} title={t("Export a fresh copy")} aria-label={t("Export a fresh copy")}>
            <LuUpload aria-hidden />
          </a>
          <button
            type="button"
            className={portal.ui.classes.iconButton}
            title={t("Rename {title}", { title: doc.title })}
            aria-label={t("Rename {title}", { title: doc.title })}
            onClick={() => setRenaming(true)}
          >
            ✎
          </button>
          <button
            type="button"
            className={portal.ui.classes.iconButton}
            aria-disabled={busy}
            title={t("Delete {title}", { title: doc.title })}
            aria-label={t("Delete {title}", { title: doc.title })}
            onClick={() => void remove()}
          >
            <LuTrash2 aria-hidden />
          </button>
        </span>
      )}
      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("That did not work: {error}", { error: problem })}</portal.ui.ErrorBanner>
      )}
    </li>
  );
}

/** A new document in the library: its title and which kind -- word (.docx) or sheet (.xlsx). Human-made ones are unowned. */
function NewDocument() {
  portal.locale.use();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"word" | "cell">("word");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = async () => {
    if (title.trim() === "" || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.createDocument({ title: title.trim(), type: kind });
      setTitle("");
      void refreshOfficeState();
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="po-form"
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
    >
      <input
        className={`po-grow ${portal.ui.classes.input}`}
        value={title}
        maxLength={200}
        placeholder={t("Title of a new document")}
        aria-label={t("Title of a new document")}
        onChange={(e) => setTitle(e.target.value)}
      />
      <portal.ui.Segments
        label={t("Kind")}
        value={kind}
        options={[
          { id: "word", label: t("Word (.docx)") },
          { id: "cell", label: t("Sheet (.xlsx)") },
        ]}
        onChange={setKind}
        showLabel={false}
      />
      <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || title.trim() === ""}>
        {t("New document")}
      </button>
      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The document could not be made: {error}", { error: problem })}</portal.ui.ErrorBanner>
      )}
    </form>
  );
}

/** Re-run the workspace scan from the page: boot already scanned once, this catches files written straight to
 * disk since (an agent or a person working in the homes and projects) without waiting for the next portal start.
 * The answer's counts are said out loud in a hint line, not an alert. */
function RescanLibrary() {
  portal.locale.use();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await api.rescanLibrary();
      setNote(
        out.added === 0 && out.updated === 0
          ? t("Nothing new: the library already knew every .docx and .xlsx in the agent folders.")
          : t("Scan done: {added} indexed, {updated} refreshed.", { added: out.added, updated: out.updated }),
      );
      void refreshOfficeState();
    } catch (e) {
      setNote(t("The rescan did not work: {error}", { error: sayError(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="po-rescan">
      <button type="button" className={portal.ui.classes.ghost} onClick={() => void go()} disabled={busy} aria-label={t("Rescan the agent folders for .docx and .xlsx files")}>
        <LuRefreshCw aria-hidden /> {t("Rescan workspace")}
      </button>
      {note && <span className="po-hint">{note}</span>}
    </span>
  );
}

// The SortBar itself (key incl. workspace + direction, "po-sort" persistence) is the shared one from web/sort.tsx.

function Library() {
  portal.locale.use();
  const state = useOfficeState();
  const [sort, setSort] = useState(loadSort); // shared with the sidebar panel ("po-sort"); default modified-descending
  const chooseSort = (next: SortChoice) => {
    setSort(next);
    saveSort(next);
  };
  const docs = useMemo(
    () => (state ? [...state.docs].sort((a, b) => compareDocs(a, b, sort.key, sort.dir)) : []),
    [state, sort],
  ); // client-side ordering of the polled payload; the server hands back raw meta
  return (
    <div className="po-page">
      <portal.ui.PageHeader
        icon={<LuPresentation />}
        title={t("Office")}
        description={t("The office documents of this portal: everything made here plus every .docx or .xlsx found across the agent homes and projects -- indexed automatically at boot and by Rescan, editable in place.")}
      />
      {!state ? (
        <portal.ui.RowsSkeleton rows={4} label={t("Loading…")} />
      ) : (
        <>
          <NewDocument />
          {state.docs.length === 0 ? (
            <>
              <portal.ui.Empty>{t("No documents yet. Make a Word or sheet document above, ask an agent to write one -- or drop a .docx / .xlsx into any agent folder and press Rescan: everything is indexed here automatically, in place.")}</portal.ui.Empty>
              <RescanLibrary />
            </>
          ) : (
            <>
              <span className="po-listhead">
                <SortBar sort={sort} onSort={chooseSort} />
                <RescanLibrary />
              </span>
              <ul className="po-list">
                {docs.map((doc) => (
                  <DocRow key={doc.docId} doc={doc} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The page itself: the document named by `?doc=` in full bleed, else the library (the docs extension's precedent). */
export function OfficePage() {
  const { search } = portal.useLocation();
  const docId = parseDocQuery(search);
  const state = useOfficeState();
  if (docId) {
    // The document is gone from the library meanwhile: say so, with a way back.
    if (state && !state.docs.some((d) => d.docId === docId)) {
      return (
        <div className="po-page">
          <portal.ui.ErrorBanner>
            {t("This document is no longer in the library.")}{" "}
            <button type="button" className={portal.ui.classes.ghost} onClick={() => portal.navigate(officeUrl())}>
              ← {t("All documents")}
            </button>
          </portal.ui.ErrorBanner>
        </div>
      );
    }
    return <OfficeEditor docId={docId} onBack={() => portal.navigate(officeUrl())} />;
  }
  return <Library />;
}
