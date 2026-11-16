import { LuFileDown } from "react-icons/lu";
import { useKernel } from "../kernel/context";
import { shownPictureId } from "../chat-pictures";
import type { Item } from "../transcript";
import { t } from "../i18n";
import { PictureButton } from "./ChatPictures";
import { ChatVideo } from "./ChatVideo";

/**
 * The files a call gave the person, under its card (see file-outputs.ts): a
 * picture, which opens in the viewer; a clip, in its player; and any other
 * file, as a link that saves it. Each in the middle of the column, with as
 * much room above as below. A picture is contained, never cropped: a wide or
 * tall one is smaller here, and whole in the viewer.
 */
export function CallFiles({ item, sessionId, onOpenPicture }: { item: Extract<Item, { kind: "tool" }>; sessionId: string; onOpenPicture: (id: string) => void }) {
  const { media } = useKernel();
  if (!item.files?.length) return null;
  return (
    <>
      {item.files.map((file, i) => {
        const name = file.title ?? file.path;
        return (
          // By place as well: a call may name a file twice.
          <div key={`${i}:${file.path}`} className="chat-picture my-3 flex justify-center">
            {file.kind === "picture" ? (
              <PictureButton id={shownPictureId(item.id, file.path)} onOpen={onOpenPicture} title={name}>
                <img src={media.picture(sessionId, file.path, item.filesSeq)} alt={name} loading="lazy" className="max-h-80 max-w-full rounded-lg border border-line object-contain" />
              </PictureButton>
            ) : file.kind === "video" ? (
              <ChatVideo src={media.video(sessionId, file.path, item.filesSeq)} title={name} />
            ) : (
              <a className="chat-file" href={media.file(sessionId, file.path, item.filesSeq)} download title={t("Download {name}", { name: file.path })}>
                <LuFileDown aria-hidden />
                <span>{name}</span>
              </a>
            )}
          </div>
        );
      })}
    </>
  );
}
