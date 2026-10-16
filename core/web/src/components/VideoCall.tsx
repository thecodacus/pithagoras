import { useState } from "react";
import { Link } from "react-router-dom";
import { LuChevronRight } from "react-icons/lu";
import { api } from "../api";
import { fileOf, stripAnsi, type Item } from "../transcript";
import { failureReason, videoCall } from "../video-call";
import { t, tx } from "../i18n";
import { Collapse, ToolArgs } from "./ChatActivity";
import { useNow } from "../use-now";
import { ImagePreview, type PreviewState } from "./ImagePreview";
import { ChatVideo } from "./ChatVideo";

type ToolItem = Extract<Item, { kind: "tool" }>;

/**
 * A generate_video call in the chat: the frame that holds the clip's place while it is made, with how long it
 * has taken (a clip takes minutes), and the player in its place once it is there. The call itself — its name, what
 * it was given, and what an error said whole — is under "Details", so that nothing the card showed is lost.
 */
export function VideoCall({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const call = videoCall(item.args);
  const running = item.status === "running";
  const now = useNow(running);
  // The clip it made, or the file it kept when a browser cannot play what the endpoint made (its details say what that is).
  const made = item.files?.[0];
  const video = fileOf(item, "video");
  const said = (item.details as { notPlayable?: unknown } | undefined)?.notPlayable;
  const notPlayable = made && !video ? (typeof said === "string" && said ? said.slice(0, 40) : t("Unknown")) : undefined;
  const state: PreviewState = running ? "making" : made ? "done" : "failed";
  const output = stripAnsi(item.output ?? "");
  // A run that ended with the call open never said how it came out: it did not bring a clip.
  const reason = item.interrupted ? t("Interrupted before the video arrived") : failureReason(output);
  const title = made?.title ?? (call.title || undefined);
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
                <Link to="/media" className="text-accent hover:underline">
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
          <ChatVideo src={api.videoUrl(sessionId, video.path, item.filesSeq)} title={title ?? video.path} />
          <figcaption className="image-preview-caption">
            <span className="image-preview-title" title={title}>
              {title}
            </span>
            {details}
          </figcaption>
        </figure>
      ) : (
        <ImagePreview
          kind="video"
          state={state}
          ratio={call.ratio}
          title={title}
          reason={reason}
          elapsed={running && item.since ? Math.max(0, Math.floor((now - item.since) / 1000)) : undefined}
          actions={details}
        />
      )}
      <Collapse open={open}>
        <div className="chat-tool-body">
          <span className="chat-tool-name">{item.name}</span>
          <ToolArgs args={item.args} />
          {state === "failed" && output && (
            <div className="chat-tool-output-wrap">
              <div className="chat-tool-label">{t("Error")}</div>
              <pre className="chat-tool-output is-error">{output}</pre>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
