import { useId } from "react";
import type { CallFile, Ui } from "@pithagoras/extension-api";
import { ImagePreview } from "../components/ImagePreview";

/**
 * The chat viewer's id for each picture a call gave, as an extension's card is handed it (ToolView): the viewer
 * opens at the picture by it, and finds the picture on the page by it to come out of and give focus back to. Kept
 * here rather than on the file, so that what a card is told is only what the guide says.
 */
export const viewerIds = new WeakMap<CallFile, string>();

/**
 * `ui.ImagePreview`: the portal's preview, opening the chat's viewer for a picture a call gave. Marked for a viewer
 * to find it by the chat viewer's id for that picture, or else by the `pictureId` the extension gave.
 */
export const CallImagePreview: Ui["ImagePreview"] = ({ file, onOpen, src, pictureId, ...props }) => {
  const own = useId();
  const id = (file && viewerIds.get(file)) ?? pictureId ?? own;
  const open = file?.open ?? onOpen;
  return <ImagePreview {...props} src={src ?? file?.url} pictureId={open ? id : undefined} onOpen={open ? () => open() : undefined} />;
};
