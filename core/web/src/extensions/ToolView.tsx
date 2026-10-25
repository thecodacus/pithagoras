import { useMemo, type ComponentType, type ReactNode } from "react";
import { api } from "../api";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { shownPictureId } from "../chat-pictures";
import { unwrapCall } from "../tool-activity";
import { viewerIds } from "./call-pictures";
import type { Item } from "../transcript";
import { channelFor } from "./channel";
import { failedIn } from "./loader";
import { panelsFor } from "./panels";
import { useSlot, type Chat, type ToolCallView } from "./slots";

/**
 * A tool call's row in the conversation: an extension's own drawing of it,
 * where one registered for the tool (`chat.tool`), with the portal's card
 * handed to it; the portal's card as it is otherwise, and when the
 * extension's fails to draw.
 */
export function ToolView({ item, chat, openPicture, children }: { item: ToolItem; chat?: Chat; openPicture?: (id: string) => void; children: ReactNode }) {
  const entries = useSlot("chat.tool");
  const call = useCallView(item, chat?.id, openPicture);
  const entry = entries.find((e) => e.tool === call.name);
  if (!entry || !chat) return <>{children}</>;
  return (
    <ErrorBoundary resetKey={`${entry.key}:${item.id}`} fallback={() => <>{children}</>} onError={failedIn(entry.extension)}>
      <entry.component chat={chat} channel={channelFor(chat.id, entry.extension)} panels={panelsFor(entry.extension)} call={call} card={children} />
    </ErrorBoundary>
  );
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** Where the page fetches a file a call gave, by its kind: see file-outputs.ts. */
const fileUrl = { picture: api.pictureUrl, video: api.videoUrl, file: api.fileUrl };

/**
 * A call as an extension is told of it: the tool inside the one that reached it, with what that was given, and the
 * files it gave in the chat `chatId`, a picture with what opens the chat's viewer at it where the conversation has one.
 */
function useCallView(item: ToolItem, chatId?: string, openPicture?: (id: string) => void): ToolCallView {
  const { name, input } = useMemo(() => unwrapCall(item.name, item.args), [item.name, item.args]);
  return useMemo<ToolCallView>(
    () => ({
      name,
      callId: item.callId,
      status: item.status,
      input,
      output: item.output,
      details: item.details,
      ...(item.since !== undefined ? { since: item.since } : {}),
      ...(item.interrupted ? { interrupted: true as const } : {}),
      ...(item.files && chatId
        ? {
            files: item.files.map((file) => {
              const view = { ...file, url: fileUrl[file.kind](chatId, file.path, item.filesSeq) };
              if (file.kind !== "picture" || !openPicture) return view;
              const id = shownPictureId(item.id, file.path);
              const opens = { ...view, open: () => openPicture(id) };
              viewerIds.set(opens, id);
              return opens;
            }),
          }
        : {}),
    }),
    [name, input, item.id, item.callId, item.status, item.output, item.details, item.since, item.interrupted, item.files, item.filesSeq, chatId, openPicture],
  );
}

/** A link on a tool call's card, as the portal draws its own: `ui.ToolLink`, for `chat.tool.action`. */
export function ToolLink({ icon: Icon, onClick, children }: { icon?: ComponentType<{ "aria-hidden"?: boolean }>; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chat-tool-link" onClick={onClick}>
      {Icon && <Icon aria-hidden />}
      {children}
    </button>
  );
}

const forTool = (tool: unknown, name: string) => {
  if (tool === undefined) return true;
  if (typeof tool === "string") return tool === name;
  if (!(tool instanceof RegExp)) return false;
  tool.lastIndex = 0;
  return tool.test(name);
};

/**
 * What the installed extensions offer to do with a call (`chat.tool.action`),
 * under what it returned on the portal's card, or, with `head`, those that
 * asked for it beside the card's head. `cut` is whether the card shows only
 * the end of the output, and `chat` the chat whose conversation the card is in
 * (none for a subagent's). One that fails to draw is left out, alone.
 */
export function ToolActions({ item, cut, chat, head = false }: { item: ToolItem; cut: boolean; chat?: Chat; head?: boolean }) {
  const entries = useSlot("chat.tool.action");
  const call = useCallView(item, chat?.id);
  const offered = entries.filter((entry) => (entry.head === true) === head && forTool(entry.tool, call.name));
  if (!offered.length) return null;
  const actions = offered.map((entry) => (
    <ErrorBoundary key={entry.key} resetKey={`${entry.key}:${item.id}`} fallback={() => null} onError={failedIn(entry.extension)}>
      <entry.component call={call} cut={cut} chat={chat} panels={panelsFor(entry.extension)} />
    </ErrorBoundary>
  ));
  return head ? <span className="chat-tool-heads">{actions}</span> : <>{actions}</>;
}
