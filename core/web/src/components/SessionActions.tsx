import { LuPencil, LuPin, LuPinOff, LuTrash2 } from "react-icons/lu";
import type { Session } from "../api";
import { keep } from "../motion";
import { t } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";

/**
 * What a person is asked before a chat is deleted. One that arrived through a
 * channel does not block the chat: the next message in it simply starts a new
 * conversation, which is the reason to say so first.
 */
export function confirmDeleteSession(title: string, channel = false): Promise<boolean> {
  return confirmDialog({
    title: t("Delete \"{name}\"?", { name: title }),
    message: channel
      ? t("The agent forgets this conversation, and the next message in that chat starts a new one.")
      : t("It is stopped if it is running, and its transcript is removed."),
    confirmLabel: t("Delete"),
    danger: true,
    deletes: true,
  });
}

/** What was said when pinning, renaming or deleting a chat failed, by the sidebar and the Sessions page alike. */
export function sessionError(what: "pin" | "unpin" | "rename" | "delete", name: string, e: unknown): string {
  const error = (e as Error).message;
  if (what === "pin") return t("Could not pin \"{name}\": {error}", { name, error });
  if (what === "unpin") return t("Could not unpin \"{name}\": {error}", { name, error });
  if (what === "rename") return t("Could not rename \"{name}\": {error}", { name, error });
  return t("Could not delete \"{name}\": {error}", { name, error });
}

/**
 * Pin, rename and delete for one chat, the same in the sidebar and on the
 * Sessions page: named for a screen reader (a title alone is blanked while the
 * pointer is over it, see tooltips.ts), and with a failure said through
 * `onError` instead of being a promise nobody catches. `onError(null)` is the
 * start of the next try. The row is the nearest element with `data-flip`;
 * deleting it leaves a picture of it behind to break apart (see motion.ts).
 */
export function SessionActions({
  session: s,
  small = false,
  onPin,
  onStartRename,
  onDelete,
  onError,
}: {
  session: Session;
  /** The sidebar's size; the Sessions page has room for more. */
  small?: boolean;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onStartRename: () => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const pad = small ? "p-1" : "p-1.5";
  const icon = small ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onError(null);
          onPin(s.id, !s.pinned).catch((err) => onError(sessionError(s.pinned ? "unpin" : "pin", s.title, err)));
        }}
        className={`rounded ${pad} text-fg-subtle hover:text-accent`}
        title={s.pinned ? t("Unpin") : t("Pin")}
        aria-label={s.pinned ? t("Unpin {name}", { name: s.title }) : t("Pin {name}", { name: s.title })}
      >
        {s.pinned ? <LuPinOff aria-hidden className={icon} /> : <LuPin aria-hidden className={icon} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onStartRename();
        }}
        className={`rounded ${pad} text-fg-subtle hover:text-accent`}
        title={t("Rename")}
        aria-label={t("Rename {name}", { name: s.title })}
      >
        <LuPencil aria-hidden className={icon} />
      </button>
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          const row = e.currentTarget.closest<HTMLElement>("[data-flip]");
          if (!(await confirmDeleteSession(s.title))) return;
          onError(null);
          // A picture of the row, to break apart where it was once it is gone (see motion.ts).
          const gone = keep(row, row?.closest<HTMLElement>(".sidebar-list, .sessions-list"));
          onDelete(s.id).then(() => gone("row"), (err) => onError(sessionError("delete", s.title, err)));
        }}
        className={`rounded ${pad} text-fg-subtle hover:text-danger`}
        title={t("Delete session")}
        aria-label={t("Delete {name}", { name: s.title })}
      >
        <LuTrash2 aria-hidden className={icon} />
      </button>
    </>
  );
}
