import { memo, useMemo, useState } from "react";
import type { DiffFile } from "../../git-diff";
import { t, useLanguage } from "../../i18n";

/**
 * How many rows are drawn at first, and added by each "Show more". A row is a
 * div with four spans: a regenerated lockfile of tens of thousands of lines drawn
 * whole is a quarter of a million nodes, and a phone's tab gives up.
 */
const ROWS = 3000;

const ROW: Record<string, string> = {
  add: "bg-ok/10",
  del: "bg-danger/10",
  hunk: "bg-accent/8 text-fg-subtle",
  note: "text-fg-faint italic",
  ctx: "",
};
const MARK: Record<string, string> = { add: "+", del: "−", ctx: " ", hunk: "", note: "" };

/**
 * One file's changes, line by line: where each line was, where it is, and
 * what it says. Long lines scroll sideways rather than wrap, so that the
 * indentation of code still reads as indentation. A large diff is many rows,
 * so it is drawn again only when its file is, and only its first rows at that.
 */
export const DiffView = memo(function DiffView({ file, truncated }: { file: DiffFile; truncated?: boolean }) {
  useLanguage();
  const [limit, setLimit] = useState(ROWS);
  // Wide enough for the largest line number either side.
  const width = useMemo(() => {
    let most = 0;
    for (const r of file.rows) most = Math.max(most, r.old ?? 0, r.new ?? 0);
    return `${String(most).length + 1.5}ch`;
  }, [file]);

  if (file.binary) return <p className="p-6 text-center text-xs text-fg-subtle">{t("A binary file — its changes are not shown here.")}</p>;
  if (!file.rows.length) {
    return (
      <p className="p-6 text-center text-xs text-fg-subtle">
        {file.status === "renamed" ? t("Renamed, with nothing in it changed.") : t("No changes in the text — only its mode, or nothing at all.")}
      </p>
    );
  }
  return (
    <div className="git-diff min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-[1.55]" role="table" aria-label={t("Changes to {path}", { path: file.path })}>
      <div role="rowgroup" className="min-w-max">
        {/* Said once, for a screen reader to name the cells by: the two numbers alone are "42" and "42". */}
        <div role="row" className="sr-only">
          <span role="columnheader">{t("Line before")}</span>
          <span role="columnheader">{t("Line after")}</span>
          <span role="columnheader">{t("Kind of change")}</span>
          <span role="columnheader">{t("Text")}</span>
        </div>
        {file.rows.slice(0, limit).map((row, i) =>
          row.kind === "hunk" ? (
            <div key={i} role="row" className={`sticky left-0 px-2 py-0.5 ${ROW.hunk}`}>
              <span role="cell">{row.text}</span>
            </div>
          ) : (
            <div key={i} role="row" data-kind={row.kind} className={`flex ${ROW[row.kind]}`}>
              <span role="cell" className="shrink-0 select-none pl-1 pr-1 text-right text-fg-faint" style={{ width }}>
                {row.old ?? ""}
              </span>
              <span role="cell" className="shrink-0 select-none pr-1 text-right text-fg-faint" style={{ width }}>
                {row.new ?? ""}
              </span>
              <span
                role="cell"
                className={`min-w-4 shrink-0 select-none whitespace-pre px-0.5 text-center ${row.kind === "add" ? "text-ok" : row.kind === "del" ? "text-danger" : "text-fg-faint"}`}
              >
                <span aria-hidden>{row.mark ?? MARK[row.kind]}</span>
                {/* The sign is a picture; whether the line was added or removed is also said in words. */}
                {row.kind === "add" && <span className="sr-only">{t("added")}</span>}
                {row.kind === "del" && <span className="sr-only">{t("removed")}</span>}
              </span>
              <span role="cell" className="whitespace-pre pr-4 text-fg">{(row.kind === "note" ? t(row.text) : row.text) || " "}</span>
            </div>
          ),
        )}
        {file.rows.length > limit && (
          <div className="sticky left-0 flex items-center gap-2 px-3 py-2 font-sans text-xs text-fg-subtle">
            <span>{t("{shown} of {total} lines shown", { shown: limit, total: file.rows.length })}</span>
            <button type="button" onClick={() => setLimit((n) => n + ROWS)} className="rounded-md px-2 py-1 ring-1 ring-inset ring-line hover:bg-fg/5 hover:text-fg">
              {t("Show more")}
            </button>
          </div>
        )}
      </div>
      {truncated && <p className="px-3 py-2 text-xs text-warn">{t("This diff is too large to show whole — it stops here.")}</p>}
    </div>
  );
});
