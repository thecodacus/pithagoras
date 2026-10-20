import { useEffect, useState, type RefObject } from "react";
import { LuImage, LuLoader, LuSlidersHorizontal, LuVideo, LuX } from "react-icons/lu";
import { Link, Select, local, portal, settingsPage, t, tp } from "../portal";
import { api, type GalleryPicture, type VideoJob, type VideosFeature } from "./api";
import { sourceName } from "./edit-sources";
import { isEnter } from "./helpers";
import { FORM_KEY, VIDEO_LIMITS, readForm, secondsLabel, settingsBody, sizeParts, type FieldName, type Fields, type FormMemory, type Problem } from "./videos-gallery";
import { VideoFramePicker } from "./VideoFramePicker";

/** What is wrong with a setting, in words. */
const problemText = (problem: Problem): string => {
  switch (problem) {
    case "size-pair":
      return t("Set both width and height, or leave both empty.");
    case "size-range":
      return t("Width and height are whole numbers from {min} to {max}.", VIDEO_LIMITS.side);
    case "frames":
      return t("The frames are a whole number from {min} to {max}.", VIDEO_LIMITS.frames);
    case "fps":
      return t("The frame rate is a whole number from {min} to {max}.", VIDEO_LIMITS.fps);
    case "seed":
      return t("The seed is a whole number, 0 or more, or -1 for a random one.");
    case "steps":
      return t("The steps are a whole number from {min} to {max}.", VIDEO_LIMITS.steps);
    case "strength":
      return t("The strength is a number from 0 to 1, such as 0.75.");
    case "negative-long":
      return t("The negative prompt is over {max} characters.", { max: VIDEO_LIMITS.negativePrompt });
  }
};

/**
 * Where a clip is made. A description and a button, with the settings of the clip under it, and a first frame if
 * the clip is to start from a picture, a last frame if it is to end on one. Nothing is made here: the portal does
 * it, as a job (it takes minutes, and closing the page must not lose it), and this says that it was started
 * (`onStarted`).
 *
 * The settings are fields of their own, empty where the add-on's or the server's own is meant (the add-on's model,
 * size, frames and frame rate are shown in them as what is used), and kept for the next visit, not the words. The
 * model, the size, how long the clip is and how many are in view; the seed, the steps, the strength and a negative
 * prompt under "Advanced". A clip made from a picture is asked for with the picture as its first frame, and one that
 * ends on a picture with it as its last: the gallery's pictures are where they come from.
 */
export function VideoMaker({
  features,
  running,
  limit,
  prompt,
  onPrompt,
  promptRef,
  firstFrame,
  onFirstFrame,
  lastFrame,
  onLastFrame,
  onStarted,
}: {
  features: VideosFeature;
  /** How many clips are being made, and how many may be at once. */
  running: number;
  limit: number;
  prompt: string;
  onPrompt: (prompt: string) => void;
  promptRef: RefObject<HTMLTextAreaElement>;
  /** The picture the clip starts from, if it does. */
  firstFrame: GalleryPicture | null;
  onFirstFrame: (picture: GalleryPicture | null) => void;
  /** The picture the clip ends on, if it does. */
  lastFrame: GalleryPicture | null;
  onLastFrame: (picture: GalleryPicture | null) => void;
  onStarted: (jobs: VideoJob[]) => void;
}) {
  const { ghost: ghostCls, input: inputCls, primary: primaryCls } = portal.ui.classes;
  const [form, setForm] = useState<FormMemory>(() => readForm(local.get(FORM_KEY), limit));
  useEffect(() => local.set(FORM_KEY, JSON.stringify(form)), [form]);
  const change = (patch: Partial<FormMemory>) => setForm((f) => ({ ...f, ...patch }));
  /** The setting that was wrong when the clip was asked for: marked, and where the keyboard goes. `at` makes the same one twice in a row a new problem. */
  const [problem, setProblem] = useState<{ field: FieldName; at: number } | null>(null);
  useEffect(() => {
    if (problem) document.getElementById(`video-${problem.field}`)?.focus();
  }, [problem]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which frame the dialog is choosing a picture for. */
  const [choosing, setChoosing] = useState<"first" | "last" | null>(null);

  const fields = form.fields;
  const setField = (patch: Partial<Fields>) => {
    setProblem(null);
    setForm((f) => ({ ...f, fields: { ...f.fields, ...patch } }));
  };
  const invalid = (field: FieldName) => problem?.field === field;
  const full = running >= limit;
  const count = Math.min(form.count, Math.max(1, limit - running));

  const submit = async () => {
    const said = prompt.trim();
    if (!said || busy || full) return;
    setError(null);
    setProblem(null);
    const settings = settingsBody(fields);
    if ("problem" in settings) {
      // The setting may be under "Advanced", which is opened to show it.
      if (["seed", "sampleSteps", "strength", "negativePrompt"].includes(settings.field)) change({ open: true });
      setProblem({ field: settings.field, at: Date.now() });
      setError(problemText(settings.problem));
      return;
    }
    setBusy(true);
    try {
      const { jobs } = await api.makeVideos({ prompt: said, ...settings.body, ...(firstFrame ? { firstFrame: firstFrame.id } : {}), ...(lastFrame ? { lastFrame: lastFrame.id } : {}), count });
      onStarted(jobs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // What is used where a field is left empty, shown in it: the add-on's own model, size, frames and frame rate.
  const shownSize = sizeParts(features.size);
  const empty = t("The endpoint's own");
  const numberCls = `${inputCls} mt-1 font-mono text-xs`;
  /** A setting that is a number, written as text: the form says what is wrong with it, in its own words, when the clip is asked for. */
  const numberField = (name: "width" | "height" | "frames" | "fps" | "seed" | "sampleSteps" | "strength", label: string, placeholder: string) => (
    <label className="text-xs text-fg-muted">
      {label}
      <input
        id={`video-${name}`}
        value={fields[name]}
        onChange={(e) => setField({ [name]: e.target.value })}
        placeholder={placeholder}
        inputMode={name === "strength" ? "decimal" : "numeric"}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid(name) || undefined}
        className={`${numberCls} ${invalid(name) ? "border-danger" : ""}`}
      />
    </label>
  );

  // How long the clip plays, from what is typed or else what is used: only where both are known.
  const frames = Number(fields.frames.trim() || features.frames || NaN);
  const fps = Number(fields.fps.trim() || features.fps || NaN);
  const length = Number.isInteger(frames) && Number.isInteger(fps) && frames > 0 && fps > 0 ? frames / fps : undefined;

  /** A frame of the clip: the picture chosen, with the ways to change or drop it, or the button that chooses one. */
  const frame = (which: "first" | "last", picture: GalleryPicture | null, onPicture: (picture: GalleryPicture | null) => void) =>
    picture ? (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas/40 p-1.5 pr-2">
        <img src={picture.thumb ? api.galleryThumbUrl(picture.id) : api.galleryFileUrl(picture.id)} alt="" className="h-12 w-12 rounded-lg border border-line object-cover" />
        <div className="min-w-0">
          <p className="text-[11px] text-fg-subtle">{which === "first" ? t("First frame") : t("Last frame")}</p>
          <p className="max-w-[14rem] truncate text-xs text-fg" title={sourceName(picture)}>
            {sourceName(picture)}
          </p>
        </div>
        <button type="button" onClick={() => setChoosing(which)} className={ghostCls}>
          {t("Change")}
        </button>
        <button
          type="button"
          onClick={() => onPicture(null)}
          aria-label={which === "first" ? t("Remove the first frame") : t("Remove the last frame")}
          title={which === "first" ? t("Remove the first frame") : t("Remove the last frame")}
          className="grid h-6 w-6 place-items-center rounded-full text-fg-muted hover:bg-fg/10 hover:text-danger"
        >
          <LuX aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
    ) : (
      <button type="button" onClick={() => setChoosing(which)} className={ghostCls}>
        <LuImage aria-hidden className="h-3.5 w-3.5" />
        {which === "first" ? t("Start from a picture") : t("End on a picture")}
      </button>
    );

  if (!features.ready) {
    return (
      <section aria-label={t("Make a video")} className="rounded-2xl border border-line bg-raised/40 p-3 sm:p-4">
        <p className="text-sm text-fg-muted">
          {t("Video generation is switched off, or has no address.")}{" "}
          <Link to={settingsPage()} className="text-accent hover:underline">
            {t("Set it up under Media in Settings")}
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t("Make a video")} className="rounded-2xl border border-line bg-raised/40 p-3 sm:p-4">
      <label className="block">
        <span className="sr-only">{t("What the video should show")}</span>
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl or Cmd with Enter, so that Enter itself is a new line in a long description.
            if (isEnter(e) && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder={firstFrame ? t("Describe what happens next: what moves, and how") : t("Describe the video: the subject, what moves, the camera")}
          className={`${inputCls} resize-y`}
        />
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {frame("first", firstFrame, onFirstFrame)}
        {frame("last", lastFrame, onLastFrame)}
        {!firstFrame && !lastFrame && <span className="text-[11px] text-fg-faint">{t("Without one, the video is made from the description alone.")}</span>}
        {lastFrame && <span className="basis-full text-[11px] text-fg-faint">{t("The last frame goes only to a server that says it takes one. Whether the clip really ends on it depends on the model: some ignore it without saying so.")}</span>}
      </div>

      <div className="mt-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="col-span-2 text-xs text-fg-muted sm:col-span-1">
            {t("Model")}
            <input
              id="video-model"
              value={fields.model}
              onChange={(e) => setField({ model: e.target.value })}
              placeholder={features.model || empty}
              maxLength={200}
              spellCheck={false}
              autoComplete="off"
              className={numberCls}
            />
          </label>
          {numberField("width", t("Width"), shownSize.width || empty)}
          {numberField("height", t("Height"), shownSize.height || empty)}
          {numberField("frames", t("Frames"), features.frames ? String(features.frames) : empty)}
          {numberField("fps", t("Frame rate"), features.fps ? String(features.fps) : empty)}
          {/* Not a label: the Select is a button of its own, and a label would pass a click on its text to it. */}
          <div className="text-xs text-fg-muted">
            {t("How many")}
            <Select<number>
              aria-label={t("How many")}
              className="mt-1 w-full"
              value={count}
              onChange={(n) => change({ count: n })}
              options={Array.from({ length: limit }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
            />
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-fg-faint">
          {length !== undefined ? t("{frames} frames at {fps} frames per second play for about {length}.", { frames, fps, length: secondsLabel(length) }) : t("How long a clip plays is its frames over its frame rate.")}{" "}
          {t("The server may round the frames to a count its model takes; the video's details say how many it made. A longer clip takes much longer to make.")}
        </p>

        <button type="button" onClick={() => change({ open: !form.open })} aria-expanded={form.open} className={`${ghostCls} mt-2`}>
          <LuSlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
          {t("Advanced")}
        </button>
        {form.open && (
          <div className="mt-2 grid gap-2 rounded-xl border border-line bg-canvas/40 p-3 sm:grid-cols-2">
            {numberField("seed", t("Seed"), t("Random"))}
            {numberField("sampleSteps", t("Steps"), empty)}
            {numberField("strength", t("Strength"), empty)}
            <p className="text-[11px] text-fg-faint sm:col-span-2">{t("How strongly the first and last frame hold the clip. What a model does with it is its own; leave it empty for the server's own.")}</p>
            {count > 1 && <p className="text-[11px] text-fg-faint sm:col-span-2">{t("With a seed, each of the videos takes the next one, so that they are not all the same.")}</p>}
            <label className="block text-xs text-fg-muted sm:col-span-2">
              {t("Negative prompt")}
              <textarea
                id="video-negativePrompt"
                value={fields.negativePrompt}
                onChange={(e) => setField({ negativePrompt: e.target.value })}
                aria-invalid={invalid("negativePrompt") || undefined}
                rows={2}
                placeholder={t("What the video should not show")}
                className={`${inputCls} mt-1 resize-y ${invalid("negativePrompt") ? "border-danger" : ""}`}
              />
            </label>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!prompt.trim() || busy || full}
          title={full ? t("{n} videos are being made: wait for one to finish, or stop one", { n: running }) : undefined}
          className={primaryCls}
        >
          {busy ? <LuLoader aria-hidden className="h-4 w-4 animate-spin" /> : <LuVideo aria-hidden className="h-4 w-4" />}
          {tp(count, "Make the video", "Make {n} videos")}
        </button>
        <span className="ml-auto text-xs tabular-nums text-fg-subtle">{running > 0 ? t("{n} of {max} being made", { n: running, max: limit }) : ""}</span>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {choosing && (
        <VideoFramePicker
          which={choosing}
          onClose={() => setChoosing(null)}
          onPick={(picture) => {
            (choosing === "first" ? onFirstFrame : onLastFrame)(picture);
            setChoosing(null);
            promptRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}
