import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LuDownload, LuFolder, LuInfo, LuMessageSquare, LuRefreshCw, LuRepeat, LuTrash2, LuVideo } from "react-icons/lu";
import { api, type GalleryPicture, type GalleryVideo, type VideoJob, type VideoKind, type VideoOrigin, type VideosFeature } from "../api";
import { appendPage, clipSeconds, madeButNotListed, mergeTop, readFilter, sameList, secondsLabel, tiles, type Filter, type Tile } from "../videos-gallery";
import { pollWhileVisible } from "../poll";
import { bytesLabel } from "../projects";
import { isEscape } from "../shortcuts";
import { sinceThen } from "../time";
import { formatDateTime, msg, t, tp } from "../i18n";
import { useNow } from "../use-now";
import { confirmDialog } from "./ConfirmDialog";
import { ImagePreview, type PreviewState } from "./ImagePreview";
import { iconButton } from "./ImageViewer";
import { PageHeader, Stat } from "./PageHeader";
import { Empty, ErrorBanner, Segments, btnCls, ghostCls } from "./SettingsUi";
import { VideoMaker } from "./VideoMaker";
import { VideoViewer, type ViewerVideo } from "./VideoViewer";

/** How many clips a page of the gallery has: enough to fill a screen and some, and few enough to be quick (a clip is much heavier than a picture). */
const PAGE = 24;
/** The most clips one request to delete may name (MAX_IDS on the portal). */
const DELETE_AT_ONCE = 200;
/** How close to the end of what is loaded the viewer has to get before the next page is asked for. */
const AHEAD = 4;

const ORIGINS: { id: VideoOrigin | ""; label: string }[] = [
  { id: "", label: msg("All") },
  { id: "page", label: msg("Made here") },
  { id: "chat", label: msg("From chats") },
  { id: "folder", label: msg("From folders") },
];
const KINDS: { id: VideoKind | ""; label: string }[] = [
  { id: "", label: msg("All") },
  { id: "generated", label: msg("From a description") },
  { id: "animated", label: msg("From a picture") },
  { id: "unknown", label: msg("Not known") },
];

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

/** What a folder is called: its agent for an agent's home, as the sidebar names it (Home where the server gave no name), or its place under the workspace root. */
const folderName = (folder: { name: string; home: boolean }): string => (folder.home ? folder.name || t("Home") : folder.name);

/** The viewer's own buttons, with a look for the ones that are on: the ones this page adds match them. */
const viewerButton = `${iconButton} aria-pressed:bg-accent/15 aria-pressed:text-accent`;

interface Listing {
  videos: GalleryVideo[];
  next: string | null;
  total: number;
  /** What the page's own clips take of the disk, whatever the filters show. */
  pageBytes: number;
}

/** What a clip is called where it is named: its description, or the file's name for one that has none. */
const nameOf = (video: GalleryVideo): string => (video.prompt || video.fileName).replace(/\s+/g, " ").trim();

/**
 * Clips made with the video endpoint, here and by the agent in chats: a form to make one at the top, and the
 * gallery under it, which is the main part. The portal keeps the list (server/src/video-gallery.ts) and makes the
 * clips (server/src/video-jobs.ts); this page asks for a page of the list at a time, newest first, and follows the
 * jobs that are running, each of which holds its place in the grid as the clip being made. A clip takes minutes,
 * so a job that waits for its turn on the server says so, and how long it has been.
 *
 * A clip opens in the viewer, a player that steps through the gallery, with this page's actions beside its own.
 * What is filtered is in the address, so that a link and Back keep it; `from` in it is a picture of the Images
 * page that the form starts a clip from.
 */
export function VideosPage() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const filterKey = `${filter.origin ?? ""}/${filter.kind ?? ""}`;
  const latestFilter = useRef(filter);
  latestFilter.current = filter;
  const setFilter = (next: Filter) => setParams({ ...(next.origin ? { origin: next.origin } : {}), ...(next.kind ? { kind: next.kind } : {}) });

  const [features, setFeatures] = useState<VideosFeature | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The gallery's own, apart: a page of it that loads ends a page that could not, and nothing else that went wrong.
  const [galleryError, setGalleryError] = useState<string | null>(null);
  useEffect(() => {
    api.videosFeature().then((r) => setFeatures(r.videos), (e: Error) => setError(e.message));
  }, []);

  // The gallery, as far as it has been loaded. A filter asks again from the top, and an answer to what was asked before it is not wanted.
  const [list, setList] = useState<Listing>({ videos: [], next: null, total: 0, pageBytes: 0 });
  const listRef = useRef(list);
  listRef.current = list;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const asked = useRef(0);
  // What the callbacks below read, kept where they can: the jobs of the page, and what was deleted here.
  const jobsRef = useRef<VideoJob[]>([]);
  const goneRef = useRef<ReadonlySet<string>>(new Set());

  // What was selected is of the list that was shown: another filter, or Back to one, shows other clips, and what is not on screen is not to be deleted with what is.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const mine = ++asked.current;
    setLoading(true);
    setPicked(new Set());
    setList((cur) => ({ videos: [], next: null, total: 0, pageBytes: cur.pageBytes }));
    api.videoPage({ ...filter, limit: PAGE }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList({ videos: page.videos, next: page.next, total: page.total, pageBytes: page.pageBytes });
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
   * The top of the list again, joined to what is loaded: a clip was made, or taken away, or the agent made one in a chat.
   * The portal does not look through the folders for clips nobody listed more than once a minute, unless `look` says so: the Refresh button.
   */
  const refreshTop = useCallback((look = false) => {
    const mine = asked.current;
    api.videoPage({ ...latestFilter.current, limit: PAGE, again: !look }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList((cur) => {
          const videos = mergeTop(cur.videos, page);
          const next = videos.length > page.videos.length ? cur.next : page.next;
          // Nothing moved: nothing is drawn again.
          return sameList(videos, cur.videos) && next === cur.next && page.total === cur.total && page.pageBytes === cur.pageBytes ? cur : { videos, total: page.total, next, pageBytes: page.pageBytes };
        });
        // A clip that a job made, which this list does not have: asked for, and if the portal has not got it, it was deleted somewhere else and its job does not stand in for it.
        const have = new Set(mergeTop(listRef.current.videos, page).map((v) => v.id));
        const lost = madeButNotListed(jobsRef.current, have, goneRef.current, latestFilter.current);
        if (!lost.length) return;
        api.galleryVideos(lost).then(
          (found) => {
            const there = new Set(found.videos.map((v) => v.id));
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
      .videoPage({ ...latestFilter.current, before: next, limit: PAGE })
      .then(
        (page) => {
          if (asked.current !== mine) return;
          setList((cur) => ({ videos: appendPage(cur.videos, page.videos), next: page.next, total: page.total, pageBytes: page.pageBytes }));
        },
        (e: Error) => asked.current === mine && setGalleryError(e.message),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  // The agent makes clips in chats while this is open, and the gallery is seen again whenever the tab is.
  useEffect(() => pollWhileVisible(refreshTop, 30_000), [refreshTop]);

  // More of the gallery as the end of what is loaded comes near; the button under it is the same for a keyboard, and for a browser with no observer.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.next || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && loadMore(), { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [list.next, list.videos.length, loadMore]);

  // What is being made. Asked after every start, and every second or two while something is, which is all it takes to see a clip arrive.
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  jobsRef.current = jobs;
  const [limit, setLimit] = useState(4);
  // What was done already when the page was opened: the clips are in the gallery, and the jobs are not shown again.
  const ignored = useRef<Set<string> | null>(null);
  const running = useRef<Set<string>>(new Set());
  const poll = useCallback(() => {
    api.videoJobs().then(
      (r) => {
        ignored.current ??= new Set(r.jobs.filter((j) => j.state === "done").map((j) => j.id));
        const shown = r.jobs.filter((j) => !ignored.current!.has(j.id));
        // A clip that was being made and is done now is in the gallery, and the list asks for it.
        if (shown.some((j) => j.state === "done" && running.current.has(j.id))) refreshTop();
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
    return pollWhileVisible(poll, 2000);
  }, [active, poll]);

  const started = (made: VideoJob[]) => {
    for (const job of made) running.current.add(job.id);
    setJobs((cur) => [...made, ...cur.filter((j) => !made.some((m) => m.id === j.id))]);
  };
  const dismiss = useCallback((id: string) => {
    running.current.delete(id);
    setJobs((cur) => cur.filter((j) => j.id !== id));
    api.stopVideoJob(id).catch(() => {});
  }, []);

  // What the form is working on: the words, and the picture to start from.
  const [prompt, setPrompt] = useState("");
  const [firstFrame, setFirstFrame] = useState<GalleryPicture | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A picture of the Images page sent here (`from` in the address) is the form's first frame; the address is cleared of it, so that a reload does not bring it back.
  const from = params.get("from");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!from) return;
    api.galleryPictures([from]).then(
      (r) => {
        if (!alive.current) return;
        if (r.pictures[0]) {
          setFirstFrame(r.pictures[0]);
          promptRef.current?.focus();
        } else setError(t("The picture to start from is not in the gallery any more."));
      },
      (e: Error) => alive.current && setError(e.message),
    );
    const rest = new URLSearchParams(params);
    rest.delete("from");
    setParams(rest, { replace: true });
  }, [from]);

  // Deleted here: their jobs are not shown any more either, though the server may still have them.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  goneRef.current = gone;
  const [opened, setOpened] = useState<string | null>(null);

  const shownTiles = useMemo(() => tiles(list.videos, jobs, filter, gone), [list.videos, jobs, filterKey, gone]);
  const byId = useMemo(() => new Map(list.videos.map((v) => [v.id, v])), [list.videos]);
  const viewerVideos: ViewerVideo[] = useMemo(
    () =>
      list.videos.map((v) => ({
        id: v.id,
        src: api.videoFileUrl(v.id),
        ...(v.poster ? { poster: api.videoPosterUrl(v.id) } : {}),
        label: nameOf(v),
        ...(v.prompt ? { caption: v.prompt } : {}),
        fileName: v.fileName,
      })),
    [list.videos],
  );

  // A tick in a tile's box takes the clip into what is selected, for a download or a delete. A click on the clip itself never does, it opens it.
  const toggle = useCallback((id: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const stopSelecting = () => setPicked(new Set());
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

  /** Takes clips away, after asking: the page's own as the person's, the agent's with the warning that they are files in a folder the chats work in. */
  const remove = async (wanted: string[]) => {
    // Only what the page knows is deleted, so that what the question says is all of what goes.
    const chosen = wanted.map((id) => byId.get(id)).filter((v): v is GalleryVideo => !!v);
    const ids = chosen.map((v) => v.id);
    if (!ids.length) return;
    const inChats = chosen.filter((v) => v.origin === "chat");
    const inFolders = chosen.filter((v) => v.origin === "folder");
    const agents = inChats.length + inFolders.length;
    const only = chosen.length === 1 ? chosen[0] : undefined;
    const ok = await confirmDialog({
      title: tp(ids.length, "Delete this video?", "Delete these {n} videos?"),
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
        const part = await api.deleteVideos(ids.slice(at, at + DELETE_AT_ONCE));
        done.deleted.push(...part.deleted);
        done.failed.push(...part.failed);
      }
    } catch (e) {
      // What was deleted before it went wrong is gone, and is shown as gone.
      stopped = e as Error;
    }
    const deleted = new Set(done.deleted);
    const freed = chosen.filter((v) => deleted.has(v.id) && v.origin === "page").reduce((sum, v) => sum + v.bytes, 0);
    setList((cur) => ({ ...cur, videos: cur.videos.filter((v) => !deleted.has(v.id)), total: Math.max(0, cur.total - deleted.size), pageBytes: Math.max(0, cur.pageBytes - freed) }));
    setGone((cur) => new Set([...cur, ...deleted]));
    setPicked((cur) => new Set([...cur].filter((id) => !deleted.has(id))));
    if (stopped) setError(stopped.message);
    else if (done.failed.length) setError(tp(done.failed.length, "One video could not be deleted: {why}", "{n} videos could not be deleted: {why}", { why: done.failed[0].error }));
    else setError(null);
  };

  /** Downloads, one file each: the browser may ask once whether this page may download several. */
  const download = (ids: string[]) => {
    ids.forEach((id, i) =>
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = api.videoFileUrl(id);
        link.download = byId.get(id)?.fileName ?? "";
        document.body.append(link);
        link.click();
        link.remove();
      }, i * 350),
    );
  };

  /** The same again: a clip made from a description is made once more, as it was asked for; one made from a picture needs that picture to be in the gallery still. */
  const runAgain = async (video: GalleryVideo) => {
    setError(null);
    try {
      const { madeFrames: _frames, madeFps: _fps, firstFrame: first, ...settings } = video.params;
      if (video.kind === "animated") {
        const picture = first?.picture ? (await api.galleryPictures([first.picture])).pictures[0] : undefined;
        if (!picture) throw new Error(t("The picture this was made from is not in the gallery any more."));
      }
      const { jobs: made } = await api.makeVideos({ prompt: video.prompt, ...settings, ...(video.kind === "animated" && first?.picture ? { firstFrame: first.picture } : {}) });
      started(made);
      setOpened(null);
      scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** The viewer is showing this clip: more of the gallery is asked for when it nears the end of what is loaded. */
  const shown = useCallback(
    (video: GalleryVideo) => {
      const loaded = listRef.current;
      const at = loaded.videos.findIndex((v) => v.id === video.id);
      if (loaded.next && at >= loaded.videos.length - AHEAD) loadMore();
    },
    [loadMore],
  );

  const makingNow = jobs.filter((j) => j.state === "running").length;
  const filtered = !!(filter.origin || filter.kind);
  const everyId = shownTiles.flatMap((x) => (x.video ? [x.video.id] : x.job?.videoId ? [x.job.videoId] : []));

  return (
    <div ref={scroller} className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <PageHeader
          icon={<LuVideo />}
          title={t("Videos")}
          description={t("Make short videos with the video endpoint you set up, without a chat, and keep what the agent made in chats.")}
          action={
            <button type="button" onClick={() => { refreshTop(true); poll(); }} className={btnCls} title={t("Look for new videos")}>
              <LuRefreshCw aria-hidden className="h-4 w-4" />
              {t("Refresh")}
            </button>
          }
        >
          <div className="mt-3 flex flex-wrap gap-2">
            <Stat value={list.total} label={tp(list.total, "video", "videos")} />
            {list.pageBytes > 0 && <Stat value={bytesLabel(list.pageBytes)} label={features?.storageLimitMb ? t("kept from this page, of {limit}", { limit: bytesLabel(features.storageLimitMb * 1024 * 1024) }) : t("kept from this page")} />}
            {makingNow > 0 && <Stat value={makingNow} label={t("being made")} tone="text-accent" />}
          </div>
        </PageHeader>

        {error && <ErrorBanner onClose={() => setError(null)}>{error}</ErrorBanner>}
        {galleryError && <ErrorBanner onClose={() => setGalleryError(null)}>{galleryError}</ErrorBanner>}

        {features && (
          <VideoMaker
            features={features}
            running={makingNow}
            limit={limit}
            prompt={prompt}
            onPrompt={setPrompt}
            promptRef={promptRef}
            firstFrame={firstFrame}
            onFirstFrame={setFirstFrame}
            onStarted={started}
          />
        )}

        <section aria-label={t("Gallery")}>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segments showLabel label={t("Where from")} value={filter.origin ?? ""} options={ORIGINS} onChange={(origin) => setFilter({ ...filter, origin: origin || undefined })} />
            <Segments showLabel label={t("How it was made")} value={filter.kind ?? ""} options={KINDS} onChange={(kind) => setFilter({ ...filter, kind: kind || undefined })} />
            {!selecting && everyId.length > 0 && <span className="ml-auto text-xs text-fg-muted">{t("Tick videos to download or delete them. A click on a video plays it.")}</span>}
          </div>

          {selecting && (
            <div role="group" aria-label={t("Selected videos")} className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-surface/95 px-3 py-2 shadow-pop backdrop-blur">
              <span className="mr-auto text-sm tabular-nums text-fg" role="status">
                {t("{n} selected", { n: picked.size })}
              </span>
              <button type="button" onClick={() => setPicked(new Set(everyId))} className={ghostCls}>
                {t("Select all shown")}
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
            <Empty>{filtered ? t("No videos match these filters.") : t("No videos yet. Describe one above to make the first.")}</Empty>
          ) : (
            <ul className={`gallery-grid${selecting ? " is-choosing" : ""}`} aria-label={t("Videos")}>
              {shownTiles.map((tile) => (
                <li key={tile.key}>
                  <GalleryTile tile={tile} selected={picked.has(tile.video?.id ?? tile.job?.videoId ?? "")} onOpen={open} onToggle={toggle} onDismiss={dismiss} />
                </li>
              ))}
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
        <VideoViewer
          videos={viewerVideos}
          startId={opened}
          onClose={() => setOpened(null)}
          // Where it was opened from: its clip in the gallery.
          anchor={(id) => document.querySelector<HTMLElement>(`[data-picture-id="${CSS.escape(id)}"]`)}
          actions={(vv) => {
            const video = byId.get(vv.id);
            if (!video) return null;
            return <ViewerActions key={video.id} video={video} makes={!!features?.ready} onShown={shown} onAgain={runAgain} onDelete={(v) => void remove([v.id])} />;
          }}
        />
      )}
    </div>
  );
}

/** What the clip was made with and for, in words. */
function VideoDetails({ video }: { video: GalleryVideo }) {
  const { params } = video;
  const seconds = clipSeconds(params);
  const rows: [string, string][] = [
    [t("Made"), formatDateTime(video.createdAt)],
    [t("How"), t(KIND_NAME[video.kind])],
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
    ...(params.firstFrame?.path ? [[t("First frame"), params.firstFrame.path] as [string, string]] : []),
    [t("File"), `${video.fileName} · ${bytesLabel(video.bytes)}`],
  ];
  const [frameGone, setFrameGone] = useState(false);
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
function ViewerActions({
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
  const [details, setDetails] = useState(false);
  useEffect(() => onShown(video), [video.id, onShown]);
  // One found in a folder has no description to make again, and one the agent made from a picture of its folder has no picture of the gallery to start from.
  const again = makes && video.prompt !== "" && (video.kind === "generated" || (video.kind === "animated" && !!video.params.firstFrame?.picture));
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

/** What a job's state is to the preview. */
const previewState = (job: VideoJob | undefined): PreviewState => (!job ? "done" : job.state === "running" ? "making" : job.state === "failed" ? "failed" : "done");

/** Where a clip that is being made is, in words: waiting its turn on the server (and which place it has), or being made. */
function stageText(job: VideoJob): string | undefined {
  if (job.stage === "waiting") return job.queuePosition ? t("Waiting its turn on the server: place {n}", { n: job.queuePosition }) : t("Waiting its turn on the server");
  if (job.stage === "making") return t("Being made on the server");
  return undefined;
}

const GalleryTile = memo(function GalleryTile({
  tile,
  selected,
  onOpen,
  onToggle,
  onDismiss,
}: {
  tile: Tile;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { video, job } = tile;
  const state = previewState(job);
  const id = video?.id ?? job?.videoId;
  const making = state === "making";
  const now = useNow(making);
  const here = state === "done" && id;
  const name = video ? nameOf(video) : job?.prompt || "";
  const seconds = video ? clipSeconds(video.params) : undefined;
  return (
    <div className={`gallery-tile${selected ? " is-selected" : ""}`}>
      <ImagePreview
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
