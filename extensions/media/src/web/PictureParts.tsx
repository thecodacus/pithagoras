import { memo, useEffect, useState } from "react";
import { LuCheck, LuFolder, LuInfo, LuMessageSquare, LuRepeat, LuTrash2, LuVideo, LuWandSparkles } from "react-icons/lu";
import { Link, formatDateTime, msg, portal, t, tp } from "../portal";
import { api, type GalleryPicture, type PictureJob, type PictureKind } from "./api";
import { MAX_SOURCES, sourceName } from "./edit-sources";
import { fieldsText, type Tile } from "./images-gallery";
import { folderName } from "./media-gallery";
import { bytesLabel, sinceThen } from "./helpers";

/**
 * The parts of the Media page (MediaPage.tsx) that are a picture's: its tile in the gallery, what the viewer says of it
 * (Details), and the page's buttons in the viewer beside the viewer's own.
 */

const KIND_NAME: Record<PictureKind, string> = {
  generated: msg("Made from a description"),
  edited: msg("Changed from another picture"),
  uploaded: msg("From this computer"),
  unknown: msg("Nothing tells how it was made"),
};

/** What a tile says of how it was made, in as few words as there are room for under it. */
const KIND_SHORT: Record<PictureKind, string> = {
  generated: msg("Made"),
  edited: msg("Changed"),
  uploaded: msg("Uploaded"),
  unknown: msg("Not known"),
};

/** What the picture was made with and for, in words. */
function PictureDetails({ picture }: { picture: GalleryPicture }) {
  const { params } = picture;
  const extra = fieldsText(params.extra);
  const rows: [string, string][] = [
    [t("Made"), formatDateTime(picture.createdAt)],
    [t("How"), t(KIND_NAME[picture.kind])],
    [
      t("Where"),
      picture.chat ? t("In the chat “{chat}”", { chat: picture.chat.title || t("a chat that is gone") }) : picture.folder ? t("In the folder “{folder}”", { folder: folderName(picture.folder) }) : t("Made here"),
    ],
    ...(params.model ? [[t("Model"), params.model] as [string, string]] : []),
    ...(params.size ? [[t("Picture size"), params.size] as [string, string]] : []),
    ...(params.outputFormat ? [[t("File format"), params.outputFormat.toUpperCase()] as [string, string]] : []),
    ...(params.outputCompression !== undefined ? [[t("Compression"), String(params.outputCompression)] as [string, string]] : []),
    ...(params.negativePrompt ? [[t("Negative prompt"), params.negativePrompt] as [string, string]] : []),
    ...(params.seed !== undefined ? [[t("Seed"), String(params.seed)] as [string, string]] : []),
    ...(params.sampleSteps !== undefined ? [[t("Steps"), String(params.sampleSteps)] as [string, string]] : []),
    ...(params.strength !== undefined ? [[t("Strength"), String(params.strength)] as [string, string]] : []),
    ...(params.fromNoise ? [[t("Start from"), t("Noise only")] as [string, string]] : []),
    ...(extra ? [[t("Other fields of the request"), extra] as [string, string]] : []),
    ...(params.sources?.length ? [[t("Changed from"), tp(params.sources.length, "{n} picture", "{n} pictures")] as [string, string]] : []),
    ...(params.references?.length ? [[t("Reference pictures"), tp(params.references.length, "{n} picture", "{n} pictures")] as [string, string]] : []),
    ...(params.masked ? [[t("Mask"), t("Only a painted part was changed")] as [string, string]] : []),
    [t("File"), `${picture.fileName} · ${bytesLabel(picture.bytes)}`],
  ];
  return (
    <div className="space-y-3 text-sm">
      {picture.prompt && (
        <div>
          <p className="text-[11px] text-fg-subtle">{picture.kind === "uploaded" ? t("Name") : t("Description")}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{picture.prompt}</p>
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
      {picture.chat && (
        <p className="text-xs text-fg-subtle">
          <Link to={`/s/${picture.chat.id}`} className="text-accent hover:underline">
            {t("Open the chat")}
          </Link>
        </p>
      )}
      {picture.folder && <p className="text-xs text-fg-subtle">{t("It was found in this folder. Nothing was kept of what it was asked for, and which chat made it is not known.")}</p>}
    </div>
  );
}

/**
 * This page's buttons in the viewer, beside its own, for the picture shown. The
 * viewer draws them again for each picture, and this tells the page which it is
 * on: to ask for more of the gallery, and for an original that is not loaded.
 */
export function PictureViewerActions({
  picture,
  makes,
  canEdit,
  onVideo,
  onShown,
  onEdit,
  use,
  onAgain,
  onDelete,
}: {
  picture: GalleryPicture;
  /** Whether pictures can be made, and whether they can be changed: what the buttons that make one again say. */
  makes: boolean;
  canEdit: boolean;
  /** Where video generation is on: starts a video from this picture, as its first frame. */
  onVideo?: (picture: GalleryPicture) => void;
  onShown: (picture: GalleryPicture) => void;
  onEdit: (picture: GalleryPicture) => void;
  /** Where the form is in Edit, or has a new picture's references open (`as`): whether this picture is one of them, whether there are all there may be, and a way to take it in or out. */
  use?: { on: boolean; full: boolean; toggle: () => void; as: "edit" | "reference" };
  onAgain: (picture: GalleryPicture) => void;
  onDelete: (picture: GalleryPicture) => void;
}) {
  const { viewerButton } = portal.ui.classes;
  const [details, setDetails] = useState(false);
  useEffect(() => onShown(picture), [picture.id, onShown]);
  // A picture put in by the person has no description to make again. One made with references is made again with them, by the editing endpoint.
  const again = picture.kind !== "uploaded" && picture.prompt !== "" && (picture.kind === "generated" ? makes && (!picture.params.references?.length || canEdit) : canEdit);
  return (
    <>
      {/* Under the button on a wide screen; on a phone, above the zoom buttons, over the picture, so that the buttons that close it are not under it. */}
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
            <PictureDetails picture={picture} />
          </div>
        )}
      </div>
      {use ? (
        // The same choice as the box on the tile, so that a picture can be looked at before it is taken in; it does not replace what is there.
        <button
          type="button"
          onClick={use.toggle}
          disabled={use.full && !use.on}
          aria-pressed={use.on}
          aria-label={use.as === "reference" ? t("Use as a reference") : t("Use in the edit")}
          title={
            use.as === "reference"
              ? use.on
                ? t("Take out of the references")
                : use.full
                  ? t("A picture takes at most {n} references", { n: MAX_SOURCES })
                  : t("Use as a reference")
              : use.on
                ? t("Take out of the edit")
                : use.full
                  ? t("An edit takes at most {n} pictures", { n: MAX_SOURCES })
                  : t("Use in the edit")
          }
          className={viewerButton}
        >
          {use.on ? <LuCheck aria-hidden className="h-[18px] w-[18px]" /> : <LuWandSparkles aria-hidden className="h-[18px] w-[18px]" />}
        </button>
      ) : (
        // Always there: where editing is not set up it leads to the form, which says so and where to switch it on.
        <button type="button" onClick={() => onEdit(picture)} aria-label={t("Edit it")} title={canEdit ? t("Edit it") : t("Edit it (editing is not set up)")} className={viewerButton}>
          <LuWandSparkles aria-hidden className="h-[18px] w-[18px]" />
        </button>
      )}
      {onVideo && (
        // To the form for videos, with this picture as the first frame.
        <button type="button" onClick={() => onVideo(picture)} aria-label={t("Make a video from it")} title={t("Make a video from it")} className={viewerButton}>
          <LuVideo aria-hidden className="h-[18px] w-[18px]" />
        </button>
      )}
      {again && (
        <button type="button" onClick={() => onAgain(picture)} aria-label={t("Run again")} title={t("Run again")} className={viewerButton}>
          <LuRepeat aria-hidden className="h-[18px] w-[18px]" />
        </button>
      )}
      <button type="button" onClick={() => onDelete(picture)} aria-label={t("Delete")} title={t("Delete")} className={`${viewerButton} hover:!bg-danger/10 hover:!text-danger`}>
        <LuTrash2 aria-hidden className="h-[18px] w-[18px]" />
      </button>
    </>
  );
}

/** What a job's state is to the preview. */
const previewState = (job: PictureJob | undefined) => (!job ? "done" : job.state === "running" ? "making" : job.state === "failed" ? "failed" : "done");

/**
 * A click on a tile's picture, or Enter on it, opens it in the viewer, always. What the box in its corner does is the
 * mode: it selects the picture, for a download, a delete or a change (select), takes it into the edit that the
 * form is in (pick), or into the references of the new picture it is making (reference).
 */
type TileMode = "select" | "pick" | "reference";

export const PictureTile = memo(function PictureTile({
  tile,
  mode,
  selected,
  place,
  full,
  onOpen,
  onToggle,
  onDismiss,
}: {
  tile: Tile;
  mode: TileMode;
  selected: boolean;
  /** Its place among the pictures of the edit, or the references, for one that is in them and where several can be; none is 0. */
  place: number;
  /** Picking, and the edit, or the references, have all there may be: this one is not in them, and cannot be added. */
  full: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { ui } = portal;
  const { picture, job } = tile;
  const state = previewState(job);
  const id = picture?.id ?? job?.pictureId;
  const making = state === "making";
  const now = ui.useNow(making);
  const here = state === "done" && id;
  const name = picture ? sourceName(picture) : job?.prompt || "";
  return (
    <div className={`gallery-tile${selected ? " is-selected" : ""}${full ? " is-locked" : ""}`}>
      <ui.ImagePreview
        state={state}
        edit={job?.kind === "edit" || picture?.kind === "edited"}
        src={here ? (picture?.thumb ? api.galleryThumbUrl(id) : api.galleryFileUrl(id)) : undefined}
        before={job?.from && making ? api.galleryFileUrl(job.from) : undefined}
        ratio={1}
        title={picture?.prompt || job?.prompt || picture?.fileName}
        reason={job?.error}
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
      {here && (
        // The box has a place of its own that a thumb can find, and a name that says which picture it is for.
        <label className="gallery-check-hit" title={full ? (mode === "reference" ? t("A picture takes at most {n} references", { n: MAX_SOURCES }) : t("An edit takes at most {n} pictures", { n: MAX_SOURCES })) : undefined}>
          <input
            type="checkbox"
            className="gallery-check"
            checked={selected}
            disabled={full}
            onChange={() => onToggle(id)}
            aria-label={mode === "pick" ? t("Use {name} in the edit", { name }) : mode === "reference" ? t("Use {name} as a reference", { name }) : t("Select {name}", { name })}
          />
        </label>
      )}
      {mode !== "select" && selected && place > 0 && (
        <span className="gallery-order" aria-hidden>
          {place}
        </span>
      )}
      {picture && (
        <p className="gallery-meta">
          {picture.chat ? <LuMessageSquare aria-hidden /> : picture.folder && <LuFolder aria-hidden />}
          <span className="truncate" title={picture.folder ? t("In the folder “{folder}”", { folder: folderName(picture.folder) }) : t(KIND_NAME[picture.kind])}>
            {picture.chat ? picture.chat.title || t("a chat that is gone") : picture.folder ? folderName(picture.folder) : t(KIND_SHORT[picture.kind])}
          </span>
          <time dateTime={new Date(picture.createdAt).toISOString()} title={formatDateTime(picture.createdAt)}>
            {sinceThen(picture.createdAt, { dateAfterDays: 7, dateFormat: { month: "short", day: "numeric" } })}
          </time>
        </p>
      )}
    </div>
  );
});
