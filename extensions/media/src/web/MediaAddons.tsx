import { useEffect, useRef, useState } from "react";
import { LuRefreshCw, LuTriangleAlert } from "react-icons/lu";
import { local, portal, t, tp, tx } from "../portal";
import { api, type ImagesFeaturePatch, type VideosFeaturePatch } from "./api";
import { mediaChanged } from "./changes";
import { MAX_SIZE, TIMEOUT_SECONDS } from "../server/image-settings";
import { VIDEO_LIMITS, VIDEO_TIMEOUT_SECONDS } from "../server/video-settings";

/**
 * The settings of the two endpoints, each a section of Media's page in Settings
 * that opens and closes, with its switches in view either way: the image model
 * behind making and changing pictures, and the video model behind making
 * videos. What the agent gets of them is the server half's to say from these.
 */

/**
 * A section's first read. Until it has come there is nothing to show, so a failure
 * is said where the section would be, with a way to try again; a banner over a
 * section that spins on forever said it too quietly.
 */
function useFirstRead<T>(read: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState<Error | null>(null);
  const retry = () =>
    read().then(
      (v) => {
        setFailed(null);
        setValue(v);
      },
      (e: Error) => setFailed(e),
    );
  useEffect(() => {
    void retry();
  }, []);
  return [value, setValue, failed, retry] as const;
}

/** What a switch did to the chats that are open. */
function reloadNote(waiting: number): string {
  return waiting
    ? tp(waiting, "Idle chats have it now; one busy chat has it from its next step.", "Idle chats have it now; {n} busy chats have it from their next step.")
    : t("Chats have it from now on.");
}

/** The form's copy of the image endpoint's settings, before they are saved. */
interface ImagesDraft {
  baseUrl: string;
  model: string;
  size: string;
  /** As typed: whole seconds, or not yet. */
  timeout: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** What the server takes as a time limit, in seconds. */
const TIMEOUT = TIMEOUT_SECONDS;
/** Empty is the default, as it is for the model and the size: it takes a saved limit away. */
const timeoutOk = (typed: string, limits: { min: number; max: number } = TIMEOUT) => typed.trim() === "" || (/^\d+$/.test(typed.trim()) && Number(typed) >= limits.min && Number(typed) <= limits.max);

/** The same for editing, which has its own address, model and key. */
interface ImagesEditDraft {
  baseUrl: string;
  model: string;
  /** As typed: "2048x2048", or empty for no limit. */
  maxSize: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** What the server takes as a maximum size: empty is none. */
const maxSizeOk = (typed: string) => typed.trim() === "" || MAX_SIZE.test(typed.trim());

const originOf = (address: string): string => {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
};

/** The host of an address, for a summary: what a person knows a server by. */
const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

/** Kept under the name it had while Media was the portal's own, so that each section opens as it did. */
const OPEN_KEY = "pithagoras.settings.media-open";

/**
 * Whether the section of a model is open: the person's last choice, kept in this browser, else open while the model
 * is not set up. Which of the two was decided when its settings were first read, so that saving the address does not
 * close the section under the hand. `setUp` is undefined until they are read; `locked` keeps it open.
 */
function useSectionOpen(id: "image" | "video", setUp: boolean | undefined, locked: boolean): [boolean, () => void] {
  const [picked, setPicked] = useState<boolean | null>(() => {
    try {
      const kept = JSON.parse(local.get(OPEN_KEY) ?? "{}")[id];
      return typeof kept === "boolean" ? kept : null;
    } catch {
      return null;
    }
  });
  const first = useRef<boolean | undefined>(undefined);
  if (first.current === undefined && setUp !== undefined) first.current = !setUp;
  const open = locked || (picked ?? first.current ?? true);
  const toggle = () => {
    const next = !open;
    setPicked(next);
    try {
      local.set(OPEN_KEY, JSON.stringify({ ...JSON.parse(local.get(OPEN_KEY) ?? "{}"), [id]: next }));
    } catch {
      // Not remembered, but the section works.
    }
  };
  return [open, toggle];
}

/**
 * A model's section while its settings are being read, or could not be. Not a section a search can name: one that
 * does would be found and lit up here, and the section that replaces it would be neither.
 */
function ModelPending({ title, failed, onRetry }: { title: string; failed: Error | null; onRetry: () => unknown }) {
  const { ui } = portal;
  return (
    <div className="mb-7">
      <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</p>
      <div className="mt-2.5">{failed ? <ui.LoadFailed error={failed} onRetry={onRetry} /> : <p className="flex items-center gap-2 text-sm text-fg-subtle"><LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}</p>}</div>
    </div>
  );
}

export function ImagesAddon({ onError }: { onError: (e: string) => void }) {
  const { ui } = portal;
  const { input: inputCls, primary: primaryCls } = ui.classes;
  // Its own, apart from the video endpoint's: one that cannot be read is not the other's to wait on.
  const [images, setImages, failed, retry] = useFirstRead(() => api.imagesFeature().then((r) => r.images));
  const [draft, setDraft] = useState<ImagesDraft | null>(null);
  const [editDraft, setEditDraft] = useState<ImagesEditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  ui.useUnsavedDraft(!!draft || !!editDraft);
  const [open, toggle] = useSectionOpen("image", images ? images.baseUrl !== "" : undefined, !!draft || !!editDraft);

  if (!images) return <ModelPending title={t("Image model")} failed={failed} onRetry={retry} />;
  const form = draft ?? { baseUrl: images.baseUrl, model: images.model, size: images.size, timeout: String(images.timeoutSeconds), apiKey: "" };
  const edit = (patch: Partial<ImagesDraft>) => setDraft({ ...form, ...patch });
  const editForm = editDraft ?? { baseUrl: images.editBaseUrl, model: images.editModel, maxSize: images.editMaxSize, apiKey: "" };
  const editEdit = (patch: Partial<ImagesEditDraft>) => setEditDraft({ ...editForm, ...patch });
  // The key of generation goes along when edits go to the same server and have none of their own: the server says the same.
  const usesKeyAbove = images.keySet && !images.editKeySet && originOf(editForm.baseUrl || images.baseUrl) === originOf(images.baseUrl);

  const change = async (patch: ImagesFeaturePatch) => {
    setBusy(true);
    setNote(null);
    try {
      const { images: saved, changed, waiting } = await api.setImagesFeature(patch);
      setImages(saved);
      // The form's settings are saved now, so it shows them as the server has them; the key typed is not shown again.
      if (patch.baseUrl !== undefined) setDraft(null);
      if (patch.editBaseUrl !== undefined) setEditDraft(null);
      if (changed) setNote(() => () => reloadNote(waiting));
      // The Media page is in the sidebar while there is an endpoint to make pictures with.
      mediaChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <ui.CollapsibleSection
      title={t("Image model")}
      hint={t("Making and changing pictures, on the Media page and for the agent.")}
      summary={draft || editDraft ? t("Unsaved changes") : images.baseUrl ? [hostOf(images.baseUrl), images.model].filter(Boolean).join(" · ") : t("Not set up")}
      open={open}
      onToggle={toggle}
      locked={!!draft || !!editDraft}
      controls={
        <>
          <ui.SwitchRow
            title={t("Image generation")}
            detail={images.enabled ? t("On: pictures are made on the Media page and by the agent.") : t("Off: no pictures are made.")}
            on={images.enabled}
            onChange={(enabled) => void change({ enabled })}
            disabled={busy || !!draft || (!images.baseUrl && !images.enabled)}
            note={draft ? t("Save or discard the changes first.") : !images.baseUrl && !images.enabled ? t("Save the address of an image endpoint first.") : undefined}
          />
          <ui.SwitchRow
            title={t("Image editing")}
            detail={images.editEnabled ? t("On: pictures are changed, and used as references for new ones, on the Media page and by the agent.") : t("Off: no pictures are changed or used as references.")}
            on={images.editEnabled}
            onChange={(editEnabled) => void change({ editEnabled })}
            disabled={busy || !!editDraft || (!(images.editBaseUrl || images.baseUrl) && !images.editEnabled)}
            note={editDraft ? t("Save or discard the changes first.") : !(images.editBaseUrl || images.baseUrl) && !images.editEnabled ? t("Save the address of an image endpoint first.") : undefined}
          />
          {busy && (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Applying…")}
            </p>
          )}
          {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
        </>
      }
    >
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
        <legend className="px-1 text-xs text-fg-muted">{t("The image endpoint")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-fg-muted sm:col-span-2">
            {t("API address")}
            <input
              value={form.baseUrl}
              onChange={(e) => edit({ baseUrl: e.target.value })}
              placeholder="https://images.example.com/v1"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("API key")}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => edit({ apiKey: e.target.value })}
              placeholder={images.keySet ? t("saved — type to replace") : t("none needed for a local server")}
              autoComplete="off"
              className={`${inputCls} mt-1 text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Model")}
            <input
              value={form.model}
              onChange={(e) => edit({ model: e.target.value })}
              placeholder="image-model"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Picture size")}
            <input
              value={form.size}
              onChange={(e) => edit({ size: e.target.value })}
              placeholder="1024x1024"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Time limit (seconds)")}
            <input
              inputMode="numeric"
              value={form.timeout}
              onChange={(e) => edit({ timeout: e.target.value })}
              placeholder={String(TIMEOUT.default)}
              aria-invalid={!timeoutOk(form.timeout)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
        </div>
        <p className="text-[11px] text-fg-faint">
          {tx("Any server with an OpenAI-style {route}. The key goes only to this address. Empty model and size mean the server's own.", { route: <code>images/generations</code> })}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The time limit is how long the portal waits for one picture: {min} to {max} seconds, {default} by default.", TIMEOUT)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <button
              type="button"
              className={primaryCls}
              disabled={!timeoutOk(form.timeout)}
              onClick={() =>
                void change({
                  baseUrl: form.baseUrl,
                  model: form.model,
                  size: form.size,
                  // Only when changed, so that saving the rest does not state a limit the person never chose.
                  ...(form.timeout.trim() === "" ? { timeoutSeconds: null } : Number(form.timeout) !== images.timeoutSeconds ? { timeoutSeconds: Number(form.timeout) } : {}),
                  ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                })
              }
            >
              {t("Save")}
            </button>
          )}
          {draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setDraft(null)}>
              {t("Discard")}
            </button>
          )}
          {images.keySet && !draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ apiKey: "" })}>
              {t("Remove the saved key")}
            </button>
          )}
        </div>
      </fieldset>

      <ui.DetailsGroup
        title={t("Editing endpoint")}
        summary={editDraft ? t("Unsaved changes") : images.editBaseUrl ? hostOf(images.editBaseUrl) : t("Uses the image endpoint")}
        defaultOpen={!!(images.editBaseUrl || images.editModel || images.editMaxSize)}
      >
        <fieldset disabled={busy} className="space-y-3">
          <p className="text-[11px] text-fg-faint">
            {tx("Changing pictures that exist, with an OpenAI-style {route}. The original stays; the result is a new picture.", { route: <code>images/edits</code> })}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-fg-muted sm:col-span-2">
              {t("Editing address")}
              <input
                value={editForm.baseUrl}
                onChange={(e) => editEdit({ baseUrl: e.target.value })}
                placeholder={images.baseUrl || "https://images.example.com/v1"}
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Editing key")}
              <input
                type="password"
                value={editForm.apiKey}
                onChange={(e) => editEdit({ apiKey: e.target.value })}
                placeholder={images.editKeySet ? t("saved — type to replace") : usesKeyAbove ? t("the key above is used") : t("none needed for a local server")}
                autoComplete="off"
                className={`${inputCls} mt-1 text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Editing model")}
              <input
                value={editForm.model}
                onChange={(e) => editEdit({ model: e.target.value })}
                placeholder="image-edit-model"
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Maximum picture size")}
              <input
                value={editForm.maxSize}
                onChange={(e) => editEdit({ maxSize: e.target.value })}
                placeholder="2048x2048"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!maxSizeOk(editForm.maxSize)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
          </div>
          <p className="text-[11px] text-fg-faint">
            {t("Leave the address empty to edit with the server above, and the model empty for the server's own. A key goes only to the address it was given for.")}
          </p>
          <p className="text-[11px] text-fg-faint">
            {t("The maximum picture size is the most pixels a picture sent to be edited may have, such as 2048x2048. Empty is no limit.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {editDraft && (
              <button
                type="button"
                className={primaryCls}
                disabled={!maxSizeOk(editForm.maxSize)}
                onClick={() => void change({ editBaseUrl: editForm.baseUrl, editModel: editForm.model, ...(editForm.maxSize.trim() !== images.editMaxSize ? { editMaxSize: editForm.maxSize.trim() } : {}), ...(editForm.apiKey ? { editApiKey: editForm.apiKey } : {}) })}
              >
                {t("Save")}
              </button>
            )}
            {editDraft && (
              <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setEditDraft(null)}>
                {t("Discard")}
              </button>
            )}
            {images.editKeySet && !editDraft && (
              <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ editApiKey: "" })}>
                {t("Remove the saved editing key")}
              </button>
            )}
          </div>
        </fieldset>
      </ui.DetailsGroup>

      <ui.DetailsGroup title={t("More options")} summary={[images.editMultiple && t("Several pictures per edit"), images.sdExtras && t("Stable Diffusion extra settings")].filter(Boolean).join(" · ") || t("None on")}>
        <ui.SwitchRow
          title={t("Several pictures per edit")}
          detail={images.editMultiple ? t("On: an edit takes up to eight pictures.") : t("Off: an edit takes one picture.")}
          on={images.editMultiple}
          onChange={(editMultiple) => void change({ editMultiple })}
          disabled={busy || !!editDraft}
        />
        <p className="text-[11px] text-fg-faint">
          {t("Switch it on only if the editing endpoint takes more than one picture in a request.")}
        </p>
        <ui.SwitchRow
          title={t("Stable Diffusion extra settings")}
          detail={
            images.sdExtras
              ? t("On: the Media page shows stable-diffusion.cpp settings under Advanced.")
              : t("Off: the Media page shows only the settings of the OpenAI image format.")
          }
          on={images.sdExtras}
          onChange={(sdExtras) => void change({ sdExtras })}
          // Saving a new address of another server takes it off again, so it waits for the save as the other switches of the endpoint do.
          disabled={busy || !!draft || !!editDraft}
        />
        <p className="text-[11px] text-fg-faint">
          {t("Only for a stable-diffusion.cpp server: it adds a seed, steps, a negative prompt and, for edits, a strength and starting from noise, as a block in the description. Any other endpoint would take the block as part of the description. A new picture made with reference pictures, on the Media page or by the agent, starts from noise only while this is on: off, a stable-diffusion.cpp server starts from the first reference.")}
        </p>
      </ui.DetailsGroup>
    </ui.CollapsibleSection>
  );
}

/** The form's copy of the video endpoint's settings, before they are saved. */
interface VideosDraft {
  baseUrl: string;
  model: string;
  size: string;
  /** As typed: whole numbers, or empty for the endpoint's own. */
  frames: string;
  fps: string;
  timeout: string;
  /** As typed: whole megabytes, or empty for no limit. */
  storage: string;
  /** Typed anew; empty keeps the one saved. */
  apiKey: string;
}

/** A setting that is a whole number in a range, or empty for none. */
const wholeOrEmpty = (typed: string, min: number, max: number) => typed.trim() === "" || (/^\d+$/.test(typed.trim()) && Number(typed) >= min && Number(typed) <= max);
const STORAGE_MB = { min: 1, max: 100_000_000 };

export function VideosAddon({ onError }: { onError: (e: string) => void }) {
  const { ui } = portal;
  const { input: inputCls, primary: primaryCls } = ui.classes;
  // Its own, as the image endpoint's is.
  const [videos, setVideos, failed, retry] = useFirstRead(() => api.videosFeature().then((r) => r.videos));
  const [draft, setDraft] = useState<VideosDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Said in the language shown, whenever it is drawn.
  const [note, setNote] = useState<(() => string) | null>(null);
  // What is changed here and not saved is in no other place.
  ui.useUnsavedDraft(!!draft);
  const [open, toggle] = useSectionOpen("video", videos ? videos.baseUrl !== "" : undefined, !!draft);

  if (!videos) return <ModelPending title={t("Video model")} failed={failed} onRetry={retry} />;
  const form: VideosDraft = draft ?? {
    baseUrl: videos.baseUrl,
    model: videos.model,
    size: videos.size,
    frames: videos.frames === null ? "" : String(videos.frames),
    fps: videos.fps === null ? "" : String(videos.fps),
    timeout: String(videos.timeoutSeconds),
    storage: videos.storageLimitMb ? String(videos.storageLimitMb) : "",
    apiKey: "",
  };
  const edit = (patch: Partial<VideosDraft>) => setDraft({ ...form, ...patch });
  const valid =
    timeoutOk(form.timeout, VIDEO_TIMEOUT_SECONDS) &&
    wholeOrEmpty(form.frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max) &&
    wholeOrEmpty(form.fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max) &&
    wholeOrEmpty(form.storage, STORAGE_MB.min, STORAGE_MB.max);

  const change = async (patch: VideosFeaturePatch) => {
    setBusy(true);
    setNote(null);
    try {
      const { videos: saved, changed, waiting } = await api.setVideosFeature(patch);
      setVideos(saved);
      // The form's settings are saved now, so it shows them as the server has them; the key typed is not shown again.
      if (patch.baseUrl !== undefined) setDraft(null);
      if (changed) setNote(() => () => reloadNote(waiting));
      // The Media page is in the sidebar while there is an endpoint to make videos with.
      mediaChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** A number setting as it is sent: only when it differs from the saved one, so that saving the rest does not state a value the person never chose. */
  const numberPatch = <K extends "frames" | "fps" | "storageLimitMb">(name: K, typed: string, saved: number | null): Partial<Record<K, number | null>> => {
    const next = typed.trim() === "" ? null : Number(typed);
    return (next === saved ? {} : { [name]: next }) as Partial<Record<K, number | null>>;
  };

  // What a video address has to be, said where it is typed while the section is open and under its heading while it is closed, so that it is seen either way.
  const works = (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-muted">
      <LuTriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
      <div className="space-y-1">
        <p>
          {tx("Only a stable-diffusion.cpp server works, through its native API ({route}) with a video model started on it. An OpenAI-style /v1 endpoint or another video server does not.", { route: <code>/sdcpp/v1</code> })}
        </p>
        <p>{tx("Through llama-swap the address is {upstream}.", { upstream: <code>{"http://host:port/upstream/<model>"}</code> })}</p>
      </div>
    </div>
  );

  return (
    <ui.CollapsibleSection
      title={t("Video model")}
      hint={t("Making videos, on the Media page and for the agent.")}
      summary={draft ? t("Unsaved changes") : videos.baseUrl ? [hostOf(videos.baseUrl), videos.model].filter(Boolean).join(" · ") : t("Not set up")}
      open={open}
      onToggle={toggle}
      locked={!!draft}
      controls={
        <>
          <ui.SwitchRow
            title={t("Video generation")}
            detail={videos.enabled ? t("On: videos are made on the Media page and by the agent.") : t("Off: no videos are made.")}
            on={videos.enabled}
            onChange={(enabled) => void change({ enabled })}
            disabled={busy || !!draft || (!videos.baseUrl && !videos.enabled)}
            note={draft ? t("Save or discard the changes first.") : !videos.baseUrl && !videos.enabled ? t("Save the address of a video endpoint first.") : undefined}
          />
          {busy && (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Applying…")}
            </p>
          )}
          {note && !busy && <p role="status" className="text-xs text-fg-muted">{note()}</p>}
        </>
      }
      whileClosed={works}
    >
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
        <legend className="px-1 text-xs text-fg-muted">{t("The video endpoint")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-fg-muted sm:col-span-2">
            {t("API address")}
            <input
              value={form.baseUrl}
              onChange={(e) => edit({ baseUrl: e.target.value })}
              placeholder="https://video.example.com"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          {open && <div className="sm:col-span-2">{works}</div>}
          <label className="text-xs text-fg-muted">
            {t("API key")}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => edit({ apiKey: e.target.value })}
              placeholder={videos.keySet ? t("saved — type to replace") : t("none needed for a local server")}
              autoComplete="off"
              className={`${inputCls} mt-1 text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Model")}
            <input
              value={form.model}
              onChange={(e) => edit({ model: e.target.value })}
              placeholder="video-model"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
            <label className="text-xs text-fg-muted">
              {t("Video size")}
              <input
                value={form.size}
                onChange={(e) => edit({ size: e.target.value })}
                placeholder="832x480"
                spellCheck={false}
                autoComplete="off"
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Frames")}
              <input
                inputMode="numeric"
                value={form.frames}
                onChange={(e) => edit({ frames: e.target.value })}
                placeholder={t("the server's own")}
                aria-invalid={!wholeOrEmpty(form.frames, VIDEO_LIMITS.frames.min, VIDEO_LIMITS.frames.max)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              {t("Frame rate")}
              <input
                inputMode="numeric"
                value={form.fps}
                onChange={(e) => edit({ fps: e.target.value })}
                placeholder={t("the server's own")}
                aria-invalid={!wholeOrEmpty(form.fps, VIDEO_LIMITS.fps.min, VIDEO_LIMITS.fps.max)}
                className={`${inputCls} mt-1 font-mono text-xs`}
              />
            </label>
          </div>
          <label className="text-xs text-fg-muted">
            {t("Time limit (seconds)")}
            <input
              inputMode="numeric"
              value={form.timeout}
              onChange={(e) => edit({ timeout: e.target.value })}
              placeholder={String(VIDEO_TIMEOUT_SECONDS.default)}
              aria-invalid={!timeoutOk(form.timeout, VIDEO_TIMEOUT_SECONDS)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Disk limit (MB)")}
            <input
              inputMode="numeric"
              value={form.storage}
              onChange={(e) => edit({ storage: e.target.value })}
              placeholder={t("no limit")}
              aria-invalid={!wholeOrEmpty(form.storage, STORAGE_MB.min, STORAGE_MB.max)}
              className={`${inputCls} mt-1 font-mono text-xs`}
            />
          </label>
        </div>
        <p className="text-[11px] text-fg-faint">
          {tx("The address of a {server} server, such as {example}. The key goes only to this address. Empty model, size, frames and frame rate mean the server's own.", {
            server: <b>{(videos.backends.find((b) => b.id === videos.backend) ?? videos.backends[0])?.label ?? "stable-diffusion.cpp"}</b>,
            example: <code>http://localhost:1234</code>,
          })}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The time limit is how long the portal waits for one video, in the server's queue and while it is made: {min} to {max} seconds, {default} by default.", VIDEO_TIMEOUT_SECONDS)}
        </p>
        <p className="text-[11px] text-fg-faint">
          {t("The disk limit is what the videos made on the Media page may take together; at the limit no new one is made there. Empty is no limit.")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <button
              type="button"
              className={primaryCls}
              disabled={!valid}
              onClick={() =>
                void change({
                  baseUrl: form.baseUrl,
                  model: form.model,
                  size: form.size,
                  ...numberPatch("frames", form.frames, videos.frames),
                  ...numberPatch("fps", form.fps, videos.fps),
                  ...numberPatch("storageLimitMb", form.storage, videos.storageLimitMb || null),
                  // Only when changed, so that saving the rest does not state a limit the person never chose.
                  ...(form.timeout.trim() === "" ? { timeoutSeconds: null } : Number(form.timeout) !== videos.timeoutSeconds ? { timeoutSeconds: Number(form.timeout) } : {}),
                  ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                })
              }
            >
              {t("Save")}
            </button>
          )}
          {draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setDraft(null)}>
              {t("Discard")}
            </button>
          )}
          {videos.keySet && !draft && (
            <button type="button" className="text-xs text-fg-muted hover:text-danger" onClick={() => void change({ apiKey: "" })}>
              {t("Remove the saved key")}
            </button>
          )}
        </div>
      </fieldset>
    </ui.CollapsibleSection>
  );
}
