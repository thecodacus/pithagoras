import type { ReactNode } from "react";

/** A small button with an icon in it, named for what it does (shown as its hover text, and read by a screen reader). */
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
  /** Destructive: it turns red under the pointer. */
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Often in a row that is a button itself: the row is not also picked.
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

/** A labelled button for a bar of small controls: plain, `primary` for the one that does the job, `danger` for one that destroys. */
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
