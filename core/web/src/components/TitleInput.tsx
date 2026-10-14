import { useRef } from "react";
import { isEnter, isEscape } from "../shortcuts";

/**
 * A title turned into a field, in the place it was standing.
 *
 * Renaming used to open the browser's prompt box, which is a grey system dialog
 * in the middle of a themed page. This is the name itself, editable: Enter or
 * clicking away keeps it, Escape puts it back. An empty or unchanged name
 * counts as cancelling, so there is no way to save a session as nothing.
 */
export function TitleInput({
  value,
  label,
  className = "",
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  className?: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  // Enter commits and then the field unmounts, and unmounting a focused input
  // fires blur — which would commit a second time. Whichever comes first wins.
  const finished = useRef(false);
  // A title made from the first message ends in "…" where it was cut. That is
  // not part of the name: the field starts without it, and handing it back
  // untouched still counts as no change.
  const start = value.replace(/\s*…$/, "");
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    const trimmed = next?.trim();
    if (trimmed && trimmed !== value && trimmed !== start) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      autoFocus
      defaultValue={start}
      aria-label={label}
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      // The field sits inside a row that opens the session when clicked.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (isEnter(e)) finish(e.currentTarget.value);
        else if (isEscape(e)) finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className={`min-w-0 rounded bg-canvas px-1.5 py-0.5 text-fg outline-none ring-1 ring-accent/50 ${className}`}
    />
  );
}
