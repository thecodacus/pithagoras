import { memo, useEffect, useState } from "react";
import { LuFileVideo, LuFolder, LuInfo, LuMessageSquare, LuRepeat, LuTrash2 } from "react-icons/lu";
import { Link, formatDateTime, msg, portal, t } from "../portal";
import { api, type GalleryVideo, type VideoJob, type VideoKind } from "./api";
import { clipSeconds, secondsLabel, videoName, type Tile } from "./videos-gallery";
import { folderName } from "./media-gallery";
import { bytesLabel, sinceThen } from "./helpers";

/**
 * The parts of the Media page (MediaPage.tsx) that are a video's: its tile in the gallery, what the viewer says of it
 * (Details), and the page's buttons in the viewer beside the viewer's own.
 */

const KIND_NAME: Record<VideoKind, string> = {
  generated: msg("Made from a description"),
  animated: msg("Made from a picture as its first frame"),
  unknown: msg("Nothing tells how it was made"),
};

/** What a tile says of how it was made, in as few words as there are room for under it. */
const KIND_SHORT: Record<VideoKind, string> = {
  generated: msg("Made"),
  animated: msg("From a picture"),
  unknown: msg("Not known"),
};

/** What the clip was made with and for, in words. */
function VideoDetails({ video }: { video: GalleryVideo }) {
  const { params } = video;
  const seconds = clipSeconds(params);
  const rows: [string, string][] = [
    [t("Made"), formatDateTime(video.createdAt)],
    [t("How"), t(KIND_NAME[video.kind])],
    // What the file is, by its first bytes: a clip a browser does not play says so.
    ...(video.format ? [[t("Format"), video.format.playable ? video.format.label : t("{format}, not played here", { format: video.format.label })] as [string, string]] : []),
    ...(video.unavailable ? [[t("Not available"), video.unavailable === "too_large" ? t("It is over 100 MB, which the portal does not play or send.") : t("Its file or its folder is out of reach for the moment.")] as [string, string]] : []),
    [
      t("Where"),
      video.chat ? t("In the chat “{chat}”", { chat: video.chat.title || t("a chat that is gone") }) : video.folder ? t("In the folder “{folder}”", { folder: folderName(video.folder) }) : t("Made here"),
    ],
    ...(params.model ? [[t("Model"), params.model] as [string, string]] : []),
    ...(params.size ? [[t("Video size"), params.size] as [string, string]] : []),
    ...(params.madeFrames !== undefined || params.frames !== undefined
      ? [[t("Frames"), params.madeFrames !== undefined && params.frames !== undefined && params.madeFrames !== params.frames ? t("{made} (asked for {asked})", { made: params.madeFrames, asked: params.frames }) : String(params.madeFrames ?? params.frames)] as [string, string]]
      : []),
    ...(params.madeFps !== undefined || params.fps !== undefined ? [[t("Frame rate"), String(params.madeFps ?? params.fps)] as [string, string]] : []),
    ...(seconds !== undefined ? [[t("Length"), secondsLabel(seconds)] as [string, string]] : []),
    ...(params.negativePrompt ? [[t("Negative prompt"), params.negativePrompt] as [string, string]] : []),
    ...(params.seed !== undefined ? [[t("Seed"), String(params.seed)] as [string, string]] : []),
    ...(params.sampleSteps !== undefined ? [[t("Steps"), String(params.sampleSteps)] as [string, string]] : []),
    ...(params.strength !== undefined ? [[t("Strength"), String(params.strength)] as [string, string]] : []),
    ...(params.firstFrame?.path ? [[t("First frame"), params.firstFrame.path] as [string, string]] : []),
    ...(params.lastFrame?.path ? [[t("Last frame"), params.lastFrame.path] as [string, string]] : []),
    [t("File"), `${video.fileName} · ${bytesLabel(video.bytes)}`],
  ];
  const [frameGone, setFrameGone] = useState(false);
  const [lastGone, setLastGone] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      {video.prompt && (
        <div>
          <p className="text-[11px] text-fg-subtle">{t("Description")}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{video.prompt}</p>
        </div>
      )}
      {params.firstFrame?.picture && !frameGone && (
        <div>
          <p className="text-[11px] text-fg-subtle">{t("First frame")}</p>
          <img src={api.galleryThumbUrl(params.firstFrame.picture)} alt={t("The picture this video starts from")} onError={() => setFrameGone(true)} className="mt-1 h-20 rounded-lg border border-line object-cover" />
        </div>
      )}
      {params.lastFrame?.picture && !lastGone && (
        <div>
          <p className="text-[11px] text-fg-subtle">{t("Last frame")}</p>
          <img src={api.galleryThumbUrl(params.lastFrame.picture)} alt={t("The picture this video ends on")} onError={() => setLastGone(true)} className="mt-1 h-20 rounded-lg border border-line object-cover" />
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-fg-subtle">{name}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-fg-muted">{value}</dd>
          </div>
        ))}
      </dl>
      {video.chat && (
        <p className="text-xs text-fg-subtle">
          <Link to={`/s/${video.chat.id}`} className="text-accent hover:underline">
            {t("Open the chat")}
          </Link>
        </p>
      )}
      {video.folder && <p className="text-xs text-fg-subtle">{t("It was found in this folder. Nothing was kept of what it was asked for, and which chat made it is not known.")}</p>}
    </div>
  );
}

/**
 * This page's buttons in the viewer, beside its own, for the clip shown. The viewer draws them again for each
 * clip, and this tells the page which it is on: to ask for more of the gallery.
 */
export function VideoViewerActions({
  video,
  makes,
  onShown,
  onAgain,
  onDelete,
}: {
  video: GalleryVideo;
  /** Whether clips can be made, which is what Run again needs. */
  makes: boolean;
  onShown: (video: GalleryVideo) => void;
  onAgain: (video: GalleryVideo) => void;
  onDelete: (video: GalleryVideo) => void;
}) {
  const { viewerButton } = portal.ui.classes;
  const [details, setDetails] = useState(false);
  useEffect(() => onShown(video), [video.id, onShown]);
  // One found in a folder has no description to make again, and one the agent made from a picture of its folder has no picture of the gallery to start from.
  const { firstFrame: first, lastFrame: last } = video.params;
  const again = makes && video.prompt !== "" && (video.kind === "generated" || (video.kind === "animated" && !!(first || last) && (!first || !!first.picture) && (!last || !!last.picture)));
  return (
    <>
      {/* Under the button on a wide screen; on a phone, over the clip, so that the buttons that close it are not under it. */}
      <div className="sm:relative">
        <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details} aria-label={t("Details")} title={t("Details")} className={viewerButton} aria-pressed={details}>
          <LuInfo aria-hidden className="h-[18px] w-[18px]" />
        </button>
        {details && (
          <div
            className="gallery-details absolute z-10 overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-pop max-sm:inset-x-2 max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-sm:max-h-[45vh] sm:right-0 sm:top-full sm:mt-1 sm:max-h-[60vh] sm:w-[26rem]"
            role="region"
            aria-label={t("Details")}
          >
            <VideoDetails video={video} />
          </div>
        )}
      </div>
      {again && (
        <button type="button" onClick={() => onAgain(video)} aria-label={t("Run again")} title={t("Run again")} className={viewerButton}>
          <LuRepeat aria-hidden className="h-[18px] w-[18px]" />
        </button>
      )}
      <button type="button" onClick={() => onDelete(video)} aria-label={t("Delete")} title={t("Delete")} className={`${viewerButton} hover:!bg-danger/10 hover:!text-danger`}>
        <LuTrash2 aria-hidden className="h-[18px] w-[18px]" />
      </button>
    </>
  );
}

/** Whether a browser plays the clip here: a WebM and an MP4 do, and a server that says nothing of its files is taken to have clips that do. */
export const playsHere = (video: GalleryVideo): boolean => video.format?.playable !== false;

/** What a job's state is to the preview. */
const previewState = (job: VideoJob | undefined) => (!job ? "done" : job.state === "running" ? "making" : job.state === "failed" ? "failed" : "done");

/** Where a clip that is being made is, in words: waiting its turn on the server (and which place it has), or being made. */
function stageText(job: VideoJob): string | undefined {
  if (job.stage === "waiting") return job.queuePosition ? t("Waiting its turn on the server: place {n}", { n: job.queuePosition }) : t("Waiting its turn on the server");
  if (job.stage === "making") return t("Being made on the server");
  return undefined;
}

export const VideoTile = memo(function VideoTile({
  tile,
  selected,
  selectable,
  onOpen,
  onToggle,
  onDismiss,
}: {
  tile: Tile;
  selected: boolean;
  /** Whether it has a box to select it with: not while the boxes are the pictures of an edit, which a video is not one of. */
  selectable: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { ui } = portal;
  const { video, job } = tile;
  const state = previewState(job);
  const id = video?.id ?? job?.videoId;
  const making = state === "making";
  const now = ui.useNow(making);
  const here = state === "done" && id;
  const name = video ? videoName(video) : job?.prompt || "";
  const seconds = video ? clipSeconds(video.params) : undefined;
  // A file a browser does not play is shown as what it is, and opened to be downloaded.
  const kept = here && video && !playsHere(video);
  return (
    <div className={`gallery-tile${selected ? " is-selected" : ""}`}>
      {kept ? (
        <button type="button" className="gallery-type-tile" data-picture-id={id} aria-haspopup="dialog" aria-label={name} title={video.prompt || video.fileName} onClick={() => onOpen(id)}>
          <LuFileVideo aria-hidden />
          <b>{video.format.label}</b>
          <small>{t("A browser cannot play it here")}</small>
        </button>
      ) : (
        <ui.ImagePreview
          kind="video"
          state={state}
          src={here && video?.poster ? api.videoPosterUrl(id) : undefined}
          video={here ? api.videoFileUrl(id) : undefined}
          ratio={1}
          title={video?.prompt || job?.prompt || video?.fileName}
          reason={job?.error}
          detail={making && job ? stageText(job) : undefined}
          elapsed={making && job ? Math.max(0, Math.floor((now - job.startedAt) / 1000)) : undefined}
          pictureId={here ? id : undefined}
          onOpen={here ? () => onOpen(here) : undefined}
          actions={
            job && state !== "done" ? (
              <button type="button" className="gallery-tile-action" onClick={() => onDismiss(job.id)}>
                {making ? t("Stop") : t("Dismiss")}
              </button>
            ) : undefined
          }
        />
      )}
      {here && selectable && (
        // The box has a place of its own that a thumb can find, and a name that says which clip it is for.
        <label className="gallery-check-hit">
          <input type="checkbox" className="gallery-check" checked={selected} onChange={() => onToggle(id)} aria-label={t("Select {name}", { name })} />
        </label>
      )}
      {video && (
        <p className="gallery-meta">
          {video.chat ? <LuMessageSquare aria-hidden /> : video.folder && <LuFolder aria-hidden />}
          <span className="truncate" title={video.folder ? t("In the folder “{folder}”", { folder: folderName(video.folder) }) : t(KIND_NAME[video.kind])}>
            {video.chat ? video.chat.title || t("a chat that is gone") : video.folder ? folderName(video.folder) : t(KIND_SHORT[video.kind])}
          </span>
          {seconds !== undefined && <span className="gallery-length">{secondsLabel(seconds)}</span>}
          <time dateTime={new Date(video.createdAt).toISOString()} title={formatDateTime(video.createdAt)}>
            {sinceThen(video.createdAt, { dateAfterDays: 7, dateFormat: { month: "short", day: "numeric" } })}
          </time>
        </p>
      )}
    </div>
  );
});
