import { LuArrowDownUp } from "react-icons/lu";
import { portal, t } from "../portal";
import type { OfficeDoc } from "./api";

/** How the office documents sort: one of five keys, one direction. Persisted in localStorage under "po-sort" so
 * the sidebar panel and the full Office page share ONE choice per browser; default modified-descending -- newest
 * work on top is what a document list should lead with. The sort is pure client-side over the polled docs payload:
 * the server hands back the raw meta, ordering is the caller's. */
export type SortKey = "name" | "modified" | "size" | "type" | "workspace";
export type SortChoice = { key: SortKey; dir: 1 | -1 };
const SORT_STORE_KEY = "po-sort";
export function loadSort(): SortChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORE_KEY) ?? "");
    if (raw && ["name", "modified", "size", "type", "workspace"].includes(raw.key) && (raw.dir === 1 || raw.dir === -1)) return raw;
  } catch {
    // never held: fall through to the default
  }
  return { key: "modified", dir: -1 };
}
export function saveSort(s: SortChoice): void {
  try {
    localStorage.setItem(SORT_STORE_KEY, JSON.stringify(s));
  } catch {
    // private mode: the choice simply does not stick
  }
}

/** The label the UI shows for a doc's workspace: its scan stamp (the first path segment under its scan root), or
 * "library" for docs made in the office library itself -- they have no scan root, so the stamp stays undefined. */
export const workspaceLabel = (doc: OfficeDoc): string => doc.workspace ?? t("library");

/** The one comparator for every key and both call sites (page + panel). `dir` is applied INSIDE, so rules that
 * must not flip with direction -- "workspace" keeps its undefineds LAST in either order -- stay independent of it:
 * name by locale (the same order listDocs uses), modified by mtimeMs (the file's own revision clock), size in
 * bytes, type word-before-cell, workspace by its label. */
export function compareDocs(a: OfficeDoc, b: OfficeDoc, key: SortKey, dir: 1 | -1 = 1): number {
  switch (key) {
    case "name":
      return a.title.localeCompare(b.title) * dir;
    case "modified":
      return (a.mtimeMs - b.mtimeMs) * dir;
    case "size":
      return (a.sizeBytes - b.sizeBytes) * dir;
    case "type":
      return (a.ext === b.ext ? 0 : a.ext < b.ext ? -1 : 1) * dir;
    case "workspace": {
      const wa = a.workspace;
      const wb = b.workspace;
      if (wa === undefined && wb === undefined) return 0;
      if (wa === undefined) return 1; // never flipped by dir: library-made docs stay at the bottom
      if (wb === undefined) return -1;
      return wa.localeCompare(wb) * dir;
    }
  }
}

/** The list's sort controls: a key (modified / name / size / type / workspace) and the direction, persisted per
 * browser -- compact enough for the sidebar panel, where it sits beside the full page's bar. */
export function SortBar({ sort, onSort }: { sort: SortChoice; onSort: (next: SortChoice) => void }) {
  portal.locale.use();
  return (
    <span className="po-sortbar">
      <portal.ui.Select
        size="sm"
        value={sort.key}
        onChange={(key) => onSort({ ...sort, key })}
        aria-label={t("Sort the document list by")}
        options={[
          { value: "modified", label: t("Modified") },
          { value: "name", label: t("Name") },
          { value: "size", label: t("Size") },
          { value: "type", label: t("Type") },
          { value: "workspace", label: t("Workspace") },
        ]}
      />
      <button
        type="button"
        className={portal.ui.classes.ghost}
        aria-label={sort.dir === -1 ? t("Sorted descending; switch to ascending") : t("Sorted ascending; switch to descending")}
        title={sort.dir === -1 ? t("Descending (newest first)") : t("Ascending")}
        onClick={() => onSort({ ...sort, dir: sort.dir === -1 ? 1 : -1 })}
      >
        <LuArrowDownUp aria-hidden />
        {sort.dir === -1 ? t("↓ newest first") : t("↑ oldest first")}
      </button>
    </span>
  );
}
