import type { ReactNode } from "react";
import { t } from "../i18n";
/**
 * A list's rows, while the list is fetched: the page keeps its shape, and
 * what arrives lands where the rows stood instead of below a line of text.
 */
export function RowsSkeleton({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="skeleton-group mt-4 space-y-2">
      <span className="sr-only">{label ?? t("Loading…")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-line px-3 py-3" style={{ opacity: 1 - i * 0.18 }}>
          <div className="skeleton h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3" style={{ width: `${62 - ((i * 17) % 30)}%` }} />
            <div className="skeleton h-2.5" style={{ width: `${38 - ((i * 11) % 18)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The shape of a page while it is fetched, as a status that says what is
 * loading in words a screen reader reads: a label on a `div` with no role is not
 * read at all. The words come last, so that the spacing between the children is
 * the page's own.
 */
export function SkeletonGroup({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" className={`skeleton-group ${className}`}>
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}
