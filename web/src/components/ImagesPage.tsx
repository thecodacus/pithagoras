import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LuCheck, LuDownload, LuFolder, LuImage, LuInfo, LuMessageSquare, LuRefreshCw, LuRepeat, LuTrash2, LuVideo, LuWandSparkles } from "react-icons/lu";
import { api, type GalleryPicture, type ImagesFeature, type PictureJob, type PictureKind, type PictureOrigin } from "../api";
import { MAX_SOURCES, addSources, sourceName } from "../edit-sources";
import { appendPage, fieldsText, madeButNotListed, mergeTop, readFilter, sameList, tiles, viewerList, viewerPicture, type Filter, type Tile } from "../images-gallery";
import { pollWhileVisible } from "../poll";
import { bytesLabel } from "../projects";
import { isEscape } from "../shortcuts";
import { sinceThen } from "../time";
import { formatDateTime, msg, t, tp } from "../i18n";
import { useNow } from "../use-now";
import { confirmDialog } from "./ConfirmDialog";
import { ImageMaker, type Mode } from "./ImageMaker";
import { ImagePreview, type PreviewState } from "./ImagePreview";
import { ImageViewer, iconButton } from "./ImageViewer";
import { PageHeader, Stat } from "./PageHeader";
import { Empty, ErrorBanner, Segments, WarnBanner, btnCls, ghostCls } from "./SettingsUi";
import type { ViewerPicture } from "../image-viewer";

/** How many pictures a page of the gallery has: enough to fill a screen and some, and few enough to be quick. */
const PAGE = 48;
/** The most pictures one request to delete may name (MAX_IDS on the portal). */
const DELETE_AT_ONCE = 200;

/** How close to the end of what is loaded the viewer has to get before the next page is asked for. */
const AHEAD = 6;

const ORIGINS: { id: PictureOrigin | ""; label: string }[] = [
  { id: "", label: msg("All") },
  { id: "page", label: msg("Made here") },
  { id: "chat", label: msg("From chats") },
  { id: "folder", label: msg("From folders") },
];
const KINDS: { id: PictureKind | ""; label: string }[] = [
  { id: "", label: msg("All") },
  { id: "generated", label: msg("Made") },
  { id: "edited", label: msg("Changed") },
  { id: "uploaded", label: msg("From this computer") },
  { id: "unknown", label: msg("Not known") },
];

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

/** What a folder is called: its agent for an agent's home, as the sidebar names it (Home where the server gave no name), or its place under the workspace root. */
const folderName = (folder: { name: string; home: boolean }): string => (folder.home ? folder.name || t("Home") : folder.name);

/** The viewer's own buttons, with a look for the ones that are on: the ones this page adds match them. */
const viewerButton = `${iconButton} aria-pressed:bg-accent/15 aria-pressed:text-accent`;

interface Listing {
  pictures: GalleryPicture[];
  next: string | null;
  total: number;
  /** What the page's own pictures take of the disk, whatever the filters show. */
  pageBytes: number;
}

/**
 * Pictures made with the image endpoint, here and by the agent in chats: a
 * form to make or change one at the top, and the gallery under it, which is the
 * main part. The portal keeps the list (server/src/image-gallery.ts) and makes
 * the pictures (server/src/image-jobs.ts); this page asks for a page of the
 * list at a time, newest first, and follows the jobs that are running, each of
 * which holds its place in the grid as the picture being made.
 *
 * A picture opens in the viewer, which steps through the gallery, and
 * has this page's actions beside its own. What is filtered is in the address, so
 * that a link and Back keep it.
 */
export function ImagesPage() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const filterKey = `${filter.origin ?? ""}/${filter.kind ?? ""}`;
  const latestFilter = useRef(filter);
  latestFilter.current = filter;
  const setFilter = (next: Filter) => setParams({ ...(next.origin ? { origin: next.origin } : {}), ...(next.kind ? { kind: next.kind } : {}) });

  const [features, setFeatures] = useState<ImagesFeature | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The gallery's own, apart: a page of it that loads ends a page that could not, and nothing else that went wrong.
  const [galleryError, setGalleryError] = useState<string | null>(null);
  // What an edit that is done was made to fit (scaled down, compressed): it went ahead, so it is a warning and not an error.
  const [fitted, setFitted] = useState<string[]>([]);
  useEffect(() => {
    api.imagesFeature().then((r) => setFeatures(r.images), (e: Error) => setError(e.message));
  }, []);
  // Whether a clip can be made from a picture here: the Videos page is there while video generation is on.
  const [videosOn, setVideosOn] = useState(false);
  useEffect(() => {
    api.featureFlags().then((f) => setVideosOn(f.videos?.enabled === true), () => {});
  }, []);

  // The gallery, as far as it has been loaded. A filter asks again from the top, and an answer to what was asked before it is not wanted.
  const [list, setList] = useState<Listing>({ pictures: [], next: null, total: 0, pageBytes: 0 });
  const listRef = useRef(list);
  listRef.current = list;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const asked = useRef(0);
  // What the callbacks below read, kept where they can: the jobs of the page, and what was deleted here.
  const jobsRef = useRef<PictureJob[]>([]);
  const goneRef = useRef<ReadonlySet<string>>(new Set());

  // What was selected is of the list that was shown: another filter, or Back to one, shows other pictures, and what is not on screen is not to be deleted with what is.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const mine = ++asked.current;
    setLoading(true);
    setPicked(new Set());
    setList((cur) => ({ pictures: [], next: null, total: 0, pageBytes: cur.pageBytes }));
    api.galleryPage({ ...filter, limit: PAGE }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList({ pictures: page.pictures, next: page.next, total: page.total, pageBytes: page.pageBytes });
        setLoading(false);
        // A gallery that has loaded is the end of one that could not.
        setGalleryError(null);
      },
      (e: Error) => {
        if (asked.current !== mine) return;
        setGalleryError(e.message);
        setLoading(false);
      },
    );
  }, [filterKey]);

  /**
   * The top of the list again, joined to what is loaded: a picture was made, or taken away, or the agent made one in a chat.
   * The portal does not look through the folders for pictures nobody listed more than once a minute, unless `look` says so: the Refresh button.
   */
  const refreshTop = useCallback((look = false) => {
    const mine = asked.current;
    api.galleryPage({ ...latestFilter.current, limit: PAGE, again: !look }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList((cur) => {
          const pictures = mergeTop(cur.pictures, page);
          const next = pictures.length > page.pictures.length ? cur.next : page.next;
          // Nothing moved: nothing is drawn again.
          return sameList(pictures, cur.pictures) && next === cur.next && page.total === cur.total && page.pageBytes === cur.pageBytes ? cur : { pictures, total: page.total, next, pageBytes: page.pageBytes };
        });
        // A picture that a job made, which this list does not have: asked for, and if the portal has not got it, it was deleted somewhere else (another tab, a phone) and its job does not stand in for it.
        const have = new Set(mergeTop(listRef.current.pictures, page).map((p) => p.id));
        const lost = madeButNotListed(jobsRef.current, have, goneRef.current, latestFilter.current);
        if (!lost.length) return;
        api.galleryPictures(lost).then(
          (found) => {
            const there = new Set(found.pictures.map((p) => p.id));
            const deleted = lost.filter((id) => !there.has(id));
            if (deleted.length && asked.current === mine) setGone((cur) => new Set([...cur, ...deleted]));
          },
          () => {},
        );
      },
      () => {},
    );
  }, []);

  const loadMore = useCallback(() => {
    const { next } = listRef.current;
    if (!next || loadingMoreRef.current) return;
    const mine = asked.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    api
      .galleryPage({ ...latestFilter.current, before: next, limit: PAGE })
      .then(
        (page) => {
          if (asked.current !== mine) return;
          setList((cur) => ({ pictures: appendPage(cur.pictures, page.pictures), next: page.next, total: page.total, pageBytes: page.pageBytes }));
        },
        (e: Error) => asked.current === mine && setGalleryError(e.message),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  // The agent makes pictures in chats while this is open, and the gallery is seen again whenever the tab is.
  useEffect(() => pollWhileVisible(refreshTop, 30_000), [refreshTop]);

  // More of the gallery as the end of what is loaded comes near; the button under it is the same for a keyboard, and for a browser with no observer.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.next || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && loadMore(), { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [list.next, list.pictures.length, loadMore]);

  // What is being made. Asked after every start, and every second or two while something is, which is all it takes to see a picture arrive.
  const [jobs, setJobs] = useState<PictureJob[]>([]);
  jobsRef.current = jobs;
  const [limit, setLimit] = useState(4);
  // What was done already when the page was opened: the pictures are in the gallery, and the jobs are not shown again.
  const ignored = useRef<Set<string> | null>(null);
  const running = useRef<Set<string>>(new Set());
  const poll = useCallback(() => {
    api.pictureJobs().then(
      (r) => {
        ignored.current ??= new Set(r.jobs.filter((j) => j.state === "done").map((j) => j.id));
        const shown = r.jobs.filter((j) => !ignored.current!.has(j.id));
        // A picture that was being made and is done now is in the gallery, and the list asks for it.
        const finished = shown.filter((j) => j.state === "done" && running.current.has(j.id));
        if (finished.length) refreshTop();
        const said = finished.flatMap((j) => j.notes ?? []);
        if (said.length) setFitted(said);
        running.current = new Set(shown.filter((j) => j.state === "running").map((j) => j.id));
        setLimit(r.limit);
        // A job that runs says the same each time it is asked about: only a change is drawn.
        setJobs((cur) => (JSON.stringify(cur) === JSON.stringify(shown) ? cur : shown));
      },
      () => {},
    );
  }, [refreshTop]);
  const active = jobs.some((j) => j.state === "running");
  useEffect(() => {
    poll();
    if (!active) return;
    return pollWhileVisible(poll, 1500);
  }, [active, poll]);

  const started = (made: PictureJob[]) => {
    for (const job of made) running.current.add(job.id);
    setFitted([]);
    setJobs((cur) => [...made, ...cur.filter((j) => !made.some((m) => m.id === j.id))]);
  };
  const dismiss = useCallback((id: string) => {
    running.current.delete(id);
    setJobs((cur) => cur.filter((j) => j.id !== id));
    api.stopPictureJob(id).catch(() => {});
  }, []);

  // What the form is working on: the pictures to change, and the words.
  const [prompt, setPrompt] = useState("");
  const [sources, setSources] = useState<GalleryPicture[]>([]);
  // Making and changing are set up apart: one can be on without the other, and the form has both, whichever is not set up saying so.
  const makes = !!features?.ready;
  const changes = !!features?.editReady;
  // Where the person has not chosen yet, the one that is set up; making where both are.
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (changes && !makes ? "edit" : "make");
  // Pictures are for the edit while it is the form's mode and it can be done: the gallery's tiles are what an edit is made of then.
  const picking = mode === "edit" && changes;
  const multiple = !!features?.editMultiple;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [focusForm, setFocusForm] = useState(0);
  useEffect(() => {
    if (focusForm) promptRef.current?.focus();
  }, [focusForm]);

  // Deleted here: their jobs are not shown any more either, though the server may still have them.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  goneRef.current = gone;
  const [opened, setOpened] = useState<string | null>(null);
  const [originals, setOriginals] = useState<ReadonlyMap<string, GalleryPicture>>(new Map());

  const shownTiles = useMemo(() => tiles(list.pictures, jobs, filter, gone), [list.pictures, jobs, filterKey, gone]);
  const forViewer = useMemo(() => viewerList(list.pictures, originals), [list.pictures, originals]);
  const byId = useMemo(() => new Map(forViewer.map((p) => [p.id, p])), [forViewer]);
  const viewerPictures: ViewerPicture[] = useMemo(() => forViewer.map((p) => viewerPicture(p, api.galleryFileUrl)), [forViewer]);

  // A tick in a tile's box takes the picture into what is selected, in the order they are ticked: for a download, a delete or a change. A click on the picture itself never does, it opens it.
  const toggle = useCallback((id: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const stopSelecting = () => setPicked(new Set());
  // While the form is in Edit the boxes are the pictures of the edit, so what was selected for something else is let go: however the form came to be in Edit, by its switch, the viewer, a Run again, or the add-on being found set up.
  const setMode = (next: Mode) => {
    if (next === "edit") stopSelecting();
    setChosen(next);
  };
  useEffect(() => {
    if (picking) setPicked((cur) => (cur.size ? new Set() : cur));
  }, [picking]);
  const selecting = picked.size > 0;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while a dialog over the page has the key.
      if (isEscape(e) && !document.querySelector('[aria-modal="true"]')) stopSelecting();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting]);

  const open = useCallback((id: string) => setOpened(id), []);

  /** Takes pictures away, after asking: the page's own as the person's, the agent's with the warning that they are files in a folder the chats work in. */
  const remove = async (wanted: string[]) => {
    // Only what the page knows is deleted, so that what the question says is all of what goes: a picture it cannot tell the origin of is not one to take away.
    const chosen = wanted.map((id) => byId.get(id)).filter((p): p is GalleryPicture => !!p);
    const ids = chosen.map((p) => p.id);
    if (!ids.length) return;
    const inChats = chosen.filter((p) => p.origin === "chat");
    const inFolders = chosen.filter((p) => p.origin === "folder");
    const agents = inChats.length + inFolders.length;
    const only = chosen.length === 1 ? chosen[0] : undefined;
    const ok = await confirmDialog({
      title: tp(ids.length, "Delete this picture?", "Delete these {n} pictures?"),
      message: agents
        ? only
          ? only.folder
            ? t("It is a file in the folder “{folder}”, where the agent made it. Deleting it removes it from there for good: the chats that work there will not find it any more, and neither will their Files panel. This cannot be undone.", { folder: folderName(only.folder) })
            : t("It is a file in the folder of the chat “{chat}”, where the agent made it. Deleting it removes it from there for good: the chat will not find it any more, and neither will its Files panel. This cannot be undone.", { chat: only.chat?.title || t("a chat that is gone") })
          : inFolders.length
            ? tp(
                agents,
                "{n} of them is a file in a folder where the agent made it. Deleting removes it from there for good: the chats that work there will not find it any more. This cannot be undone.",
                "{n} of them are files in folders where the agent made them. Deleting removes them from there for good: the chats that work there will not find them any more. This cannot be undone.",
              )
            : tp(
                inChats.length,
                "{n} of them is a file in the folder of a chat, where the agent made it. Deleting removes it from there for good: the chat will not find it any more. This cannot be undone.",
                "{n} of them are files in the folders of chats, where the agent made them. Deleting removes them from there for good: the chats will not find them any more. This cannot be undone.",
              )
        : t("The file is deleted from the portal. This cannot be undone."),
      confirmLabel: t("Delete"),
      danger: true,
      // Asked whatever Settings says where the file is not the page's own: it is in a folder the agent works in, and may be working with it.
      deletes: agents === 0,
    });
    if (!ok) return;
    // The portal takes so many at a time; the question was asked once for all of them.
    const done: { deleted: string[]; failed: { id: string; error: string }[] } = { deleted: [], failed: [] };
    let stopped: Error | undefined;
    try {
      for (let at = 0; at < ids.length; at += DELETE_AT_ONCE) {
        const part = await api.deletePictures(ids.slice(at, at + DELETE_AT_ONCE));
        done.deleted.push(...part.deleted);
        done.failed.push(...part.failed);
      }
    } catch (e) {
      // What was deleted before it went wrong is gone, and is shown as gone.
      stopped = e as Error;
    }
    const deleted = new Set(done.deleted);
    // What was made of a deleted picture does not name it any more, as the portal says it either; and an original that was fetched to be reached from an edit is not reached.
    const unlink = (p: GalleryPicture) => (p.from && deleted.has(p.from) ? { ...p, from: null } : p);
    const freed = chosen.filter((p) => deleted.has(p.id) && p.origin === "page").reduce((sum, p) => sum + p.bytes, 0);
    setList((cur) => ({ ...cur, pictures: cur.pictures.filter((p) => !deleted.has(p.id)).map(unlink), total: Math.max(0, cur.total - deleted.size), pageBytes: Math.max(0, cur.pageBytes - freed) }));
    setOriginals((cur) => new Map([...cur].filter(([id]) => !deleted.has(id)).map(([id, p]) => [id, unlink(p)])));
    setGone((cur) => new Set([...cur, ...deleted]));
    setPicked((cur) => new Set([...cur].filter((id) => !deleted.has(id))));
    setSources((cur) => cur.filter((p) => !deleted.has(p.id)));
    if (stopped) setError(stopped.message);
    else if (done.failed.length) setError(tp(done.failed.length, "One picture could not be deleted: {why}", "{n} pictures could not be deleted: {why}", { why: done.failed[0].error }));
    else setError(null);
  };

  /** Downloads, one file each: the browser may ask once whether this page may download several. */
  const download = (ids: string[]) => {
    ids.forEach((id, i) =>
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = api.galleryFileUrl(id);
        link.download = byId.get(id)?.fileName ?? "";
        document.body.append(link);
        link.click();
        link.remove();
      }, i * 350),
    );
  };

  const toForm = () => {
    setOpened(null);
    scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
    setFocusForm((n) => n + 1);
  };
  const editIt = (picture: GalleryPicture) => {
    setChosen("edit");
    stopSelecting();
    // Where editing is not set up there is nothing to put it in: the form says so, and where to switch it on.
    if (changes) setSources([picture]);
    toForm();
  };
  /** What is selected, taken into an edit in the order it was ticked: the form opens in Edit with those pictures. */
  const editPicked = () => {
    const wanted = [...picked].map((id) => byId.get(id)).filter((p): p is GalleryPicture => !!p);
    if (!wanted.length) return;
    setChosen("edit");
    stopSelecting();
    // Where editing is not set up there is nothing to put them in: the form says so, and where to switch it on.
    if (changes) setSources(addSources([], wanted, multiple).list);
    toForm();
  };
  /** Why what is selected cannot all go into an edit, or nothing when it can. */
  const editRefusal = !changes ? undefined : !multiple && picked.size > 1 ? t("The editing endpoint takes one picture per edit: select one") : picked.size > MAX_SOURCES ? t("An edit takes at most {n} pictures", { n: MAX_SOURCES }) : undefined;
  /** A tick in a box while editing: the picture is taken into the edit, after the ones there, or out of it again; where the endpoint takes one, it takes the place of the one there is. */
  const pick = useCallback(
    (id: string) => {
      const picture = byId.get(id);
      if (!picture) return;
      setSources((cur) => (cur.some((p) => p.id === id) ? cur.filter((p) => p.id !== id) : addSources(cur, [picture], multiple).list));
    },
    [byId, multiple],
  );

  /** Pictures of the gallery by their ids, for a picture of it dragged or pasted into the form: those the page has, and the others asked for. */
  const find = useCallback(
    async (ids: string[]) => {
      const missing = ids.filter((id) => !byId.has(id));
      const fetched = missing.length ? (await api.galleryPictures(missing)).pictures : [];
      return ids.map((id) => byId.get(id) ?? fetched.find((p) => p.id === id)).filter((p): p is GalleryPicture => !!p);
    },
    [byId],
  );

  /** The same again: a picture made from a description is made once more, as it was asked for; a change is shown in the form first, since the mask it had is not kept. */
  const runAgain = async (picture: GalleryPicture) => {
    setError(null);
    try {
      if (picture.kind === "generated") {
        // The settings it was made with, as they are recorded; the free fields an older version sent are not sent again.
        // What only stable-diffusion.cpp reads is sent only while the add-on says the endpoint is one: the picture keeps it, and it is not sent otherwise.
        const { extra: _older, sources: _sources, masked: _masked, negativePrompt, seed, sampleSteps, strength: _strength, fromNoise: _noise, ...settings } = picture.params;
        const { jobs: made } = await api.makePictures({
          prompt: picture.prompt,
          ...settings,
          ...(features?.sdExtras ? { ...(negativePrompt ? { negativePrompt } : {}), ...(seed !== undefined ? { seed } : {}), ...(sampleSteps !== undefined ? { sampleSteps } : {}) } : {}),
        });
        started(made);
        setOpened(null);
        scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const wanted = picture.params.sources?.length ? picture.params.sources : picture.from ? [picture.from] : [];
      const found = wanted.length ? (await api.galleryPictures(wanted)).pictures : [];
      if (!found.length) throw new Error(t("The pictures this was changed from are not in the gallery any more."));
      setPrompt(picture.prompt);
      setSources(wanted.map((id) => found.find((p) => p.id === id)).filter((p): p is GalleryPicture => !!p));
      setChosen("edit");
      toForm();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** The viewer is showing this picture: more of the gallery is asked for when it nears the end of what is loaded, and the original of a change that is further down is fetched, to be reached from it. */
  const shown = useCallback(
    (picture: GalleryPicture) => {
      const loaded = listRef.current;
      const at = loaded.pictures.findIndex((p) => p.id === picture.id);
      if (loaded.next && at >= loaded.pictures.length - AHEAD) loadMore();
      const from = picture.from;
      if (from && !loaded.pictures.some((p) => p.id === from)) {
        api.galleryPictures([from]).then(
          (r) => r.pictures[0] && !goneRef.current.has(from) && setOriginals((cur) => new Map(cur).set(from, r.pictures[0])),
          () => {},
        );
      }
    },
    [loadMore],
  );

  const makingNow = jobs.filter((j) => j.state === "running").length;
  const filtered = !!(filter.origin || filter.kind);
  const pictureTiles = shownTiles.filter((x) => x.picture || x.job?.pictureId);
  const everyId = pictureTiles.map((x) => x.picture?.id ?? x.job!.pictureId!);

  return (
    <div ref={scroller} className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <PageHeader
          icon={<LuImage />}
          title={t("Images")}
          description={t("Make and change pictures with the image endpoint you set up, without a chat, and keep what the agent made in chats.")}
          action={
            <button type="button" onClick={() => { refreshTop(true); poll(); }} className={btnCls} title={t("Look for new pictures")}>
              <LuRefreshCw aria-hidden className="h-4 w-4" />
              {t("Refresh")}
            </button>
          }
        >
          <div className="mt-3 flex flex-wrap gap-2">
            <Stat value={list.total} label={tp(list.total, "picture", "pictures")} />
            {list.pageBytes > 0 && <Stat value={bytesLabel(list.pageBytes)} label={t("kept from this page")} />}
            {makingNow > 0 && <Stat value={makingNow} label={t("being made")} tone="text-accent" />}
          </div>
        </PageHeader>

        {error && <ErrorBanner onClose={() => setError(null)}>{error}</ErrorBanner>}
        {galleryError && <ErrorBanner onClose={() => setGalleryError(null)}>{galleryError}</ErrorBanner>}
        {fitted.length > 0 && (
          <WarnBanner onClose={() => setFitted([])}>
            <p>{t("A picture was changed to fit what an edit takes.")}</p>
            {[...new Set(fitted)].map((note) => (
              <p key={note}>{note}</p>
            ))}
          </WarnBanner>
        )}

        {features && (
          <ImageMaker
            features={features}
            running={makingNow}
            limit={limit}
            prompt={prompt}
            onPrompt={setPrompt}
            promptRef={promptRef}
            mode={mode}
            onMode={setMode}
            sources={sources}
            onSources={setSources}
            onFind={find}
            onStarted={started}
            onUploaded={() => refreshTop()}
          />
        )}

        <section aria-label={t("Gallery")}>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segments showLabel label={t("Where from")} value={filter.origin ?? ""} options={ORIGINS} onChange={(origin) => setFilter({ ...filter, origin: origin || undefined })} />
            <Segments showLabel label={t("How it was made")} value={filter.kind ?? ""} options={KINDS} onChange={(kind) => setFilter({ ...filter, kind: kind || undefined })} />
            {/* Said where the boxes are what an edit is made of, and where they are not: that is all the gallery needs to say of them until one is ticked. */}
            {!selecting && everyId.length > 0 && (
              <span className="ml-auto text-xs text-fg-muted">
                {picking ? (multiple ? t("Tick pictures to use them in the edit, in the order you tick them. A click on a picture opens it.") : t("Tick a picture to use it in the edit. A click on a picture opens it.")) : t("Tick pictures to download, delete or edit them. A click on a picture opens it.")}
              </span>
            )}
          </div>

          {selecting && (
            <div role="group" aria-label={t("Selected pictures")} className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-surface/95 px-3 py-2 shadow-pop backdrop-blur">
              <span className="mr-auto text-sm tabular-nums text-fg" role="status">
                {t("{n} selected", { n: picked.size })}
              </span>
              <button type="button" onClick={() => setPicked(new Set(everyId))} className={ghostCls}>
                {t("Select all shown")}
              </button>
              <button type="button" onClick={editPicked} disabled={!!editRefusal} title={editRefusal} aria-describedby={editRefusal ? "selection-edit-why" : undefined} className={btnCls}>
                <LuWandSparkles aria-hidden className="h-4 w-4" />
                {t("Edit")}
              </button>
              <button type="button" onClick={() => download([...picked])} className={btnCls}>
                <LuDownload aria-hidden className="h-4 w-4" />
                {t("Download")}
              </button>
              <button type="button" onClick={() => void remove([...picked])} className={`${btnCls} hover:!bg-danger/10 hover:text-danger`}>
                <LuTrash2 aria-hidden className="h-4 w-4" />
                {t("Delete")}
              </button>
              <button type="button" onClick={stopSelecting} className={ghostCls}>
                {t("Clear selection")}
              </button>
              {/* In words on the bar and not only in the button's tooltip, which a phone and a keyboard never show. */}
              {editRefusal && (
                <p id="selection-edit-why" className="basis-full text-xs text-fg-muted">
                  {editRefusal}
                </p>
              )}
            </div>
          )}

          {loading ? (
            <div role="status" className="gallery-grid">
              <span className="sr-only">{t("Loading…")}</span>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skeleton aspect-square rounded-lg" style={{ opacity: 1 - i * 0.08 }} />
              ))}
            </div>
          ) : shownTiles.length === 0 ? (
            <Empty>{filtered ? t("No pictures match these filters.") : picking ? t("No pictures yet. Put one in from this computer above to change it.") : t("No pictures yet. Describe one above to make the first.")}</Empty>
          ) : (
            <ul className={`gallery-grid${picking || selecting ? " is-choosing" : ""}`} aria-label={t("Pictures")}>
              {shownTiles.map((tile) => {
                const id = tile.picture?.id ?? tile.job?.pictureId ?? "";
                const place = sources.findIndex((p) => p.id === id) + 1;
                return (
                  <li key={tile.key}>
                    <GalleryTile
                      tile={tile}
                      mode={picking ? "pick" : "select"}
                      selected={picking ? place > 0 : picked.has(id)}
                      place={multiple ? place : 0}
                      // At eight there is no ninth: the tiles that are not in the edit say so, and wait until one is taken out. Only while the boxes are the edit's: the pictures are kept for the way back, and Generate's boxes are for a download, a delete and a change.
                      full={picking && multiple && sources.length >= MAX_SOURCES && place === 0}
                      onOpen={open}
                      onToggle={picking ? pick : toggle}
                      onDismiss={dismiss}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {list.next && (
            <div ref={sentinel} className="mt-4 flex justify-center">
              <button type="button" onClick={loadMore} disabled={loadingMore} className={btnCls}>
                {loadingMore ? t("Loading…") : t("Show more")}
              </button>
            </div>
          )}
        </section>
      </div>

      {opened && (
        <ImageViewer
          pictures={viewerPictures}
          startId={opened}
          onClose={() => setOpened(null)}
          // Where it was opened from: its picture in the gallery.
          anchor={(id) => document.querySelector<HTMLElement>(`[data-picture-id="${CSS.escape(id)}"]`)}
          actions={(vp) => {
            const picture = byId.get(vp.id);
            if (!picture) return null;
            return (
              <ViewerActions
                key={picture.id}
                picture={picture}
                makes={makes}
                canEdit={changes}
                videos={videosOn}
                onShown={shown}
                onEdit={editIt}
                // While the form is in Edit, the pictures are taken into it from here as well, one after another, with the viewer open.
                use={picking ? { on: sources.some((p) => p.id === picture.id), full: multiple && sources.length >= MAX_SOURCES, toggle: () => pick(picture.id) } : undefined}
                onAgain={runAgain}
                onDelete={(p) => void remove([p.id])}
              />
            );
          }}
        />
      )}
    </div>
  );
}

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
function ViewerActions({
  picture,
  makes,
  canEdit,
  videos,
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
  /** Whether video generation is on: a clip can be started from this picture. */
  videos: boolean;
  onShown: (picture: GalleryPicture) => void;
  onEdit: (picture: GalleryPicture) => void;
  /** Where the form is in Edit: whether this picture is one of the edit's, whether the edit has all it takes, and a way to take it in or out. */
  use?: { on: boolean; full: boolean; toggle: () => void };
  onAgain: (picture: GalleryPicture) => void;
  onDelete: (picture: GalleryPicture) => void;
}) {
  const [details, setDetails] = useState(false);
  useEffect(() => onShown(picture), [picture.id, onShown]);
  // A picture put in by the person has no description to make again.
  const again = picture.kind !== "uploaded" && picture.prompt !== "" && (picture.kind === "generated" ? makes : canEdit);
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
          aria-label={t("Use in the edit")}
          title={use.on ? t("Take out of the edit") : use.full ? t("An edit takes at most {n} pictures", { n: MAX_SOURCES }) : t("Use in the edit")}
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
      {videos && (
        // To the Videos page with this picture as the first frame of the clip to be made.
        <Link to={`/videos?from=${picture.id}`} aria-label={t("Make a video from it")} title={t("Make a video from it")} className={viewerButton}>
          <LuVideo aria-hidden className="h-[18px] w-[18px]" />
        </Link>
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
const previewState = (job: PictureJob | undefined): PreviewState => (!job ? "done" : job.state === "running" ? "making" : job.state === "failed" ? "failed" : "done");

/**
 * A click on a tile's picture, or Enter on it, opens it in the viewer, always. What the box in its corner does is the
 * mode: it selects the picture, for a download, a delete or a change (select), or takes it into the edit that the
 * form is in (pick).
 */
type TileMode = "select" | "pick";

const GalleryTile = memo(function GalleryTile({
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
  /** Its place among the pictures of the edit, for one that is in it and where several can be; none is 0. */
  place: number;
  /** Picking, and the edit has all it takes: this one is not in it, and cannot be added. */
  full: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { picture, job } = tile;
  const state = previewState(job);
  const id = picture?.id ?? job?.pictureId;
  const making = state === "making";
  const now = useNow(making);
  const here = state === "done" && id;
  const name = picture ? sourceName(picture) : job?.prompt || "";
  return (
    <div className={`gallery-tile${selected ? " is-selected" : ""}${full ? " is-locked" : ""}`}>
      <ImagePreview
        state={state}
        edit={job?.kind === "edit" || picture?.kind === "edited"}
        src={here ? (picture?.thumb ? api.galleryThumbUrl(id) : api.galleryFileUrl(id)) : undefined}
        before={job?.from && making ? api.galleryFileUrl(job.from) : undefined}
        ratio={1}
        title={picture?.prompt || job?.prompt || picture?.fileName}
        reason={job?.error}
        elapsed={making && job ? Math.max(0, Math.floor((now - job.startedAt) / 1000)) : undefined}
        pictureId={here ? id : undefined}
        onOpen={onOpen}
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
        <label className="gallery-check-hit" title={full ? t("An edit takes at most {n} pictures", { n: MAX_SOURCES }) : undefined}>
          <input
            type="checkbox"
            className="gallery-check"
            checked={selected}
            disabled={full}
            onChange={() => onToggle(id)}
            aria-label={mode === "pick" ? t("Use {name} in the edit", { name }) : t("Select {name}", { name })}
          />
        </label>
      )}
      {mode === "pick" && selected && place > 0 && (
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
