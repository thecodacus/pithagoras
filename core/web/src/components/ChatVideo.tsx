import { useState } from "react";
import { t } from "../i18n";

/**
 * A clip in the chat, played where it was given: the browser's own player, the clip fetched in the parts it
 * asks for. Only its start is fetched until it is played (`preload="metadata"`), which shows its first frame.
 * A clip that is no longer in the folder says so.
 */
export function ChatVideo({ src, title }: { src: string; title: string }) {
  const [gone, setGone] = useState<string>();
  if (gone === src) return <p className="chat-video-gone">{t("This video is no longer in the folder.")}</p>;
  return <video className="chat-video" src={src} aria-label={title} controls preload="metadata" playsInline onError={() => setGone(src)} />;
}
