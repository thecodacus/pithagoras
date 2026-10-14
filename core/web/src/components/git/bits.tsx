import type { ReactNode } from "react";
import { LuCircleAlert } from "react-icons/lu";
import { msg, t } from "../../i18n";
import { sinceThen } from "../../time";

/** "5m ago", from seconds since the epoch. */
export const ago = (seconds: number): string => sinceThen(seconds * 1000, { dateAfterDays: 60 });

/** A folder and a name, so a long path still shows the part that tells files apart. */
export function splitPath(p: string): { dir: string; name: string } {
  const at = p.lastIndexOf("/");
  return at < 0 ? { dir: "", name: p } : { dir: p.slice(0, at), name: p.slice(at + 1) };
}

const LETTER_COLOUR: Record<string, string> = {
  A: "text-ok",
  "?": "text-ok",
  U: "text-ok",
  M: "text-warn",
  T: "text-warn",
  R: "text-accent",
  C: "text-accent",
  D: "text-danger",
  "!": "text-danger",
};

/** The letter git gives a change: A added, M modified, D deleted, R renamed, U new here, ! in conflict. */
export function Letter({ letter, title }: { letter: string; title?: string }) {
  return (
    <span title={title && t(title)} className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${LETTER_COLOUR[letter] ?? "text-fg-subtle"}`}>
      {letter}
    </span>
  );
}

export const LETTER_NAME: Record<string, string> = {
  A: msg("Added"),
  M: msg("Modified"),
  D: msg("Deleted"),
  R: msg("Renamed"),
  C: msg("Copied"),
  T: msg("Type changed"),
  U: msg("New, not tracked yet"),
  "!": msg("In conflict"),
};

export function Counts({ added, removed, binary }: { added: number; removed: number; binary?: boolean }) {
  if (binary) return <span className="shrink-0 text-[10px] text-fg-faint">{t("binary")}</span>;
  if (!added && !removed) return null;
  return (
    <span className="shrink-0 font-mono text-[10px]">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-danger">−{removed}</span>}
    </span>
  );
}

/** A small button with an icon, named for what it does. */
export function IconButton({
  label,
  onClick,
  children,
  disabled,
  danger,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`shrink-0 rounded p-1 text-fg-faint transition disabled:opacity-40 ${
        danger ? "hover:bg-danger/10 hover:text-danger" : "hover:bg-fg/10 hover:text-fg"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** A labelled text button for the bars. */
export function TextButton({
  onClick,
  children,
  disabled,
  title,
  primary,
  danger,
  type = "button",
}: {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}) {
  const look = primary
    ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20"
    : danger
      ? "text-danger ring-1 ring-inset ring-danger/25 hover:bg-danger/10"
      : "text-fg-subtle ring-1 ring-inset ring-line hover:bg-fg/5 hover:text-fg";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  );
}

/** What went wrong. `onRetry` is for a read that failed: dismissing it would leave a list that never came. */
export function ErrorNote({ children, onClose, onRetry }: { children: ReactNode; onClose?: () => void; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-2 py-2 text-xs text-danger">
      <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded px-1.5 underline hover:text-fg">
          {t("Try again")}
        </button>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label={t("Dismiss")} className="shrink-0 rounded px-1 hover:text-fg">
          ✕
        </button>
      )}
    </div>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-xs text-fg-subtle">{children}</p>;
}

/** A heading over a list, with what can be done to all of it. */
export function SectionHead({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-line/60 bg-surface/95 px-3 py-1 backdrop-blur">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{title}</span>
      {count !== undefined && <span className="rounded-full bg-fg/8 px-1.5 text-[10px] text-fg-subtle">{count}</span>}
      <div className="ml-auto flex items-center gap-0.5">{children}</div>
    </div>
  );
}

/** A ref git decorates a commit with, as a small label. */
export function RefBadge({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ");
  const label = head ? name.slice(8) : name.replace(/^tag: /, "🏷 ");
  return (
    <span
      className={`max-w-[10rem] shrink-0 truncate rounded px-1 font-mono text-[10px] ring-1 ring-inset ${
        head ? "bg-accent/10 text-accent ring-accent/30" : "text-fg-subtle ring-line"
      }`}
      title={name}
    >
      {label}
    </span>
  );
}
