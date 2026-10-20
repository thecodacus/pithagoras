import { useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import type { CallFile, Chat, ChatProps, ToolCallView } from "@pithagoras/extension-api";
import { portal, t } from "../portal";
import { failureReason, pictureCall } from "./picture-call";
import { stripAnsi } from "./helpers";
import { CallBody, Collapse } from "./CallDetails";

/** The portal's address for a picture in a chat's folder. */
const pictureUrl = (chat: string, path: string) => `/api/sessions/${chat}/picture?path=${encodeURIComponent(path)}`;

/** How a call stands, to the preview: made while it runs, then the picture it gave, or why there is none. */
const previewState = (call: ToolCallView, picture: CallFile | undefined) => (call.status === "running" ? "making" : picture ? "done" : "failed");

/**
 * A generate_image or edit_image call in the chat: the preview in place of the
 * tool card. The call itself — its name, what it was given, and what an error
 * said whole — is under "Details", so that nothing the card showed is lost, and
 * is no longer the main thing.
 */
export function PictureCall({ chat, call }: ChatProps & { call: ToolCallView }) {
  portal.locale.use();
  const { ui } = portal;
  const [open, setOpen] = useState(false);
  const asked = pictureCall(call.name, call.input, chat.workspace);
  const running = call.status === "running";
  const now = ui.useNow(running);
  // The file the chat's viewer, voice mode's picture window and the tile on a card have for it, too: one address, so that the browser fetches it once for all of them.
  const picture = call.files?.find((file) => file.kind === "picture");
  const state = previewState(call, picture);
  const output = stripAnsi(call.output ?? "");
  // A run that ended with the call open never said how it came out: it did not bring a picture.
  const reason = call.interrupted ? t("Interrupted before the picture arrived") : failureReason(output);
  return (
    <div className="picture-call">
      <ui.ImagePreview
        state={state}
        edit={asked.edit}
        file={picture}
        before={asked.original && pictureUrl(chat.id, asked.original)}
        ratio={asked.ratio}
        title={picture?.title ?? (asked.title || undefined)}
        reason={reason}
        elapsed={running && call.since ? Math.max(0, Math.floor((now - call.since) / 1000)) : undefined}
        actions={
          <button type="button" className="picture-call-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {t("Details")}
            <LuChevronRight aria-hidden />
          </button>
        }
      />
      <Collapse open={open}>
        <CallBody name={call.name} input={call.input} error={state === "failed" ? output : undefined} />
      </Collapse>
    </div>
  );
}

/** The same call on its card in voice mode: only the frame, small, in the place of the mark that says how it stands. */
export function PictureCallTile({ call, chat }: { call: ToolCallView; chat: Chat }) {
  const { ui } = portal;
  const asked = pictureCall(call.name, call.input, chat.workspace);
  const picture = call.files?.find((file) => file.kind === "picture");
  return <ui.ImagePreview compact state={previewState(call, picture)} edit={asked.edit} src={picture?.url} ratio={asked.ratio} />;
}
