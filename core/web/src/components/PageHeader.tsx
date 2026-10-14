import type { ReactNode } from "react";

/**
 * The card at the top of each page — Sessions, Projects, Agent, Routines,
 * Browser, Audit: what the page is for, an action beside it where there is
 * one, and whatever the page counts or controls underneath.
 *
 * One component so the pages stay alike: six copies of the same markup had
 * already drifted apart in their margins and their stats.
 */
export function PageHeader({
  icon,
  media,
  title,
  description,
  action,
  children,
  className = "",
}: {
  icon: ReactNode;
  /** In the icon's place, as it is: the Agents page's avatar. */
  media?: ReactNode;
  /** A name, or the controls that edit it: the Agents page's rename. */
  title: ReactNode;
  description: ReactNode;
  /** Beside the title on a wide screen, under it on a narrow one. */
  action?: ReactNode;
  /** Under the title: stats, status, controls. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`page-header rounded-2xl border border-line bg-gradient-to-br from-accent/10 via-transparent to-transparent px-5 py-5 ${className}`}>
      <div className="flex flex-wrap items-start gap-3">
        {media ?? (
          <div className="page-header-icon grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent [&>svg]:h-5 [&>svg]:w-5">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1 basis-52">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <p className="mt-0.5 max-w-xl text-sm text-fg-muted">{description}</p>
        </div>
        {/* Under the title on a narrow screen, so in line with it past the icon or the media. */}
        {action && <div className={`shrink-0 ${media ? "max-sm:ml-[4.75rem]" : "max-sm:ml-[3.25rem]"}`}>{action}</div>}
      </div>
      {children}
    </header>
  );
}

/** A count in a page header: "12 routines", "3 running". */
export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-raised/60 px-2.5 py-1">
      <span className={`text-sm tabular-nums ${tone ?? "text-fg"}`}>{value}</span>
      <span className="text-[11px] text-fg-subtle">{label}</span>
    </div>
  );
}
