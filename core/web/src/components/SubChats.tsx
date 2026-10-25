import { useId, type ReactNode } from "react";
import { LuChevronRight } from "react-icons/lu";
import { t, tp } from "../i18n";

/**
 * A chat's sub-chats (see sub-chats.ts), under its row in the sidebar and on
 * the Sessions page: a line that opens and shuts them and says how many there
 * are, and their rows, indented with a line beside them so that they are not
 * taken for chats of their own. Nothing for a chat that has none. On the
 * Sessions page (`md`) the rows are list items, so this is one too, with a
 * list of its own.
 */
export function SubChats<S extends { id: string }>({
  title,
  subs,
  open,
  onToggle,
  size = "sm",
  children,
}: {
  /** The chat's title, which the group is named by. */
  title: string;
  subs: readonly S[];
  open: boolean;
  onToggle: () => void;
  size?: "sm" | "md";
  /** A sub-chat's row. */
  children: (s: S) => ReactNode;
}) {
  const body = useId();
  if (!subs.length) return null;
  const md = size === "md";
  const Outer = md ? "li" : "div";
  const Group = md ? "ul" : "div";
  return (
    <Outer className={md ? "list-none" : "mb-0.5"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? body : undefined}
        // Several chats have sub-chats: the button says whose, as the group does.
        aria-label={tp(subs.length, "{n} sub-chat of {name}", "{n} sub-chats of {name}", { name: title })}
        onClick={onToggle}
        className={`flex items-center gap-1 rounded text-fg-subtle hover:text-fg-muted ${md ? "ml-3 px-1 py-0.5 text-xs" : "ml-6 px-1 py-px text-[11px]"}`}
      >
        <LuChevronRight aria-hidden className={`h-3 w-3 shrink-0 text-fg-faint transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        {tp(subs.length, "{n} sub-chat", "{n} sub-chats")}
      </button>
      {open && (
        <Group
          id={body}
          role="group"
          aria-label={t("Sub-chats of {name}", { name: title })}
          className={`border-l border-line ${md ? "ml-5 mt-1 space-y-1 pl-2" : "ml-4 pl-1"}`}
        >
          {subs.map(children)}
        </Group>
      )}
    </Outer>
  );
}
