import "../style.css";
import { Suspense, useState } from "react";
import type { ChatProps, PanelProps, Portal, ToolCallView } from "@pithagoras/extension-api";
import { LuFileText, LuPresentation, LuTable } from "react-icons/lu";
import type { ReactNode } from "react";
import { officeUrl, portal, setPortal, t } from "./portal";
import { refreshOfficeState, useOfficeState } from "./web/state";
import { api, sayError } from "./web/api";
import { compareDocs, loadSort, saveSort, SortBar, type SortChoice } from "./web/sort";
import { editorsIn } from "./office-ui";

/**
 * pithagoras-office: its browser half. The Office tab -- the full library with its own workbench chrome (style.css),
 * opened documents in a full-bleed OnlyOffice editor; the office panel beside an agent/project's home chat, the tool
 * cards of its office_* calls, and its page in Settings where the Document Server is run. The docs extension's slot
 * shape is mirrored: nav.page + chat.panel + chat.tool entries + settings.page (docs/web/client.js). Its heavy parts
 * load as chunks, the way Understory's do (ui.lazy + Suspense).
 */

/** A document beside a home chat: every UNOWNED one (workspace-scanned or human-made -- shared by all chats),
 * plus ones it owns or a comment mention granted it -- derived from GET /state (the server half keeps no per-chat
 * route; owner and grants ride in every doc's meta, plan 2.1). The sort choice is the one of web/sort.tsx,
 * persisted under "po-sort" so this panel and the full Office page share it. */
function OfficePanel({ chat }: PanelProps) {
  portal.locale.use();
  const state = useOfficeState();
  const [sort, setSort] = useState<SortChoice>(loadSort);
  if (!state) return <portal.ui.RowsSkeleton rows={3} label={t("Loading…")} />;
  const chooseSort = (next: SortChoice) => {
    setSort(next);
    saveSort(next);
  };
  const mine = [...state.docs]
    .filter((d) => d.owner === null || d.owner === chat.id || d.grants.some((g) => g.chatId === chat.id))
    .sort((a, b) => compareDocs(a, b, sort.key, sort.dir));
  return (
    <div className="space-y-1 p-2">
      <PanelNewDocument />
      {mine.length === 0 ? (
        <portal.ui.Empty>{t("No office documents yet -- the workspace .docx and .xlsx files, human-made docs, and the ones this chat owns or was granted by a comment mention will appear here.")}</portal.ui.Empty>
      ) : (
        <>
          <SortBar sort={sort} onSort={chooseSort} />
          {mine.map((doc) => {
            const n = editorsIn(state.locks, doc.docId);
            return (
              <div key={doc.docId} className="po-row">
                <button type="button" className="po-open" onClick={() => portal.navigate(officeUrl(doc.docId))}>
                  {doc.ext === "docx" ? (
                    <LuFileText className="po-ext po-ext-word" aria-hidden />
                  ) : (
                    <LuTable className="po-ext po-ext-cell" aria-hidden />
                  )}
                  <span style={{ minWidth: 0 }}>
                    <span className="po-title">{doc.title}</span>
                    <span className="po-meta">
                      {t("{title}.{ext}", { title: doc.title, ext: doc.ext })}
                      {n > 0 ? ` · ${n === 1 ? t("1 editing now") : t("{n} editing now", { n })}` : ""}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** The panel's slim new-document row: title + a word/sheet kind toggle + create, on the SAME api.createDocument
 * as the page's NewDocument -- and like it it passes NO owner, so a doc made here is unowned and lands where the
 * workspace docs already are: every chat's panel and the global library. */
function PanelNewDocument() {
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
      void refreshOfficeState(); // the new doc appears in this panel immediately, not on the next 5 s poll
    } catch (e) {
      setProblem(sayError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="po-newcompact"
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
    >
      <input
        className={portal.ui.classes.input}
        value={title}
        maxLength={200}
        placeholder={t("New document title")}
        aria-label={t("New document title")}
        onChange={(e) => setTitle(e.target.value)}
      />
      <span className="po-kind">
        <button type="button" aria-pressed={kind === "word"} className={`po-kind-btn${kind === "word" ? " po-kind-on" : ""}`} onClick={() => setKind("word")} title={t("Word (.docx)")} aria-label={t("Word (.docx)")}>
          <LuFileText aria-hidden />
        </button>
        <button type="button" aria-pressed={kind === "cell"} className={`po-kind-btn${kind === "cell" ? " po-kind-on" : ""}`} onClick={() => setKind("cell")} title={t("Sheet (.xlsx)")} aria-label={t("Sheet (.xlsx)")}>
          <LuTable aria-hidden />
        </button>
      </span>
      <button type="submit" className={portal.ui.classes.primarySmall} disabled={busy || title.trim() === ""}>
        {t("Add")}
      </button>
      {problem && (
        <portal.ui.ErrorBanner onClose={() => setProblem(null)}>{t("The document could not be made: {error}", { error: problem })}</portal.ui.ErrorBanner>
      )}
    </form>
  );
}

/** What the office tools reported, beside their text: which document, and a way to open it. The portal's own card
 * says it best while a call runs or failed, so those stay as they are (the docs extension's tool-card precedent). */
interface OfficeToolDetails {
  action?: string;
  id?: string;
  title?: string;
  ext?: "docx" | "xlsx";
  mtimeMs?: number;
  from?: number;
  to?: number;
  ops?: number;
  documents?: unknown[];
}

function OfficeCall(props: ChatProps & { call: ToolCallView; card: ReactNode }) {
  portal.locale.use();
  const state = useOfficeState();
  const { call, card } = props;
  const d = call.details as OfficeToolDetails | undefined;
  if (call.status !== "done" || !d || typeof d.action !== "string") return card;

  const heading: Record<string, string> = {
    create: t("Created a document"),
    read: t("Read a document"),
    edit: t("Edited a document"),
    comments: t("Read the comments of a document"),
    list: t("Listed the office documents"),
  };
  const titleText = heading[d.action];
  if (!titleText) return card;

  // The tool names its document by id alone; its title comes from what the poll has (or the call said it).
  let name: string | null = d.title ?? null;
  if (d.id) name ??= state?.docs.find((x) => x.docId === d.id)?.title ?? null;
  const facts: string[] = [];
  if (d.action === "list") {
    facts.push(d.documents?.length === 1 ? t("1 document") : t("{n} documents", { n: d.documents?.length ?? 0 }));
  } else if (d.id) {
    const ext = d.ext ?? state?.docs.find((x) => x.docId === d.id)?.ext;
    facts.push(ext ? `${name ?? d.id}.${ext}` : name ?? d.id);
    if (d.action === "edit") {
      facts.push(typeof d.from === "number" && typeof d.to === "number" ? t("Revision {from} to {to}", { from: d.from, to: d.to }) : typeof d.to === "number" ? t("Revision {n}", { n: d.to }) : "");
      facts.push(typeof d.ops === "number" ? (d.ops === 1 ? t("1 edit") : t("{n} edits", { n: d.ops })) : "");
    } else if (typeof d.mtimeMs === "number") facts.push(t("Revision {n}", { n: d.mtimeMs }));
  }

  const open = d.action === "list" ? officeUrl() : typeof d.id === "string" && d.id !== "" ? officeUrl(d.id) : null;
  if (!open) return card; // nothing with an address to open: the portal's card already said enough

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 p-2">
      <LuPresentation />
      <div style={{ minWidth: 0, flex: 1 }}>
        <span className="text-xs text-fg-muted">{titleText}</span>
        {name && <p className="truncate text-sm text-fg">{name}</p>}
        {facts.filter(Boolean).length > 0 && <p className="text-[11px] text-fg-subtle">{facts.filter(Boolean).join(" · ")}</p>}
      </div>
      <button type="button" className={portal.ui.classes.ghost} onClick={() => portal.navigate(open)}>
        {t("Open in Office")}
      </button>
    </div>
  );
}

export default function office(given: Portal): void {
  setPortal(given);
  // Its heavy parts, fetched only when they are opened (the Understory idiom).
  const Page = portal.ui.lazy(() => import("./web/library"), "OfficePage");
  const Settings = portal.ui.lazy(() => import("./web/settings"), "OfficeSettings");
  const fallback = <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>;

  // The Office tab: the full library at /x/pithagoras-office/office, its chrome its own (style.css), a document
  // open as ?doc=<id> in the whole page.
  portal.slots.register("nav.page", {
    id: "office",
    title: t("Office"),
    icon: LuPresentation,
    component: () => (
      <Suspense fallback={fallback}>
        <Page />
      </Suspense>
    ),
  });

  // Beside every chat -- shown for all, as the docs' panel is: every unowned (workspace-scanned / human-made) doc
  // is shared by every chat, plus what this one owns or was granted; where there is nothing at all, it says so.
  portal.slots.register("chat.panel", {
    id: "office",
    name: "office",
    title: t("Office"),
    icon: LuPresentation,
    component: OfficePanel,
    useButton: () => ({ title: t("The office documents this chat owns or was granted") }),
  });

  // A call of one of the tools, in place of the portal's card for a finished one that names its document.
  for (const tool of ["office_list", "office_create", "office_read", "office_edit", "office_comments"]) {
    portal.slots.register("chat.tool", { id: tool, tool, component: OfficeCall });
  }

  // Its page in Settings: the Document Server's service panel.
  portal.slots.register("settings.page", {
    id: "office",
    title: t("Office"),
    icon: LuPresentation,
    search: [
      { title: t("Office"), words: "office document docx xlsx word sheet spreadsheet onlyoffice document server container image tag pull co-editing library workspace scan rescan export trash" },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
