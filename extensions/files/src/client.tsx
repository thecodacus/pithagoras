import { useEffect, useMemo, useRef, useState } from "react";
import { LuFolderOpen } from "react-icons/lu";
import type { PanelProps, Portal, SlotMap } from "@pithagoras/extension-api";
import { FilesPanel } from "./FilesPanel";
import { fileOfCall, keepFileActivity, latestFileActivity, type FileActivity } from "./activity";
import { flushOnLeave, forgetFileDraft } from "./drafts";
import { confirmDialog, msg, portal, setPortal, t } from "./portal";
import { de } from "./de";
import "./client.css";

/**
 * The files of a chat's folder: a panel beside the conversation by the name
 * `files`, which another panel opens on a file with `open("files", { path })`,
 * and a window in voice mode. Both follow what the agent reads and writes.
 * What it reads and writes, it asks of the portal's routes for the folder.
 */

/** The file the agent last read or changed in the chat's folder: the same entry while it has not changed. */
function useAgentFile(chat: { id: string; workspace: string }): { activity: FileActivity | null; loading: boolean } {
  const last = useRef<FileActivity | null>(null);
  return portal.chats.use(
    chat.id,
    (feed) => ({ activity: (last.current = keepFileActivity(last.current, latestFileActivity(feed.events, chat.workspace))), loading: feed.loading }),
    (a, b) => a.activity === b.activity && a.loading === b.loading,
  );
}

let asks = 0;
/** The asks answered, by what the panel was opened with: one drawn anew is not sent back to the file it was asked for. */
const answered = new WeakSet<object>();

function Panel({ chat, panel }: PanelProps) {
  const { activity, loading } = useAgentFile(chat);
  // A file another panel asked to see (`open("files", { path })`): each open is a new ask, even of the same file.
  const params = panel.params as { path?: unknown } | undefined;
  const reveal = useMemo(() => (params && typeof params.path === "string" && !answered.has(params) ? { path: params.path, seq: ++asks } : null), [params]);
  const [dirty, setDirty] = useState(false);
  // An edit not saved: not the panel closed to make room for a third, and asked about before it is closed.
  useEffect(() => {
    panel.keep(dirty);
    panel.guardClose(
      dirty
        ? async () => {
            const ok = await confirmDialog({ title: t("Discard your changes?"), message: t("The file open in Files has changes that are not saved."), confirmLabel: t("Discard"), danger: true });
            // Given up on: the panel's unmounting would otherwise keep the edit for the next time it opens.
            if (ok) forgetFileDraft(chat.id);
            return ok;
          }
        : null,
    );
  }, [dirty, panel, chat.id]);
  return (
    <div className="min-h-0 flex-1 bg-surface">
      {/* Not before the chat's events are here: what it did earlier is not news. */}
      {!loading && <FilesPanel sessionId={chat.id} folder={chat.workspace} activity={activity} reveal={reveal} onRevealed={() => params && answered.add(params)} onDirtyChange={setDirty} keepDraft />}
    </div>
  );
}

/**
 * The window in voice mode. Opened for what the agent did, the first time, it
 * shows that file; opened by hand, it does not jump to one from before. A
 * tapped card of a call is put after everything that has happened, so that
 * the window takes its file, and the agent's next file after that again.
 */
function VoiceFiles({ chat, opened }: SlotMap["voice.window"]["props"]) {
  const { activity } = useAgentFile(chat);
  const lastEvent = portal.chats.use(chat.id, (feed) => feed.events.at(-1)?.seq ?? 0);
  const [since] = useState(() => (opened.by === "work" && activity ? activity.seq - 1 : undefined));
  const [tapped, setTapped] = useState<FileActivity | null>(null);
  const last = useRef(lastEvent);
  last.current = lastEvent;
  useEffect(() => {
    if (opened.by !== "call") return;
    const path = fileOfCall(opened.call, chat.workspace);
    if (!path) return;
    // Between the last event and the next: a second tap with nothing new between goes halfway to the next again.
    setTapped((was) => ({ seq: was && was.seq > last.current ? (was.seq + Math.floor(was.seq) + 1) / 2 : last.current + 0.5, path, tool: "read" }));
  }, [opened, chat.workspace]);
  const shown = tapped && tapped.seq > (activity?.seq ?? 0) ? tapped : activity;
  return <FilesPanel sessionId={chat.id} folder={chat.workspace} activity={shown} since={since} />;
}

export default function files(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  portal.slots.register("chat.panel", {
    id: "files",
    name: "files",
    title: msg("Files"),
    icon: LuFolderOpen,
    component: Panel,
    useButton: () => {
      portal.locale.use();
      return { title: t("Browse the files in this chat's folder") };
    },
  });
  portal.slots.register("voice.window", {
    id: "files",
    title: msg("Files"),
    icon: LuFolderOpen,
    keepLoaded: true,
    // Each file the agent reads or changes in the folder brings it up.
    useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => latestFileActivity(feed.events, chat.workspace)?.seq ?? 0),
    opensFor: (call, chat) => fileOfCall(call, chat.workspace) !== undefined,
    component: VoiceFiles,
  });
  portal.shortcuts.register({
    id: "files",
    label: "Show or hide files",
    scope: "voice",
    default: { code: "KeyF" },
    run: ({ windows }) => (windows.isOpen("files") ? windows.close("files") : windows.open("files")),
  });
  return flushOnLeave();
}
