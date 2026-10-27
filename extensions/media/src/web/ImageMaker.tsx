import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { LuChevronLeft, LuChevronRight, LuImagePlus, LuLoader, LuPlus, LuSlidersHorizontal, LuSparkles, LuUpload, LuWandSparkles, LuX } from "react-icons/lu";
import { Link, Select, local, portal, settingsPage, t, tp, tx } from "../portal";
import { api, type GalleryPicture, type ImagesFeature, type PictureJob } from "./api";
import { IMAGE_TYPES, isEnter, sortFiles } from "./helpers";
import { MAX_SOURCES, addSources, galleryIdsIn, moveTo, moved, refusal, roomFor, sourceName } from "./edit-sources";
import { COMPRESSIBLE, FORM_KEY, LIMITS, OUTPUT_FORMATS, readForm, settingsBody, sizeParts, viewerPicture, type FieldName, type Fields, type FormMemory, type Problem } from "./images-gallery";
import { MaskPainter, type MaskHandle } from "./MaskPainter";

/** What an edit takes in: what the editing endpoints are known to read, the same as the portal checks by the bytes. */
const ACCEPT = IMAGE_TYPES.join(",");

/** What is said of pictures that were put in and not taken: there was no room, or the editing endpoint takes one. `references` is whether they were to be references. */
const leftOutText = (left: number, multiple: boolean, references: boolean): string =>
  references
    ? multiple
      ? tp(left, "One picture was left out: a picture takes at most {max} references.", "{n} pictures were left out: a picture takes at most {max} references.", { max: MAX_SOURCES })
      : tp(left, "One more picture was left out: this editing endpoint takes one reference picture.", "{n} more pictures were left out: this editing endpoint takes one reference picture.")
    : multiple
      ? tp(left, "One picture was left out: an edit takes at most {max}.", "{n} pictures were left out: an edit takes at most {max}.", { max: MAX_SOURCES })
      : tp(left, "One more picture was left out: this editing endpoint takes one picture per edit.", "{n} more pictures were left out: this editing endpoint takes one picture per edit.");

/** Which list of pictures the form is putting pictures into: the ones a change works from, or a new picture's references. */
type Into = "sources" | "references";

/** What the form is for: a new picture from a description, or a change to pictures there are. */
export type Mode = "make" | "edit";

/** What a thumbnail carries while it is dragged to another place in the row: nothing else is dropped on the row. */
const SOURCE_TYPE = "application/x-pithagoras-source";

/** What is wrong with a setting, in words. */
const problemText = (problem: Problem): string => {
  switch (problem) {
    case "size-pair":
      return t("Set both width and height, or leave both empty.");
    case "size-range":
      return t("Width and height are whole numbers from {min} to {max}.", LIMITS.side);
    case "compression-range":
      return t("The compression is a whole number from {min} to {max}.", LIMITS.compression);
    case "seed":
      return t("The seed is a whole number, 0 or more, or -1 for a random one.");
    case "steps":
      return t("The steps are a whole number from {min} to {max}.", LIMITS.steps);
    case "strength":
      return t("The strength is a number from 0 to 1, such as 0.75.");
    case "negative-long":
      return t("The negative prompt is over {max} characters.", { max: LIMITS.negativePrompt });
  }
};

/**
 * Where a picture is made or changed. Two modes, chosen at the top, and both
 * always there: one that is not set up says so and where to switch it on,
 * rather than leave the person without it.
 *
 * Generate is a description and a button, with the settings of the picture
 * under it, and reference pictures where the person opens them: pictures of a
 * character, an object or a style that the new picture is made with. They go to
 * the editing endpoint, the one that takes pictures, so they need editing set up,
 * and the picture starts from noise where the add-on says the endpoint is
 * stable-diffusion.cpp; the form says what happens where it does not. While they
 * are open the gallery's boxes choose them, and a drop or a paste adds to them.
 * Edit is the pictures to change and a description of the change,
 * with the same settings and a strength. The pictures are chosen in the gallery under the form (the page
 * takes the clicks there), or put in from this computer, several at once where
 * the editing endpoint takes them: picked, dropped on the form or pasted. The
 * description says what should change, and where, with a mask if the person
 * paints one. The pictures are shown in the order the request sends them, each
 * with a way to take it out or move it, and the first is the one the mask is
 * painted on. Nothing is made here: the portal does it, as a job, and this says
 * that it was started (`onStarted`).
 *
 * The settings are fields of their own, empty where the add-on's or the
 * endpoint's own is meant (the add-on's model and size are shown in them as what
 * is used), and each mode keeps its own. The model, the size and how many are in
 * view, and the format and the compression, which the OpenAI image format has
 * too, under "Advanced". What only stable-diffusion.cpp's server reads is a block
 * of its own, apart from those, and only where the add-on says the endpoint is
 * one (`features.sdExtras`): without that it is not shown, and nothing of it is
 * sent, whatever was typed before. They are kept for the next visit, not the words.
 */
export function ImageMaker({
  features,
  running,
  limit,
  prompt,
  onPrompt,
  promptRef,
  mode,
  onMode,
  sources,
  onSources,
  references,
  onReferences,
  referencesOpen,
  onReferencesOpen,
  onFind,
  onStarted,
  onUploaded,
}: {
  features: ImagesFeature;
  /** How many pictures are being made, and how many may be at once. */
  running: number;
  limit: number;
  prompt: string;
  onPrompt: (prompt: string) => void;
  promptRef: RefObject<HTMLTextAreaElement>;
  mode: Mode;
  onMode: (mode: Mode) => void;
  /** The pictures to change, in the order the prompt refers to them. They stay while the form is making a new picture, for the way back. */
  sources: GalleryPicture[];
  onSources: (sources: GalleryPicture[]) => void;
  /** A new picture's references, in the order the prompt refers to them, and whether the form has them open: the page picks them in the gallery while it does. Closed, there are none. */
  references: GalleryPicture[];
  onReferences: (references: GalleryPicture[]) => void;
  referencesOpen: boolean;
  onReferencesOpen: (open: boolean) => void;
  /** The pictures of the gallery with these ids, those there are: what a picture of the page that is dragged or pasted into the form is taken as. */
  onFind: (ids: string[]) => Promise<GalleryPicture[]>;
  onStarted: (jobs: PictureJob[]) => void;
  /** A picture of this computer is in the gallery now. */
  onUploaded: (picture: GalleryPicture) => void;
}) {
  const { ui } = portal;
  const { ghost: ghostCls, input: inputCls, primary: primaryCls } = ui.classes;
  const [form, setForm] = useState<FormMemory>(() => readForm(local.get(FORM_KEY), limit));
  useEffect(() => local.set(FORM_KEY, JSON.stringify(form)), [form]);
  const change = (patch: Partial<FormMemory>) => setForm((f) => ({ ...f, ...patch }));
  /** The setting that was wrong when the picture was asked for: marked, and where the keyboard goes. `at` makes the same one twice in a row a new problem. */
  const [problem, setProblem] = useState<{ field: FieldName; at: number } | null>(null);
  useEffect(() => {
    if (problem) document.getElementById(`image-${problem.field}`)?.focus();
  }, [problem]);

  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // What was done, though not all of what was asked: pictures that did not fit, left out and said so.
  const [notice, setNotice] = useState<string | null>(null);
  const [masking, setMasking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
  // A picture being dragged to another place in the row, and the place it is over; and what a move said, for a screen reader.
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [moveNote, setMoveNote] = useState("");
  const mask = useRef<MaskHandle>(null);
  const file = useRef<HTMLInputElement>(null);

  const editing = mode === "edit";
  const fields = form[mode];
  const setField = (patch: Partial<Fields>) => {
    setProblem(null);
    setForm((f) => ({ ...f, [mode]: { ...f[mode], ...patch } }));
  };
  const invalid = (field: FieldName) => problem?.field === field;
  const multiple = features.editMultiple;
  // The pictures as the last of the ones put in meanwhile left them: a drop while another is being uploaded adds to that. Brought up to date with what was committed, not with a render that may be dropped.
  const listsNow = useRef({ sources, references });
  useLayoutEffect(() => {
    listsNow.current = { sources, references };
  }, [sources, references]);
  const setters: Record<Into, (list: GalleryPicture[]) => void> = { sources: onSources, references: onReferences };
  // Making and changing have a switch and an address each: either can be on without the other.
  const generating = features.ready;
  const changing = features.editReady;
  // The references are open in Generate: the row of pictures is theirs then, as it is the change's in Edit.
  const referring = !editing && generating && referencesOpen;
  const list = editing ? sources : references;
  const setList = editing ? onSources : onReferences;
  // A new picture with references is made by the editing endpoint, always with its model: the one typed for making pictures is kept, and neither shown nor sent.
  const referenceModel = referring && references.length > 0;
  const full = running >= limit;
  const count = Math.min(form.count, Math.max(1, limit - running));
  const refused = editing || referring ? refusal(list, multiple) : undefined;
  const why =
    refused === "one"
      ? editing
        ? t("This editing endpoint takes one picture per edit, and {n} are chosen. Take out all but one, or switch on “Several pictures per edit”.", { n: sources.length })
        : t("This editing endpoint takes one reference picture, and {n} are chosen. Take out all but one, or switch on “Several pictures per edit”.", { n: references.length })
      : undefined;

  // Another picture to change is another picture to paint on.
  const first = sources[0]?.id;
  // What only stable-diffusion.cpp reads: where the add-on says the endpoint is one, and never otherwise, whatever the fields hold.
  const sd = features.sdExtras;
  const fromNoise = editing && sd && fields.fromNoise;
  // A mask belongs to the picture that is built on, and from noise there is none.
  useEffect(() => setMasking(false), [first, mode, fromNoise]);

  // A picture moved or taken out under the keyboard: the button that was pressed is somewhere else or gone, and focus would be lost to the top of the page, so it is put back in the row.
  const row = useRef<HTMLOListElement>(null);
  const refocus = useRef<{ moved: { id: string; by: -1 | 1 } } | { gone: number } | null>(null);
  useEffect(() => {
    const todo = refocus.current;
    refocus.current = null;
    if (!todo) return;
    if ("gone" in todo) {
      // The picture that took its place, or the one before it where it was the last; with none left, the description, where the next thing is typed.
      const looks = row.current?.querySelectorAll<HTMLElement>("[data-source-id]");
      (looks?.length ? looks[Math.min(todo.gone, looks.length - 1)] : promptRef.current)?.focus();
      return;
    }
    const button = (by: -1 | 1) => row.current?.querySelector<HTMLButtonElement>(`[data-move="${by}"][data-move-id="${CSS.escape(todo.moved.id)}"]`);
    // At the end of the row the button that was pressed is off: the one that is left moves it back.
    const same = button(todo.moved.by);
    (same && !same.disabled ? same : button(todo.moved.by === 1 ? -1 : 1))?.focus();
  }, [list]);

  /** Puts a picture at a place in the row, by a drag or an arrow, and says where it went. */
  const reorder = (next: GalleryPicture[], id: string) => {
    const at = next.findIndex((p) => p.id === id);
    const picture = next[at];
    setList(next);
    if (picture) setMoveNote(t("{name} is picture {n} of {total} now", { name: sourceName(picture), n: at + 1, total: next.length }));
  };

  const submit = async () => {
    const said = prompt.trim();
    // Pictures still being put in, as a change's or as references, are waited for: a request sent now would leave them out.
    if (!said || busy || full || refused || adding > 0 || (editing && !sources.length)) return;
    setError(null);
    setNotice(null);
    setProblem(null);
    const settings = settingsBody(fields, editing, sd);
    if ("problem" in settings) {
      // The setting may be under "Advanced", which is opened to show it.
      if (["outputFormat", "outputCompression", "negativePrompt", "seed", "sampleSteps", "strength"].includes(settings.field)) change({ open: true });
      setProblem({ field: settings.field, at: Date.now() });
      setError(problemText(settings.problem));
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const painted = masking && !fromNoise ? await mask.current?.mask() : null;
        const { jobs } = await api.changePicture({ prompt: said, sources: sources.map((p) => p.id), ...settings.body, ...(painted ? { mask: painted } : {}), count });
        onStarted(jobs);
      } else {
        const { model: _typed, ...withoutModel } = settings.body;
        const { jobs } = await api.makePictures({ prompt: said, ...(references.length ? { ...withoutModel, references: references.map((p) => p.id) } : settings.body), count });
        onStarted(jobs);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Pictures of the gallery that were dragged or pasted in as themselves: added to the pictures of the edit, or the references, with nothing uploaded. */
  const putKnown = (found: GalleryPicture[], into: Into) => {
    const added = addSources(listsNow.current[into], found, multiple);
    listsNow.current = { ...listsNow.current, [into]: added.list };
    setters[into](added.list);
    if (added.left > 0) setNotice(leftOutText(added.left, multiple, into === "references"));
  };
  /** Puts files in the gallery, one after another so that they keep the order they were given in, and adds them to the pictures of the edit, or the references. */
  const put = async (files: File[], own: string[], into: Into) => {
    // What came from a picture of the gallery is that picture: it is in the gallery, and a copy of it would be there twice.
    const known = own.length ? await onFind(own) : [];
    if (known.length) return putKnown(known, into);
    const { images, others } = sortFiles(files);
    const problems = others.map((f) => t("{name} is not a PNG, JPEG, GIF or WebP picture", { name: f.name || t("Pasted picture") }));
    // Only as many as there is room for are put in the gallery: the rest would be pictures nobody asked to keep.
    const taking = images.slice(0, roomFor(listsNow.current[into].length, multiple));
    const left = images.length - taking.length;
    const got: GalleryPicture[] = [];
    for (const picked of taking) {
      try {
        got.push(await api.uploadPicture(picked));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    // The row may have filled meanwhile, from the gallery's viewer: what was uploaded and does not fit is in the gallery, and said to be left out.
    let late = 0;
    if (got.length) {
      onUploaded(got[0]);
      const added = addSources(listsNow.current[into], got, multiple);
      late = added.left;
      listsNow.current = { ...listsNow.current, [into]: added.list };
      setters[into](added.list);
    }
    if (left + late > 0) setNotice(leftOutText(left + late, multiple, into === "references"));
    if (problems.length) setError(problems.join(" "));
  };
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Picked, dropped or pasted: each set of files waits for the one before it, so that two quick pastes do not take the same places. */
  const addFiles = (files: File[], own: string[] = []) => {
    if ((!files.length && !own.length) || !changing) return;
    // Pictures put on the form are references while those are open in Generate, and otherwise for a change, wherever it was left.
    const into: Into = referring ? "references" : "sources";
    if (into === "sources") onMode("edit");
    setError(null);
    setNotice(null);
    setAdding((n) => n + 1);
    queue.current = queue.current
      .then(() => put(files, own, into))
      .catch((e: Error) => setError(e.message))
      .finally(() => setAdding((n) => n - 1));
  };

  // What is used where a field is left empty, shown in it: the add-on's own model and, for a new picture, its size.
  const shownSize = editing ? { width: "", height: "" } : sizeParts(features.size);
  const empty = t("The endpoint's own");
  const compressible = COMPRESSIBLE.includes(fields.outputFormat);
  const numberCls = `${inputCls} mt-1 font-mono text-xs`;
  /** A setting that is a number, written as text: the form says what is wrong with it, in its own words, when the picture is asked for. */
  const numberField = (name: "width" | "height" | "outputCompression" | "seed" | "sampleSteps" | "strength", label: string, placeholder: string, extra: { disabled?: boolean; describedBy?: string } = {}) => (
    <label className="text-xs text-fg-muted">
      {label}
      <input
        id={`image-${name}`}
        value={fields[name]}
        onChange={(e) => setField({ [name]: e.target.value })}
        placeholder={placeholder}
        inputMode={name === "strength" ? "decimal" : "numeric"}
        spellCheck={false}
        autoComplete="off"
        disabled={extra.disabled}
        aria-invalid={invalid(name) || undefined}
        aria-describedby={extra.describedBy}
        className={`${numberCls} ${invalid(name) ? "border-danger" : ""} disabled:opacity-50`}
      />
    </label>
  );

  const settings = (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-2 text-xs text-fg-muted sm:col-span-1">
          {t("Model")}
          <input
            id="image-model"
            value={referenceModel ? features.editModel : fields.model}
            onChange={(e) => setField({ model: e.target.value })}
            placeholder={(editing || referenceModel ? features.editModel : features.model) || empty}
            disabled={referenceModel}
            aria-describedby={referenceModel ? "image-model-hint" : undefined}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            className={`${numberCls} disabled:opacity-50`}
          />
        </label>
        {numberField("width", t("Width"), shownSize.width || empty)}
        {numberField("height", t("Height"), shownSize.height || empty)}
        {/* Not a label: the Select is a button of its own, and a label would pass a click on its text to it. */}
        <div className="col-span-2 text-xs text-fg-muted sm:col-span-1">
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
      {referenceModel && (
        <p id="image-model-hint" className="mt-1 text-[11px] text-fg-faint">
          {features.editModel ? t("Reference pictures use the editing model: {name}", { name: features.editModel }) : t("Reference pictures use the editing endpoint's own model.")}
        </p>
      )}

      <button type="button" onClick={() => change({ open: !form.open })} aria-expanded={form.open} className={`${ghostCls} mt-2`}>
        <LuSlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
        {t("Advanced")}
      </button>
      {form.open && (
        <div className="mt-2 grid gap-2 rounded-xl border border-line bg-canvas/40 p-3 sm:grid-cols-2">
          {/* Not a label, as with How many. */}
          <div className="text-xs text-fg-muted">
            {t("File format")}
            <Select<string>
              id="image-outputFormat"
              aria-label={t("File format")}
              className="mt-1 w-full"
              value={fields.outputFormat}
              onChange={(v) => setField({ outputFormat: v as Fields["outputFormat"] })}
              options={[{ value: "", label: empty }, ...OUTPUT_FORMATS.map((f) => ({ value: f as string, label: f.toUpperCase() }))]}
            />
          </div>
          {numberField("outputCompression", t("Compression"), compressible ? "0–100" : "", { disabled: !compressible, describedBy: "image-compression-hint" })}
          <p id="image-compression-hint" className="text-[11px] text-fg-faint sm:col-span-2">
            {compressible ? t("How strongly the file is compressed, from 0 to 100, as the endpoint reads it. Empty is its own.") : t("Choose JPEG or WebP as the file format to set a compression.")}
          </p>
          {/* What is not in the OpenAI image format: plain fields like the ones above, there only where the add-on says the endpoint reads them, and with a way to that setting where it does not. */}
          {sd ? (
            <>
              <p className="mt-1 text-[11px] text-fg-faint sm:col-span-2">
                {t("For stable-diffusion.cpp servers only: these are added to the description as a block that its server reads.")}
              </p>
              <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
                {numberField("seed", t("Seed"), t("Random"))}
                {numberField("sampleSteps", t("Steps"), empty)}
                {editing && numberField("strength", t("Strength"), empty, { disabled: fromNoise, describedBy: "image-strength-hint" })}
              </div>
              {count > 1 && <p className="text-[11px] text-fg-faint sm:col-span-2">{t("With a seed, each of the pictures takes the next one, so that they are not all the same.")}</p>}
              <label className="block text-xs text-fg-muted sm:col-span-2">
                {t("Negative prompt")}
                <textarea
                  id="image-negativePrompt"
                  value={fields.negativePrompt}
                  onChange={(e) => setField({ negativePrompt: e.target.value })}
                  aria-invalid={invalid("negativePrompt") || undefined}
                  rows={2}
                  placeholder={t("What the picture should not show")}
                  className={`${inputCls} mt-1 resize-y ${invalid("negativePrompt") ? "border-danger" : ""}`}
                />
              </label>
              {editing && (
                <>
                  <p id="image-strength-hint" className="text-[11px] text-fg-faint sm:col-span-2">
                    {fromNoise
                      ? t("There is no strength when the result starts from noise.")
                      : t("The strength tends to decide how far the result may go from the first picture. A high one, such as 0.75 or more, keeps it close to that picture, and the other pictures then have little or no effect. A lower one gives them more influence.")}
                  </p>
                  <div className="sm:col-span-2">
                    <span id="edit-start-label" className="text-xs text-fg-muted">
                      {t("Start from")}
                    </span>
                    <div role="radiogroup" aria-labelledby="edit-start-label" aria-describedby="edit-start-hint" className="mt-1 inline-grid grid-cols-2 gap-1 rounded-xl bg-fg/5 p-1">
                      {[
                        { noise: false, label: t("The first picture") },
                        { noise: true, label: t("Noise only") },
                      ].map((o) => (
                        <button
                          key={String(o.noise)}
                          type="button"
                          role="radio"
                          aria-checked={fields.fromNoise === o.noise}
                          onClick={() => setField({ fromNoise: o.noise })}
                          className={`inline-flex min-h-8 items-center justify-center rounded-lg px-3 text-xs transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${fields.fromNoise === o.noise ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25" : "text-fg-muted hover:bg-fg/10 hover:text-fg"}`}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <p id="edit-start-hint" className="mt-1 text-[11px] text-fg-faint">
                      {fromNoise
                        ? t("The result starts from noise only. The description and all the pictures are used as references; strength and a mask do not apply.")
                        : t("The first picture is the base that is built on. Strength and a mask work on it.")}
                    </p>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="mt-1 text-[11px] text-fg-faint sm:col-span-2">
              {tx("Using stable-diffusion.cpp? Switch on “Stable Diffusion extra settings” under {settings} for more options.", {
                settings: (
                  <Link to={settingsPage()} className="text-accent hover:underline">
                    {t("Media in Settings")}
                  </Link>
                ),
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );

  const modes: { id: Mode; label: string; icon: ReactNode; ready: boolean }[] = [
    { id: "make", label: t("Generate"), icon: <LuSparkles aria-hidden className="h-4 w-4" />, ready: generating },
    { id: "edit", label: t("Edit"), icon: <LuWandSparkles aria-hidden className="h-4 w-4" />, ready: changing },
  ];
  const noPicture = editing && !sources.length;
  // Pictures still being put in are not in the row yet: a request sent now would leave them out, while the row goes on to show them as if they were used.
  const waiting = adding > 0;
  const showRow = list.length > 0 || adding > 0;

  /**
   * The row of pictures the form works with, in the order the request sends them: the change's in Edit, the references
   * in Generate. Each opens larger, moves by a drag or its arrows, and is taken out by its ×; `labelledBy` is its heading.
   */
  const pictureRow = (labelledBy: string) => (
    <ol ref={row} aria-labelledby={labelledBy} className="mt-1.5 flex flex-wrap gap-x-3 gap-y-2">
      {list.map((p, i) => (
        <li
          key={p.id}
          // Dragged by mouse or pen to another place, where the browser lets a thumbnail be; the arrows below are the way for a keyboard and a touch screen.
          draggable={list.length > 1}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(SOURCE_TYPE, p.id);
            setDragged(p.id);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SOURCE_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(i);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((now) => (now === i ? null : now));
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(SOURCE_TYPE);
            setDragged(null);
            setOver(null);
            if (!id) return;
            e.preventDefault();
            // Not the form's: it takes dropped files, and this is no file.
            e.stopPropagation();
            reorder(moveTo(list, id, i), id);
          }}
          onDragEnd={() => {
            setDragged(null);
            setOver(null);
          }}
          className={`flex w-16 flex-col items-center gap-1 rounded-lg ${list.length > 1 ? "cursor-grab" : ""} ${dragged === p.id ? "opacity-40" : ""} ${over === i && dragged && dragged !== p.id ? "outline-2 outline-offset-2 outline-accent" : ""}`}
        >
          <div className="relative">
            {/* A button, so that it can be looked at larger and a keyboard reaches it. */}
            <button type="button" data-source-id={p.id} onClick={() => setLooking(p.id)} aria-label={t("Look at {name}", { name: sourceName(p) })} title={t("Look at {name}", { name: sourceName(p) })} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <img
                src={p.thumb ? api.galleryThumbUrl(p.id) : api.galleryFileUrl(p.id)}
                alt={sourceName(p)}
                loading="lazy"
                draggable={false}
                className={`h-16 w-16 rounded-lg border object-cover ${masking && i === 0 ? "border-accent ring-2 ring-accent" : "border-line"}`}
              />
            </button>
            {list.length > 1 && <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-surface/85 px-1 text-[10px] tabular-nums text-fg">{i + 1}</span>}
            {masking && i === 0 && <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-accent px-1 text-[10px] text-accent-fg">{t("Mask")}</span>}
            <button
              type="button"
              onClick={() => {
                refocus.current = { gone: i };
                setList(list.filter((s) => s.id !== p.id));
              }}
              aria-label={t("Remove {name}", { name: sourceName(p) })}
              title={t("Remove")}
              className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-fg-muted hover:text-danger sm:-right-1.5 sm:-top-1.5 sm:h-5 sm:w-5"
            >
              <LuX aria-hidden className="h-3 w-3" />
            </button>
          </div>
          {list.length > 1 && (
            <div className="flex gap-1">
              <button
                type="button"
                data-move="-1"
                data-move-id={p.id}
                onClick={() => {
                  refocus.current = { moved: { id: p.id, by: -1 } };
                  reorder(moved(list, i, -1), p.id);
                }}
                disabled={i === 0}
                aria-label={t("Move {name} earlier", { name: sourceName(p) })}
                title={t("Earlier")}
                className="grid h-6 w-7 place-items-center rounded-md bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg disabled:pointer-events-none disabled:opacity-35"
              >
                <LuChevronLeft aria-hidden className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-move="1"
                data-move-id={p.id}
                onClick={() => {
                  refocus.current = { moved: { id: p.id, by: 1 } };
                  reorder(moved(list, i, 1), p.id);
                }}
                disabled={i === list.length - 1}
                aria-label={t("Move {name} later", { name: sourceName(p) })}
                title={t("Later")}
                className="grid h-6 w-7 place-items-center rounded-md bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg disabled:pointer-events-none disabled:opacity-35"
              >
                <LuChevronRight aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </li>
      ))}
      {adding > 0 && (
        <li className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-line text-fg-subtle">
          <LuLoader aria-hidden className="h-4 w-4 animate-spin" />
          <span role="status" className="sr-only">
            {t("Adding…")}
          </span>
        </li>
      )}
      {multiple && list.length < MAX_SOURCES && (
        <li>
          <button
            type="button"
            onClick={() => file.current?.click()}
            aria-label={t("Add pictures from this computer")}
            title={t("Add pictures from this computer")}
            className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-line text-fg-muted transition hover:border-accent/60 hover:bg-accent/5 hover:text-accent"
          >
            <span className="grid place-items-center gap-0.5 text-[11px]">
              <LuPlus aria-hidden className="h-4 w-4" />
              {t("Add")}
            </span>
          </button>
        </li>
      )}
    </ol>
  );

  return (
    <section
      aria-label={editing ? t("Change a picture") : t("Make a picture")}
      className="relative rounded-2xl border border-line bg-raised/40 p-3 sm:p-4"
      onDragOver={(e) => {
        if (!changing || e.defaultPrevented || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        // Down whatever was dropped: a drag that looked like files can carry none, and the overlay would stay up until the next one left.
        setDragging(false);
        if (!changing || e.defaultPrevented) return;
        // A picture of the gallery that is dragged up here comes with a file made from it; the address beside it says it is the gallery's own.
        const own = galleryIdsIn({ uris: e.dataTransfer.getData("text/uri-list"), html: e.dataTransfer.getData("text/html") }, location.origin);
        if (!e.dataTransfer.files.length && !own.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files], own);
      }}
      onPaste={(e) => {
        // A screenshot, or "Copy image" in a browser. Where there is text as well — cells copied from a spreadsheet come with a picture of themselves — the text is what was meant.
        const files = [...e.clipboardData.files];
        if (!changing || !files.length || e.clipboardData.getData("text/plain")) return;
        e.preventDefault();
        // "Copy image" on a picture of the gallery is that picture too.
        addFiles(files, galleryIdsIn({ html: e.clipboardData.getData("text/html") }, location.origin));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent/60 bg-accent/10 px-4 text-center text-xs text-accent">
          {referring
            ? multiple
              ? t("Drop pictures here to use them as references")
              : t("Drop a picture here to use it as a reference")
            : multiple
              ? t("Drop pictures here to change them, or to use them as references")
              : t("Drop a picture here to change it")}
        </div>
      )}

      {/* Both modes are always here: one that is not set up is not hidden, it says what is missing. */}
      <div role="radiogroup" aria-label={t("What to do")} className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-fg/5 p-1 sm:inline-grid">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            onClick={() => onMode(m.id)}
            className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-4 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${mode === m.id ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25" : "text-fg-muted hover:bg-fg/10 hover:text-fg"}`}
          >
            {m.icon}
            {m.label}
            {!m.ready && <span className="text-[11px] text-fg-faint">{t("not set up")}</span>}
          </button>
        ))}
      </div>

      {editing && !changing && (
        <p className="text-sm text-fg-muted">
          {t("Image editing is switched off, or has no address.")}{" "}
          <Link to={settingsPage()} className="text-accent hover:underline">
            {t("Set it up under Media in Settings")}
          </Link>
        </p>
      )}

      {editing && changing && (
        <div className="mb-3">
          <div className="flex items-baseline gap-2">
            <p id="edit-sources-heading" className="text-xs text-fg-muted">
              {multiple && sources.length > 1
                ? tp(sources.length, "The {n} picture to work from, in the order the description can refer to them", "The {n} pictures to work from, in the order the description can refer to them")
                : t("The picture to change")}
            </p>
            {multiple && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-fg-subtle">{t("{n} of {max} pictures", { n: sources.length, max: MAX_SOURCES })}</span>}
          </div>
          {showRow ? (
            pictureRow("edit-sources-heading")
          ) : (
            <p className="mt-1.5 rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-fg-subtle">
              {multiple
                ? t("No picture yet. Pick pictures from the gallery below, drop or paste them here, or add them from this computer.")
                : t("No picture yet. Pick one from the gallery below, drop or paste it here, or add it from this computer.")}
            </p>
          )}
          <p aria-live="polite" className="sr-only">
            {moveNote}
          </p>
          {multiple && sources.length > 1 && (
            <p className="mt-2 text-[11px] text-fg-muted">
              {fromNoise
                ? t("Starting from noise, all the pictures are references, so the first one tends to count less than it does as the base. The endpoint still gets them in this order, which you can change by dragging a picture or with the arrows under it.")
                : t("The first picture counts most: it is the one that is changed or carried over, and the others are extra references. Drag a picture to another place, or use the arrows under it, to change the order; the endpoint gets them in this order.")}
            </p>
          )}
          {(sources.length > 0 || !multiple) && (
            <p className={`mt-2 text-[11px] ${refused ? "rounded-lg bg-warn/10 px-2 py-1.5 text-warn" : "text-fg-faint"}`} role={refused ? "alert" : undefined}>
              {why ??
                (multiple
                  ? t("The description can name them by their place: “the first picture”, “the second picture”. Pick more from the gallery below, drop or paste them here, or add them from this computer.")
                  : t("This editing endpoint takes one picture per edit, and a picture you add takes the place of the one there is. To work from several, switch on “Several pictures per edit”."))}
              {!multiple && (
                <>
                  {" "}
                  <Link to={settingsPage()} className="text-accent hover:underline">
                    {t("Set it up under Media in Settings")}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      )}

      {!editing && !generating && (
        <p className="mb-3 text-sm text-fg-muted">
          {t("Image generation is switched off, or has no address.")}{" "}
          <Link to={settingsPage()} className="text-accent hover:underline">
            {t("Set it up under Media in Settings")}
          </Link>
          {changing && <span className="mt-1 block text-xs text-fg-subtle">{t("Pictures can still be changed: choose Edit above.")}</span>}
        </p>
      )}
      {(editing ? changing : generating) && (
        <label className="block">
          <span className="sr-only">{editing ? t("What should change") : t("What the picture should show")}</span>
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
            placeholder={editing ? t("Describe the change: what to add, remove or make different") : t("Describe the picture")}
            className={`${inputCls} resize-y`}
          />
        </label>
      )}

      {/* Reference pictures, for Generate: closed until the person opens them, and empty again when they close them. */}
      {!editing && generating && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {
              if (referencesOpen) onReferences([]);
              onReferencesOpen(!referencesOpen);
            }}
            aria-expanded={referencesOpen}
            className={ghostCls}
          >
            <LuImagePlus aria-hidden className="h-3.5 w-3.5" />
            {referencesOpen ? t("Leave out the reference pictures") : t("Use reference pictures")}
          </button>
          {referring &&
            (changing ? (
              <div className="mt-2">
                <div className="flex items-baseline gap-2">
                  <p id="reference-heading" className="text-xs text-fg-muted">
                    {multiple && references.length > 1
                      ? tp(references.length, "The {n} reference picture, in the order the description can refer to them", "The {n} reference pictures, in the order the description can refer to them")
                      : t("Reference pictures: a character, an object or a style to carry into the new picture")}
                  </p>
                  {multiple && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-fg-subtle">{t("{n} of {max} pictures", { n: references.length, max: MAX_SOURCES })}</span>}
                </div>
                {showRow ? (
                  pictureRow("reference-heading")
                ) : (
                  <p className="mt-1.5 rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-fg-subtle">
                    {multiple
                      ? t("No reference picture yet. Tick pictures in the gallery below, drop or paste them here, or add them from this computer.")
                      : t("No reference picture yet. Tick one in the gallery below, drop or paste it here, or add it from this computer.")}
                  </p>
                )}
                <p aria-live="polite" className="sr-only">
                  {moveNote}
                </p>
                {multiple && references.length > 1 && (
                  <p className="mt-2 text-[11px] text-fg-muted">
                    {t("The description can name them by their place: “the first picture”, “the second picture”. Drag a picture to another place, or use the arrows under it, to change the order; the endpoint gets them in this order.")}
                  </p>
                )}
                {references.length > 0 &&
                  (sd ? (
                    <p className="mt-2 text-[11px] text-fg-faint">{t("The new picture starts from noise: the references guide it, and none of them is changed.")}</p>
                  ) : (
                    // Not known of the endpoint: what happens on a stable-diffusion.cpp server is said, and what to switch on for it.
                    <p className="mt-2 rounded-lg bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                      {tx("Stable Diffusion extra settings are off, so a stable-diffusion.cpp server starts from the first reference, and the picture may come out as a reworked copy of it. Switch them on under {settings} to start from noise. Other endpoints use the pictures as references either way.", {
                        settings: (
                          <Link to={settingsPage()} className="text-accent hover:underline">
                            {t("Media in Settings")}
                          </Link>
                        ),
                      })}
                    </p>
                  ))}
                {references.length > 0 && !fields.width.trim() && !fields.height.trim() && !features.size && (
                  <p className="mt-2 text-[11px] text-fg-faint">{t("No size is set, so the endpoint may make the picture in the size and shape of the first reference. Set a width and height to choose them.")}</p>
                )}
                {(refused || !multiple) && (
                  <p className={`mt-2 text-[11px] ${refused ? "rounded-lg bg-warn/10 px-2 py-1.5 text-warn" : "text-fg-faint"}`} role={refused ? "alert" : undefined}>
                    {why ?? t("This editing endpoint takes one reference picture, and a picture you add takes the place of the one there is. To use several, switch on “Several pictures per edit”.")}{" "}
                    <Link to={settingsPage()} className="text-accent hover:underline">
                      {t("Set it up under Media in Settings")}
                    </Link>
                  </p>
                )}
                {/* With references and room for more, the add button is in their row. */}
                {!(multiple && references.length > 0) && (
                  <button type="button" onClick={() => file.current?.click()} disabled={adding > 0} className={`${ghostCls} mt-2`}>
                    {adding > 0 ? <LuLoader aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LuUpload aria-hidden className="h-3.5 w-3.5" />}
                    {multiple ? t("Add pictures from this computer") : t("Add a picture from this computer")}
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-2 text-xs text-fg-muted">
                {t("Reference pictures are sent to the image editing endpoint, and image editing is switched off or has no address.")}{" "}
                <Link to={settingsPage()} className="text-accent hover:underline">
                  {t("Set it up under Media in Settings")}
                </Link>
              </p>
            ))}
        </div>
      )}

      {editing && changing && sources.length > 0 && !fromNoise && (
        <div className="mt-2">
          <button type="button" onClick={() => setMasking((v) => !v)} aria-expanded={masking} className={ghostCls}>
            <LuWandSparkles aria-hidden className="h-3.5 w-3.5" />
            {masking ? t("Change the whole picture") : t("Only change a part: paint a mask")}
          </button>
          {masking && sources[0] && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs text-fg-subtle">
                {sources.length > 1
                  ? t("Paint over what should change in picture 1, “{name}”. The mask belongs to the first picture only: to paint on another, move it to the first place, which starts the mask over. Without a mask the whole picture may change. The mask is not kept.", { name: sourceName(sources[0]) })
                  : t("Paint over what should change. Without a mask the whole picture may change. The mask goes with the first picture, and is not kept.")}
              </p>
              {/* Keyed by the picture: another one must not keep the strokes, or a "could not be loaded", of the one before. */}
              <MaskPainter key={sources[0].id} ref={mask} src={api.galleryFileUrl(sources[0].id)} />
            </div>
          )}
        </div>
      )}

      {(editing ? changing : generating) && settings}

      {(editing ? changing : generating) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!prompt.trim() || busy || full || !!refused || noPicture || waiting}
            title={full ? t("{n} pictures are being made: wait for one to finish, or stop one", { n: running }) : waiting ? t("Wait until the pictures are added") : noPicture ? t("Choose the picture to change first") : why}
            className={primaryCls}
          >
            {busy ? <LuLoader aria-hidden className="h-4 w-4 animate-spin" /> : editing ? <LuWandSparkles aria-hidden className="h-4 w-4" /> : <LuSparkles aria-hidden className="h-4 w-4" />}
            {editing ? tp(count, "Change the picture", "Make {n} changes") : tp(count, "Make the picture", "Make {n} pictures")}
          </button>
          {(editing || (referring && changing)) && (
            <input
              ref={file}
              type="file"
              accept={ACCEPT}
              multiple={multiple}
              className="sr-only"
              tabIndex={-1}
              aria-label={t("Upload a picture")}
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                addFiles(picked);
              }}
            />
          )}
          {/* With pictures to work from and room for more, the add button is in their row. */}
          {editing && !(multiple && sources.length > 0) && (
            <button type="button" onClick={() => file.current?.click()} disabled={adding > 0} className={ghostCls}>
              {adding > 0 ? <LuLoader aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LuUpload aria-hidden className="h-3.5 w-3.5" />}
              {multiple ? t("Add pictures from this computer") : t("Change a picture from this computer")}
            </button>
          )}
          <span className="ml-auto text-xs tabular-nums text-fg-subtle">{running > 0 ? t("{n} of {max} being made", { n: running, max: limit }) : ""}</span>
        </div>
      )}

      {notice && (
        <p role="status" className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {looking && (
        <ui.ImageViewer
          pictures={list.map((p) => viewerPicture(p, api.galleryFileUrl))}
          startId={looking}
          onClose={() => setLooking(null)}
          anchor={(id) => document.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(id)}"]`)}
        />
      )}
    </section>
  );
}
