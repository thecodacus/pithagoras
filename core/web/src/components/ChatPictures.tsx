import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { chatPictures } from "../chat-pictures";
import type { Item } from "../transcript";
import { ImageViewer } from "./ImageViewer";

/**
 * The pictures of a chat and the viewer that opens on one of them.
 *
 * `open` is what a picture's button calls; `viewer` goes once into the chat's
 * markup, and is nothing until a picture is opened. The viewer steps through
 * every picture in the conversation, not only the ones drawn at the moment:
 * what arrives while it is open joins the end of the list.
 */
export function useChatPictures(items: Item[], session: { id: string; workspace: string }) {
  // Of this chat: another chat's pictures are not the ones to step through.
  const [opened, setOpened] = useState<{ chat: string; id: string } | null>(null);
  // Gone to another chat with it open (a notification does that): it was closed there, and does not come back with this chat.
  if (opened && opened.chat !== session.id) setOpened(null);
  const open = opened?.chat === session.id;
  // Only while it is open: the list is of no use otherwise, and the items change with every word of a reply.
  const pictures = useMemo(
    () =>
      open
        ? chatPictures(items, session.workspace, {
            sent: (name) => api.imageUrl(session.id, name),
            shown: (path, version) => api.pictureUrl(session.id, path, version),
          })
        : [],
    [open, items, session.id, session.workspace],
  );
  return {
    open: (id: string) => setOpened({ chat: session.id, id }),
    viewer: !opened || !open ? null : (
      <ImageViewer
        pictures={pictures}
        startId={opened.id}
        onClose={() => setOpened(null)}
        // Back to the picture that was looked at last, if it is drawn.
        anchor={(id) => document.querySelector<HTMLElement>(`[data-picture-id="${CSS.escape(id)}"]`)}
      />
    ),
  };
}

/** A picture in the conversation: a click or a tap opens it in the viewer, not in a tab of its own. */
export function PictureButton({ id, onOpen, title, className = "", children }: { id: string; onOpen: (id: string) => void; title: string; className?: string; children: ReactNode }) {
  return (
    <button type="button" data-picture-id={id} title={title} aria-haspopup="dialog" onClick={() => onOpen(id)} className={`block w-fit cursor-zoom-in rounded-lg ${className}`}>
      {children}
    </button>
  );
}
