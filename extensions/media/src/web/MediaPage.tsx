import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuDownload, LuImages, LuRefreshCw, LuTrash2, LuWandSparkles } from "react-icons/lu";
import type { ViewerPicture } from "@pithagoras/extension-api";
import { Segments, confirmDialog, msg, portal, t, tp } from "../portal";
import { api, type GalleryPicture, type GalleryVideo, type ImagesFeature, type VideosFeature } from "./api";
import { onMediaChanged } from "./changes";
import { MAX_SOURCES, addSources } from "./edit-sources";
import { viewerList, viewerPicture } from "./images-gallery";
import { pictureSource, videoSource } from "./gallery-sources";
import { behind, feedFilters, filterParams, folderName, joinTiles, kindOptions, readFilter, selectionKey, shownKinds, splitSelection, tileSelection, type MediaFilter, type Show } from "./media-gallery";
import { videoName } from "./videos-gallery";
import { useGalleryFeed } from "./use-gallery-feed";
import { bytesLabel, isEscape } from "./helpers";
import { ImageMaker, type Mode } from "./ImageMaker";
import { PictureTile, PictureViewerActions } from "./PictureParts";
import { VideoMaker } from "./VideoMaker";
import { VideoTile, VideoViewerActions } from "./VideoParts";
import { VideoViewer, type ViewerVideo } from "./VideoViewer";

/** The most pictures or videos one request to delete may name (MAX_IDS on the server half). */
const DELETE_AT_ONCE = 200;

/** How close to the end of what is loaded the viewer has to get before the next page is asked for: a video is heavier, so it asks sooner. */
const PICTURES_AHEAD = 6;
const VIDEOS_AHEAD = 4;

const SHOWS: { id: Show; label: string }[] = [
  { id: "all", label: msg("All") },
  { id: "images", label: msg("Pictures") },
  { id: "videos", label: msg("Videos") },
];

const ORIGINS = [
  { id: "" as const, label: msg("All") },
  { id: "page" as const, label: msg("Made here") },
  { id: "chat" as const, label: msg("From chats") },
  { id: "folder" as const, label: msg("From folders") },
];

const MAKES = [
  { id: "picture" as const, label: msg("A picture") },
  { id: "video" as const, label: msg("A video") },
];

/**
 * Pictures and videos made with the endpoints you set up, here and by the agent in chats: a form to make or change a
 * picture, or to make a video, at the top, and the gallery under it, which is the main part. The server half keeps the
 * two lists and makes the pictures and videos, as jobs; this page asks for a page of each list at a time, newest first,
 * puts them together as one gallery, and follows the jobs that are running, each of which holds its place in the grid
 * as the picture or video being made.
 *
 * What the gallery shows is in the address, so that a link and Back keep it: both kinds or one, where they are from,
 * how they were made. A picture or a video opens in its viewer, which steps through the ones of its kind, and has this
 * page's actions beside its own.
 */
export function MediaPage() {
  portal.locale.use();
  const { ui } = portal;
  const { button: btnCls, ghost: ghostCls } = ui.classes;
  const { path, search } = portal.useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const wanted = useMemo(() => readFilter(params), [params]);
  /** The page with this query in its address: a step of its own in the history, so that Back goes through the filters, or in the place of the one shown. */
  const setParams = (next: Record<string, string> | URLSearchParams, options?: { replace?: boolean }) => {
    const query = new URLSearchParams(next).toString();
    portal.navigate(query ? `${path}?${query}` : path, options);
  };
  const setFilter = (next: MediaFilter) => setParams(filterParams(next));

  // What the portal makes at all: the sidebar has this page while it makes either. Until it has said, nothing is asked for.
  const [flags, setFlags] = useState<{ pictures: boolean; videos: boolean } | null>(null);
  useEffect(() => {
    const ask = () =>
      api.state().then(
        (s) => setFlags({ pictures: s.images.enabled, videos: s.videos.enabled }),
        () => setFlags((cur) => cur ?? { pictures: true, videos: false }),
      );
    void ask();
    // Said by Settings when it switches either.
    return onMediaChanged(ask);
  }, []);
  // The pictures are there while nothing is made, as the page was before there were videos.
  const picturesOn = !!flags && (flags.pictures || !flags.videos);
  const videosOn = !!flags?.videos;
  const show = shownKinds(wanted.show, picturesOn, videosOn);
  const { pictures: pictureFilter, videos: videoFilter } = feedFilters(wanted, show);
  const filterKey = JSON.stringify([pictureFilter, videoFilter]);

  const pictures = useGalleryFeed(pictureSource, picturesOn, pictureFilter);
  const videos = useGalleryFeed(videoSource, videosOn, videoFilter);

  const [images, setImages] = useState<ImagesFeature | null>(null);
  const [clips, setClips] = useState<VideosFeature | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (picturesOn) api.imagesFeature().then((r) => setImages(r.images), (e: Error) => setError(e.message));
  }, [picturesOn]);
  useEffect(() => {
    if (videosOn) api.videosFeature().then((r) => setClips(r.videos), (e: Error) => setError(e.message));
  }, [videosOn]);

  // What was selected is of the list that was shown: another filter, or Back to one, shows other things, and what is not on screen is not to be deleted with what is.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setPicked(new Set()), [filterKey]);

  // What the forms are working on: for a picture, the words, the pictures to change and a new picture's references; for a video, the words and the pictures to start from and end on.
  const [prompt, setPrompt] = useState("");
  const [sources, setSources] = useState<GalleryPicture[]>([]);
  const [references, setReferences] = useState<GalleryPicture[]>([]);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [firstFrame, setFirstFrame] = useState<GalleryPicture | null>(null);
  const [lastFrame, setLastFrame] = useState<GalleryPicture | null>(null);
  // Making and changing pictures are set up apart: one can be on without the other, and the form has both, whichever is not set up saying so.
  const makes = !!images?.ready;
  const changes = !!images?.editReady;
  // Where the person has not chosen yet, the one that is set up; making where both are.
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (changes && !makes ? "edit" : "make");
  // Which form is shown, where both can be: the person's choice, else the kind the gallery is showing.
  const [chosenMake, setChosenMake] = useState<"picture" | "video" | null>(null);
  const making: "picture" | "video" = chosenMake === "picture" && picturesOn ? "picture" : chosenMake === "video" && videosOn ? "video" : !picturesOn || show === "videos" ? "video" : "picture";
  // Pictures are for the edit while it is the form's mode and it can be done: the gallery's tiles are what an edit is made of then. So they are a new picture's references while the form has those open in Generate.
  const referring = making === "picture" && mode === "make" && makes && changes && referencesOpen;
  const picking = (making === "picture" && mode === "edit" && changes) || referring;
  // The pictures the boxes choose while picking: the edit's, or the references.
  const chosenList = referring ? references : sources;
  const setChosenList = referring ? setReferences : setSources;
  const multiple = !!images?.editMultiple;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const videoPromptRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [focusForm, setFocusForm] = useState(0);
  useEffect(() => {
    if (focusForm) (making === "video" ? videoPromptRef : promptRef).current?.focus();
  }, [focusForm]);

  // A picture sent here (`from` in the address, as a link to the old Videos page had it) is the form's first frame; the address is cleared of it, so that a reload does not bring it back.
  const from = params.get("from");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!from || !flags) return;
    if (videosOn) {
      api.galleryPictures([from]).then(
        (r) => {
          if (!alive.current) return;
          if (r.pictures[0]) {
            setChosenMake("video");
            setFirstFrame(r.pictures[0]);
            setFocusForm((n) => n + 1);
          } else setError(t("The picture to start from is not in the gallery any more."));
        },
        (e: Error) => alive.current && setError(e.message),
      );
    }
    const rest = new URLSearchParams(params);
    rest.delete("from");
    setParams(rest, { replace: true });
  }, [from, flags]);

  // The original of a change that is further down than the page has reached, fetched to be reached from the change.
  const [originals, setOriginals] = useState<ReadonlyMap<string, GalleryPicture>>(new Map());
  const [opened, setOpened] = useState<{ kind: "picture" | "video"; id: string } | null>(null);

  const joined = useMemo(
    () =>
      joinTiles(
        pictureFilter ? { tiles: pictures.tiles, view: { items: pictures.list.items, more: !!pictures.list.next } } : null,
        videoFilter ? { tiles: videos.tiles, view: { items: videos.list.items, more: !!videos.list.next } } : null,
      ),
    [pictures.tiles, pictures.list.items, pictures.list.next, videos.tiles, videos.list.items, videos.list.next, filterKey],
  );
  const forViewer = useMemo(() => viewerList(pictures.list.items, originals), [pictures.list.items, originals]);
  const pictureById = useMemo(() => new Map(forViewer.map((p) => [p.id, p])), [forViewer]);
  const viewerPictures: ViewerPicture[] = useMemo(() => forViewer.map((p) => viewerPicture(p, api.galleryFileUrl)), [forViewer]);
  const videoById = useMemo(() => new Map(videos.list.items.map((v) => [v.id, v])), [videos.list.items]);
  const viewerVideos: ViewerVideo[] = useMemo(
    () =>
      videos.list.items.map((v) => ({
        id: v.id,
        src: api.videoFileUrl(v.id),
        ...(v.poster ? { poster: api.videoPosterUrl(v.id) } : {}),
        label: videoName(v),
        ...(v.prompt ? { caption: v.prompt } : {}),
        fileName: v.fileName,
        // A clip a browser does not play is offered as a download there, with a WebM copy to play where there is one.
        ...(v.format ? { format: { label: v.format.label, playable: v.format.playable } } : {}),
        ...(v.copy ? { copy: { url: api.videoCopyUrl(v.id), state: v.copy } } : {}),
      })),
    [videos.list.items],
  );

  // More of the gallery as the end of what is loaded comes near. Of the lists that still have more, those whose last item is the horizon are asked: the others are known further down already.
  const latest = useRef({ pictures, videos, pictureFilter, videoFilter });
  latest.current = { pictures, videos, pictureFilter, videoFilter };
  const loadMore = useCallback(() => {
    const { pictures: p, videos: v, pictureFilter: pf, videoFilter: vf } = latest.current;
    const view = (list: { items: { id: string; createdAt: number }[]; next: string | null }, on: boolean) => (on ? { items: list.items, more: !!list.next } : null);
    const todo = behind(view(p.listRef.current, !!pf), view(v.listRef.current, !!vf));
    if (todo.includes("pictures") || (!todo.length && pf)) p.loadMore();
    if (todo.includes("videos") || (!todo.length && vf)) v.loadMore();
  }, []);
  const more = (!!pictureFilter && !!pictures.list.next) || (!!videoFilter && !!videos.list.next);
  const loadedCount = pictures.list.items.length + videos.list.items.length;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && loadMore(), { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, loadedCount, loadMore]);

  // A tick in a tile's box takes it into what is selected, in the order they are ticked: for a download, a delete or a change. A click on the tile itself never does, it opens it.
  const toggle = useCallback((key: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const togglePicture = useCallback((id: string) => toggle(selectionKey("picture", id)), [toggle]);
  const toggleVideo = useCallback((id: string) => toggle(selectionKey("video", id)), [toggle]);
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

  /**
   * A picture or a video was started while the filters would leave its tile out: the other kind is shown, or a kind or an
   * origin it does not have. Those filters are let go of, so that the one being made has its place; what fits it stays.
   */
  const reveal = (list: "pictures" | "videos", made: { kind: string }[]) => {
    const ofKind = list === "videos" ? (made[0]?.kind === "animate" ? "animated" : "generated") : made[0]?.kind === "edit" ? "edited" : "generated";
    const shown = list === "pictures" ? show !== "videos" : show !== "images";
    const origin = wanted.origin === "page" ? "page" : undefined;
    const kind = wanted.kind === ofKind ? ofKind : undefined;
    if (shown && origin === wanted.origin && kind === wanted.kind) return;
    setFilter({ show: shown ? wanted.show : "all", origin, kind });
  };

  const openPicture = useCallback((id: string) => setOpened({ kind: "picture", id }), []);
  const openVideo = useCallback((id: string) => setOpened({ kind: "video", id }), []);

  /** Takes pictures and videos away, after asking: the page's own as the person's, the agent's with the warning that they are files in a folder the chats work in. */
  const remove = async (keys: string[]) => {
    const asked = splitSelection(keys);
    // Only what the page knows is deleted, so that what the question says is all of what goes: one it cannot tell the origin of is not one to take away.
    const chosenPictures = asked.pictures.map((id) => pictureById.get(id)).filter((p): p is GalleryPicture => !!p);
    const chosenVideos = asked.videos.map((id) => videoById.get(id)).filter((v): v is GalleryVideo => !!v);
    const all = [...chosenPictures, ...chosenVideos];
    if (!all.length) return;
    const inChats = all.filter((x) => x.origin === "chat");
    const inFolders = all.filter((x) => x.origin === "folder");
    const agents = inChats.length + inFolders.length;
    const only = all.length === 1 ? all[0] : undefined;
    const ok = await confirmDialog({
      title: !chosenVideos.length
        ? tp(all.length, "Delete this picture?", "Delete these {n} pictures?")
        : !chosenPictures.length
          ? tp(all.length, "Delete this video?", "Delete these {n} videos?")
          : t("Delete these {n} files?", { n: all.length }),
      message: agents
        ? only
          ? only.folder
            ? t("It is a file in the folder “{folder}”, where the agent made it. Deleting it removes it from there for good: the chats that work there will not find it any more. This cannot be undone.", { folder: folderName(only.folder) })
            : t("It is a file in the folder of the chat “{chat}”, where the agent made it. Deleting it removes it from there for good: the chat will not find it any more. This cannot be undone.", { chat: only.chat?.title || t("a chat that is gone") })
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
    const done = { pictures: { deleted: [] as string[], failed: [] as { id: string; error: string }[] }, videos: { deleted: [] as string[], failed: [] as { id: string; error: string }[] } };
    let stopped: Error | undefined;
    try {
      const ids = chosenPictures.map((p) => p.id);
      for (let at = 0; at < ids.length; at += DELETE_AT_ONCE) {
        const part = await api.deletePictures(ids.slice(at, at + DELETE_AT_ONCE));
        done.pictures.deleted.push(...part.deleted);
        done.pictures.failed.push(...part.failed);
      }
      const clipIds = chosenVideos.map((v) => v.id);
      for (let at = 0; at < clipIds.length; at += DELETE_AT_ONCE) {
        const part = await api.deleteVideos(clipIds.slice(at, at + DELETE_AT_ONCE));
        done.videos.deleted.push(...part.deleted);
        done.videos.failed.push(...part.failed);
      }
    } catch (e) {
      // What was deleted before it went wrong is gone, and is shown as gone.
      stopped = e as Error;
    }
    const deletedPictures = new Set(done.pictures.deleted);
    const deletedVideos = new Set(done.videos.deleted);
    if (deletedPictures.size) {
      const freed = chosenPictures.filter((p) => deletedPictures.has(p.id) && p.origin === "page").reduce((sum, p) => sum + p.bytes, 0);
      pictures.forget(deletedPictures, freed);
      // An original that was fetched to be reached from an edit is not reached any more, and what was made of a deleted picture does not name it.
      const unlink = (p: GalleryPicture) => (p.from && deletedPictures.has(p.from) ? { ...p, from: null } : p);
      setOriginals((cur) => new Map([...cur].filter(([id]) => !deletedPictures.has(id)).map(([id, p]) => [id, unlink(p)])));
      setSources((cur) => cur.filter((p) => !deletedPictures.has(p.id)));
      setReferences((cur) => cur.filter((p) => !deletedPictures.has(p.id)));
    }
    if (deletedVideos.size) {
      const freed = chosenVideos.filter((v) => deletedVideos.has(v.id) && v.origin === "page").reduce((sum, v) => sum + v.bytes, 0);
      videos.forget(deletedVideos, freed);
    }
    const goneKeys = new Set([...[...deletedPictures].map((id) => selectionKey("picture", id)), ...[...deletedVideos].map((id) => selectionKey("video", id))]);
    setPicked((cur) => new Set([...cur].filter((key) => !goneKeys.has(key))));
    const failed = [...done.pictures.failed, ...done.videos.failed];
    if (stopped) setError(stopped.message);
    else if (failed.length) {
      const why = failed[0].error;
      setError(
        !done.videos.failed.length
          ? tp(failed.length, "One picture could not be deleted: {why}", "{n} pictures could not be deleted: {why}", { why })
          : !done.pictures.failed.length
            ? tp(failed.length, "One video could not be deleted: {why}", "{n} videos could not be deleted: {why}", { why })
            : t("{n} files could not be deleted: {why}", { n: failed.length, why }),
      );
    } else setError(null);
  };

  /** Downloads, one file each: the browser may ask once whether this page may download several. */
  const download = (keys: string[]) => {
    const asked = splitSelection(keys);
    const files = [...asked.pictures.map((id) => ({ href: api.galleryFileUrl(id), name: pictureById.get(id)?.fileName ?? "" })), ...asked.videos.map((id) => ({ href: api.videoFileUrl(id), name: videoById.get(id)?.fileName ?? "" }))];
    files.forEach((file, i) =>
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = file.href;
        link.download = file.name;
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
    setChosenMake("picture");
    setChosen("edit");
    stopSelecting();
    // Where editing is not set up there is nothing to put it in: the form says so, and where to switch it on.
    if (changes) setSources([picture]);
    toForm();
  };
  /** What is selected, taken into an edit in the order it was ticked: the form opens in Edit with those pictures. */
  const pickedPictures = splitSelection(picked).pictures;
  const pickedVideos = splitSelection(picked).videos;
  const editPicked = () => {
    const wantedPictures = pickedPictures.map((id) => pictureById.get(id)).filter((p): p is GalleryPicture => !!p);
    if (!wantedPictures.length) return;
    setChosenMake("picture");
    setChosen("edit");
    stopSelecting();
    // Where editing is not set up there is nothing to put them in: the form says so, and where to switch it on.
    if (changes) setSources(addSources([], wantedPictures, multiple).list);
    toForm();
  };
  /** Why what is selected cannot all go into an edit, or nothing when it can. */
  const editRefusal = !changes
    ? undefined
    : pickedVideos.length
      ? t("Only pictures can be edited: leave the videos out")
      : !multiple && pickedPictures.length > 1
        ? t("The editing endpoint takes one picture per edit: select one")
        : pickedPictures.length > MAX_SOURCES
          ? t("An edit takes at most {n} pictures", { n: MAX_SOURCES })
          : undefined;
  /** A tick in a box while editing, or choosing references: the picture is taken in, after the ones there, or out again; where the endpoint takes one, it takes the place of the one there is. */
  const pick = useCallback(
    (id: string) => {
      const picture = pictureById.get(id);
      if (!picture) return;
      setChosenList((cur) => (cur.some((p) => p.id === id) ? cur.filter((p) => p.id !== id) : addSources(cur, [picture], multiple).list));
    },
    [pictureById, multiple, setChosenList],
  );

  /** Pictures of the gallery by their ids, for a picture of it dragged or pasted into the form: those the page has, and the others asked for. */
  const find = useCallback(
    async (ids: string[]) => {
      const missing = ids.filter((id) => !pictureById.has(id));
      const fetched = missing.length ? (await api.galleryPictures(missing)).pictures : [];
      return ids.map((id) => pictureById.get(id) ?? fetched.find((p) => p.id === id)).filter((p): p is GalleryPicture => !!p);
    },
    [pictureById],
  );

  /** A picture is to be the first frame of a video: the form for videos opens with it. */
  const videoFrom = (picture: GalleryPicture) => {
    setChosenMake("video");
    setFirstFrame(picture);
    toForm();
  };

  /** The same again: a picture made from a description is made once more, as it was asked for; a change is shown in the form first, since the mask it had is not kept. */
  const runAgainPicture = async (picture: GalleryPicture) => {
    setError(null);
    try {
      if (picture.kind === "generated") {
        // The settings it was made with, as they are recorded; the free fields an older version sent are not sent again.
        // What only stable-diffusion.cpp reads is sent only while the add-on says the endpoint is one: the picture keeps it, and it is not sent otherwise.
        const { extra: _older, sources: _sources, masked: _masked, negativePrompt, seed, sampleSteps, strength: _strength, fromNoise: _noise, references: refs, model, ...rest } = picture.params;
        // With references the model is always the editing endpoint's, and is not sent.
        const settings = refs?.length ? rest : { ...rest, ...(model ? { model } : {}) };
        // Made with references: with the same ones, all of them still in the gallery, or not again.
        const found = refs?.length ? (await api.galleryPictures(refs)).pictures : [];
        // Each by its id: the same picture may be a reference twice, and the gallery answers it once.
        if (refs?.some((id) => !found.some((p) => p.id === id))) throw new Error(t("The reference pictures this was made with are not all in the gallery any more."));
        const { jobs: made } = await api.makePictures({
          prompt: picture.prompt,
          ...settings,
          ...(images?.sdExtras ? { ...(negativePrompt ? { negativePrompt } : {}), ...(seed !== undefined ? { seed } : {}), ...(sampleSteps !== undefined ? { sampleSteps } : {}) } : {}),
          ...(refs?.length ? { references: refs } : {}),
        });
        pictures.started(made);
        setOpened(null);
        scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const wantedIds = picture.params.sources?.length ? picture.params.sources : picture.from ? [picture.from] : [];
      const found = wantedIds.length ? (await api.galleryPictures(wantedIds)).pictures : [];
      if (!found.length) throw new Error(t("The pictures this was changed from are not in the gallery any more."));
      setPrompt(picture.prompt);
      setSources(wantedIds.map((id) => found.find((p) => p.id === id)).filter((p): p is GalleryPicture => !!p));
      setChosenMake("picture");
      setChosen("edit");
      toForm();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** The same again for a video: one made from a description is made once more, as it was asked for; one made from pictures needs those pictures to be in the gallery still. */
  const runAgainVideo = async (video: GalleryVideo) => {
    setError(null);
    try {
      const { madeFrames: _frames, madeFps: _fps, firstFrame: first, lastFrame: last, ...settings } = video.params;
      if (video.kind === "animated") {
        const wanted = [...new Set([first?.picture, last?.picture].filter((id): id is string => !!id))];
        const found = wanted.length ? (await api.galleryPictures(wanted)).pictures : [];
        if (!wanted.length || found.length < wanted.length) throw new Error(t("The picture this was made from is not in the gallery any more."));
      }
      const { jobs: made } = await api.makeVideos({
        prompt: video.prompt,
        ...settings,
        ...(video.kind === "animated" && first?.picture ? { firstFrame: first.picture } : {}),
        ...(video.kind === "animated" && last?.picture ? { lastFrame: last.picture } : {}),
      });
      videos.started(made);
      setOpened(null);
      scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** The viewer is showing this picture: more of the gallery is asked for when it nears the end of what is loaded, and the original of a change that is further down is fetched, to be reached from it. */
  const pictureShown = useCallback(
    (picture: GalleryPicture) => {
      const loaded = pictures.listRef.current;
      const at = loaded.items.findIndex((p) => p.id === picture.id);
      if (loaded.next && at >= loaded.items.length - PICTURES_AHEAD) pictures.loadMore();
      const original = picture.from;
      if (original && !loaded.items.some((p) => p.id === original)) {
        api.galleryPictures([original]).then(
          (r) => r.pictures[0] && setOriginals((cur) => new Map(cur).set(original, r.pictures[0])),
          () => {},
        );
      }
    },
    [pictures.loadMore],
  );
  /** And this video: more of the gallery is asked for when it nears the end of what is loaded. */
  const videoShown = useCallback(
    (video: GalleryVideo) => {
      const loaded = videos.listRef.current;
      const at = loaded.items.findIndex((v) => v.id === video.id);
      if (loaded.next && at >= loaded.items.length - VIDEOS_AHEAD) videos.loadMore();
    },
    [videos.loadMore],
  );

  const makingNow = (picturesOn ? pictures.making : 0) + (videosOn ? videos.making : 0);
  const filtered = !!(wanted.origin || wanted.kind);
  const everyKey = joined.flatMap((m) => tileSelection(m) ?? []);
  const loading = !flags || (!!pictureFilter && picturesOn && pictures.loading) || (!!videoFilter && videosOn && videos.loading);
  const loadingMore = pictures.loadingMore || videos.loadingMore;
  const galleryError = (pictureFilter && pictures.galleryError) || (videoFilter && videos.galleryError) || null;
  const pictureBytes = pictureFilter ? pictures.list.pageBytes : 0;
  const videoBytes = videoFilter ? videos.list.pageBytes : 0;
  const bytes = pictureBytes + videoBytes;
  const storageLimit = clips?.storageLimitMb ? clips.storageLimitMb * 1024 * 1024 : 0;

  const lookFor = show === "images" ? t("Look for new pictures") : show === "videos" ? t("Look for new videos") : t("Look for new pictures and videos");
  const selectedName = show === "images" ? t("Selected pictures") : show === "videos" ? t("Selected videos") : t("Selected items");
  const galleryName = show === "images" ? t("Pictures") : show === "videos" ? t("Videos") : t("Media");
  const hint = referring
    ? multiple
      ? t("Tick pictures to use them as references, in the order you tick them. A click on a picture opens it.")
      : t("Tick a picture to use it as a reference. A click on a picture opens it.")
    : picking
    ? multiple
      ? t("Tick pictures to use them in the edit, in the order you tick them. A click on a picture opens it.")
      : t("Tick a picture to use it in the edit. A click on a picture opens it.")
    : show === "images"
      ? t("Tick pictures to download, delete or edit them. A click on a picture opens it.")
      : show === "videos"
        ? t("Tick videos to download or delete them. A click on a video plays it.")
        : t("Tick pictures and videos to download or delete them, or pictures to edit them. A click on one opens it.");
  const kinds = kindOptions(show);
  const kindValue = kinds.some((k) => k.id === wanted.kind) ? (wanted.kind ?? "") : "";

  return (
    <div ref={scroller} className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <ui.PageHeader
          icon={<LuImages />}
          title={t("Media")}
          description={t("Make and change pictures and videos with the endpoints you set up, without a chat, and keep what the agent made in chats.")}
          action={
            <button
              type="button"
              onClick={() => {
                pictures.refreshTop(true);
                videos.refreshTop(true);
                pictures.poll();
                videos.poll();
              }}
              className={btnCls}
              title={lookFor}
            >
              <LuRefreshCw aria-hidden className="h-4 w-4" />
              {t("Refresh")}
            </button>
          }
        >
          <div className="mt-3 flex flex-wrap gap-2">
            {pictureFilter && <ui.Stat value={pictures.list.total} label={tp(pictures.list.total, "picture", "pictures")} />}
            {videoFilter && <ui.Stat value={videos.list.total} label={tp(videos.list.total, "video", "videos")} />}
            {bytes > 0 && <ui.Stat value={bytesLabel(bytes)} label={show === "videos" && storageLimit ? t("kept from this page, of {limit}", { limit: bytesLabel(storageLimit) }) : t("kept from this page")} />}
            {makingNow > 0 && <ui.Stat value={makingNow} label={t("being made")} tone="text-accent" />}
          </div>
        </ui.PageHeader>

        {error && <ui.ErrorBanner onClose={() => setError(null)}>{error}</ui.ErrorBanner>}
        {galleryError && (
          <ui.ErrorBanner
            onClose={() => {
              pictures.clearGalleryError();
              videos.clearGalleryError();
            }}
          >
            {galleryError}
          </ui.ErrorBanner>
        )}
        {pictures.notes.length > 0 && (
          <ui.WarnBanner onClose={pictures.clearNotes}>
            {/* An edit's pictures are what is changed; a new picture's references (a job that makes one) are only what it is made with, and are said to be. */}
            {(
              [
                ["edit", t("A picture was changed to fit what an edit takes.")],
                ["generate", t("A reference picture was scaled down to fit what the editing endpoint takes.")],
              ] as const
            ).map(([kind, title]) => {
              const said = [...new Set(pictures.notes.filter((note) => note.job.kind === kind).map((note) => note.text))];
              return said.length ? (
                <div key={kind}>
                  <p>{title}</p>
                  {said.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              ) : null;
            })}
          </ui.WarnBanner>
        )}

        {/* Both forms are there while both kinds are made; the choice is a row of its own above, and the forms keep their words. */}
        {picturesOn && videosOn && <Segments showLabel label={t("Make")} value={making} options={MAKES} onChange={setChosenMake} />}
        {making === "picture" && images && (
          <ImageMaker
            features={images}
            running={pictures.making}
            limit={pictures.limit}
            prompt={prompt}
            onPrompt={setPrompt}
            promptRef={promptRef}
            mode={mode}
            onMode={setMode}
            sources={sources}
            onSources={setSources}
            references={references}
            onReferences={setReferences}
            referencesOpen={referencesOpen}
            onReferencesOpen={setReferencesOpen}
            onFind={find}
            onStarted={(made) => {
              pictures.started(made);
              reveal("pictures", made);
            }}
            onUploaded={() => pictures.refreshTop()}
          />
        )}
        {making === "video" && clips && (
          <VideoMaker
            features={clips}
            running={videos.making}
            limit={videos.limit}
            prompt={videoPrompt}
            onPrompt={setVideoPrompt}
            promptRef={videoPromptRef}
            firstFrame={firstFrame}
            onFirstFrame={setFirstFrame}
            lastFrame={lastFrame}
            onLastFrame={setLastFrame}
            onStarted={(made) => {
              videos.started(made);
              reveal("videos", made);
            }}
          />
        )}

        <section aria-label={t("Gallery")}>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {picturesOn && videosOn && (
              <Segments
                showLabel
                label={t("Show")}
                value={show}
                options={SHOWS}
                onChange={(next) => setFilter({ ...wanted, show: next, kind: kindOptions(next).some((k) => k.id === wanted.kind) ? wanted.kind : undefined })}
              />
            )}
            <Segments showLabel label={t("Where from")} value={wanted.origin ?? ""} options={ORIGINS} onChange={(origin) => setFilter({ ...wanted, origin: origin || undefined })} />
            <Segments showLabel label={t("How it was made")} value={kindValue} options={kinds} onChange={(kind) => setFilter({ ...wanted, kind: kind || undefined })} />
            {/* Said where the boxes are what an edit is made of, and where they are not: that is all the gallery needs to say of them until one is ticked. */}
            {!selecting && everyKey.length > 0 && <span className="ml-auto text-xs text-fg-muted">{hint}</span>}
          </div>

          {selecting && (
            <div role="group" aria-label={selectedName} className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-surface/95 px-3 py-2 shadow-pop backdrop-blur">
              <span className="mr-auto text-sm tabular-nums text-fg" role="status">
                {t("{n} selected", { n: picked.size })}
              </span>
              <button type="button" onClick={() => setPicked(new Set(everyKey))} className={ghostCls}>
                {t("Select all shown")}
              </button>
              {show !== "videos" && (
                <button type="button" onClick={editPicked} disabled={!!editRefusal} title={editRefusal} aria-describedby={editRefusal ? "selection-edit-why" : undefined} className={btnCls}>
                  <LuWandSparkles aria-hidden className="h-4 w-4" />
                  {t("Edit")}
                </button>
              )}
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
          ) : joined.length === 0 ? (
            <ui.Empty>
              {show === "images"
                ? filtered
                  ? t("No pictures match these filters.")
                  : picking && !referring
                    ? t("No pictures yet. Put one in from this computer above to change it.")
                    : t("No pictures yet. Describe one above to make the first.")
                : show === "videos"
                  ? filtered
                    ? t("No videos match these filters.")
                    : t("No videos yet. Describe one above to make the first.")
                  : filtered
                    ? t("Nothing matches these filters.")
                    : t("Nothing here yet. Describe a picture or a video above to make the first.")}
            </ui.Empty>
          ) : (
            <ul className={`gallery-grid${picking || selecting ? " is-choosing" : ""}`} aria-label={galleryName}>
              {joined.map((m) => {
                if (m.kind === "video") {
                  const id = m.tile.video?.id ?? m.tile.job?.videoId ?? "";
                  return (
                    <li key={m.key}>
                      <VideoTile tile={m.tile} selected={picked.has(selectionKey("video", id))} selectable={!picking} onOpen={openVideo} onToggle={toggleVideo} onDismiss={videos.dismiss} />
                    </li>
                  );
                }
                const id = m.tile.picture?.id ?? m.tile.job?.pictureId ?? "";
                const place = chosenList.findIndex((p) => p.id === id) + 1;
                return (
                  <li key={m.key}>
                    <PictureTile
                      tile={m.tile}
                      mode={referring ? "reference" : picking ? "pick" : "select"}
                      selected={picking ? place > 0 : picked.has(selectionKey("picture", id))}
                      place={multiple ? place : 0}
                      // At eight there is no ninth: the tiles that are not in the edit, or the references, say so, and wait until one is taken out. Only while the boxes are theirs: the pictures are kept for the way back, and Generate's boxes are otherwise for a download, a delete and a change.
                      full={picking && multiple && chosenList.length >= MAX_SOURCES && place === 0}
                      onOpen={openPicture}
                      onToggle={picking ? pick : togglePicture}
                      onDismiss={pictures.dismiss}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {more && (
            <div ref={sentinel} className="mt-4 flex justify-center">
              <button type="button" onClick={loadMore} disabled={loadingMore} className={btnCls}>
                {loadingMore ? t("Loading…") : t("Show more")}
              </button>
            </div>
          )}
        </section>
      </div>

      {opened?.kind === "picture" && (
        <ui.ImageViewer
          pictures={viewerPictures}
          startId={opened.id}
          onClose={() => setOpened(null)}
          // Where it was opened from: its picture in the gallery.
          anchor={(id) => document.querySelector<HTMLElement>(`[data-picture-id="${CSS.escape(id)}"]`)}
          actions={(vp) => {
            const picture = pictureById.get(vp.id);
            if (!picture) return null;
            return (
              <PictureViewerActions
                key={picture.id}
                picture={picture}
                makes={makes}
                canEdit={changes}
                onVideo={videosOn ? videoFrom : undefined}
                onShown={pictureShown}
                onEdit={editIt}
                // While the form is in Edit, or has its references open, the pictures are taken into it from here as well, one after another, with the viewer open.
                use={picking ? { on: chosenList.some((p) => p.id === picture.id), full: multiple && chosenList.length >= MAX_SOURCES, toggle: () => pick(picture.id), as: referring ? "reference" : "edit" } : undefined}
                onAgain={runAgainPicture}
                onDelete={(p) => void remove([selectionKey("picture", p.id)])}
              />
            );
          }}
        />
      )}
      {opened?.kind === "video" && (
        <VideoViewer
          videos={viewerVideos}
          startId={opened.id}
          onClose={() => setOpened(null)}
          // Where it was opened from: its video in the gallery.
          anchor={(id) => document.querySelector<HTMLElement>(`[data-picture-id="${CSS.escape(id)}"]`)}
          onCopy={async (id) => {
            await api.makeVideoCopy(id);
            // The list says it has one now.
            videos.refreshTop();
          }}
          actions={(vv) => {
            const video = videoById.get(vv.id);
            if (!video) return null;
            return <VideoViewerActions key={video.id} video={video} makes={!!clips?.ready} onShown={videoShown} onAgain={runAgainVideo} onDelete={(v) => void remove([selectionKey("video", v.id)])} />;
          }}
        />
      )}
    </div>
  );
}
