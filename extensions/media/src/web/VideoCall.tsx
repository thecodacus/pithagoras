import { useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import type { ChatProps, ToolCallView } from "@pithagoras/extension-api";
import { Link, mediaPage, portal, t, tx } from "../portal";
import { failureReason, videoCall } from "./video-call";
import { stripAnsi } from "./helpers";
import { CallBody, Collapse } from "./CallDetails";

/**
 * A clip in the chat, played where it was given: the browser's own player, the clip fetched in the parts it
 * asks for. Only its start is fetched until it is played (`preload="metadata"`), which shows its first frame.
 * A clip that is no longer in the folder says so.
 */
function ChatVideo({ src, title }: { src: string; title: string }) {
  const [gone, setGone] = useState<string>();
  if (gone === src) return <p className="chat-video-gone">{t("This video is no longer in the folder.")}</p>;
  return <video className="chat-video" src={src} aria-label={title} controls preload="metadata" playsInline onError={() => setGone(src)} />;
}

/**
 * A generate_video call in the chat: the frame that holds the clip's place while it is made, with how long it
 * has taken (a clip takes minutes), and the player in its place once it is there. The call itself — its name, what
 * it was given, and what an error said whole — is under "Details", so that nothing the card showed is lost.
 */
export function VideoCall({ call }: ChatProps & { call: ToolCallView }) {
  portal.locale.use();
  const { ui } = portal;
  const [open, setOpen] = useState(false);
  const asked = videoCall(call.input);
  const running = call.status === "running";
  const now = ui.useNow(running);
  // The clip it made, or the file it kept when a browser cannot play what the endpoint made (its details say what that is).
  const made = call.files?.[0];
  const video = call.files?.find((f) => f.kind === "video");
  const said = (call.details as { notPlayable?: unknown } | undefined)?.notPlayable;
  const notPlayable = made && !video ? (typeof said === "string" && said ? said.slice(0, 40) : t("Unknown")) : undefined;
  const state = running ? "making" : made ? "done" : "failed";
  const output = stripAnsi(call.output ?? "");
  // A run that ended with the call open never said how it came out: it did not bring a clip.
  const reason = call.interrupted ? t("Interrupted before the video arrived") : failureReason(output);
  const title = made?.title ?? (asked.title || undefined);
  const details = (
    <button type="button" className="picture-call-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
      {t("Details")}
      <LuChevronRight aria-hidden />
    </button>
  );
  return (
    <div className="picture-call video-call">
      {state === "done" && notPlayable ? (
        // Kept as the file it is, which a browser cannot play: said so, with where it can be had.
        <figure className="video-call-player">
          <p className="chat-video-gone">
            {tx("Its format is {format}, which a browser cannot play here. It is saved, and in the {gallery}, where it can be downloaded.", {
              format: notPlayable,
              gallery: (
                <Link to={mediaPage()} className="text-accent hover:underline">
                  {t("Media gallery")}
                </Link>
              ),
            })}
          </p>
          <figcaption className="image-preview-caption">
            <span className="image-preview-title" title={title}>
              {title}
            </span>
            {details}
          </figcaption>
        </figure>
      ) : state === "done" && video ? (
        <figure className="video-call-player">
          <ChatVideo src={video.url} title={title ?? video.path} />
          <figcaption className="image-preview-caption">
            <span className="image-preview-title" title={title}>
              {title}
            </span>
            {details}
          </figcaption>
        </figure>
      ) : (
        <ui.ImagePreview
          kind="video"
          state={state}
          ratio={asked.ratio}
          title={title}
          reason={reason}
          elapsed={running && call.since ? Math.max(0, Math.floor((now - call.since) / 1000)) : undefined}
          actions={details}
        />
      )}
      <Collapse open={open}>
        <CallBody name={call.name} input={call.input} error={state === "failed" ? output : undefined} />
      </Collapse>
    </div>
  );
}
