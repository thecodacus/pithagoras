import { LuPencil, LuPin, LuPinOff, LuTrash2 } from "react-icons/lu";
import type { Session } from "../api";
import { keep } from "../motion";
import { t } from "../i18n";
import * as questions from "../kernel/confirms";
import { confirmDialog } from "./ConfirmDialog";

/**
 * The question before a chat is deleted, and before several are, for a page that deletes without going through the
 * chat list (the Agent page: its chats come from the agent's own list). The list's own deletes ask in the kernel
 * (kernel/sessions.ts), with the same words.
 */
export function confirmDeleteSession(title: string, channel = false, subChats: readonly { title: string }[] = []): Promise<boolean> {
  return confirmDialog(questions.deleteChat(title, channel, subChats));
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
 * A sub-chat shown under its chat is listed wherever that is, so it has no pin.
 */
export function SessionActions({
  session: s,
  nested = false,
  small = false,
  onPin,
  onStartRename,
  onDelete,
  onError,
}: {
  session: Session;
  /** It is shown under its chat, which is where it is pinned. */
  nested?: boolean;
  /** The sidebar's size; the Sessions page has room for more. */
  small?: boolean;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onStartRename: () => void;
  /** Asks first, in the kernel; false where the person said no. */
  onDelete: (id: string) => Promise<boolean>;
  onError: (message: string | null) => void;
}) {
  const pad = small ? "p-1" : "p-1.5";
  const icon = small ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <>
      {!nested && (
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
      )}
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
        onClick={(e) => {
          e.stopPropagation();
          const row = e.currentTarget.closest<HTMLElement>("[data-flip]");
          onError(null);
          // A picture of the row, to break apart where it was once it is gone (see motion.ts): taken before the question,
          // which is the kernel's, and played only if the person says yes.
          const gone = keep(row, row?.closest<HTMLElement>(".sidebar-list, .sessions-list"));
          onDelete(s.id).then((deleted) => deleted && gone("row"), (err) => onError(sessionError("delete", s.title, err)));
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
