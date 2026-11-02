import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameList } from "./gallery-list";
import { pollWhileVisible } from "./helpers";

/**
 * One kind of media in the gallery of the Media page (MediaPage.tsx): a list the portal keeps, asked for a
 * page at a time, newest first, and the jobs that make more of it. The pictures and the videos are two feeds of the
 * same shape; what differs between them is the `FeedSource`.
 */

export interface FeedItem {
  id: string;
  createdAt: number;
}

export interface FeedJob {
  id: string;
  state: "running" | "done" | "failed";
  startedAt: number;
}

export interface FeedPage<Item> {
  items: Item[];
  /** Where the next page starts, or null at the end. */
  next: string | null;
  /** How many there are with the filters, and how much of the disk the page's own take. */
  total: number;
  pageBytes: number;
}

/** How a feed asks the portal for its items and jobs, and works out what is drawn of them. */
export interface FeedSource<Item extends FeedItem, Job extends FeedJob, Filter, Tile> {
  /** How many items a page of the gallery has: enough to fill a screen and some, and few enough to be quick. */
  pageSize: number;
  /** How often the jobs are asked about while one runs. */
  jobsEvery: number;
  page(query: Filter & { before?: string; limit: number; again?: boolean }): Promise<FeedPage<Item>>;
  byIds(ids: string[]): Promise<Item[]>;
  jobs(): Promise<{ jobs: Job[]; limit: number }>;
  stopJob(id: string): Promise<unknown>;
  /** The items there are, once the top of the list has been asked for again. */
  mergeTop(loaded: Item[], fresh: FeedPage<Item>): Item[];
  /** A page that was loaded further down joins the end of the list. */
  appendPage(loaded: Item[], page: Item[]): Item[];
  /** Every tile of the grid, newest first. */
  tiles(items: Item[], jobs: Job[], filter: Filter, gone: ReadonlySet<string>): Tile[];
  /** The ids of the items that jobs say they made and that the list does not have. */
  lost(jobs: Job[], have: ReadonlySet<string>, gone: ReadonlySet<string>, filter: Filter): string[];
  /** What a job that is done has to say besides, if it does. */
  notes?(job: Job): string[] | undefined;
  /** An item, once the items in `deleted` are gone: it does not name them any more. */
  unlink?(item: Item, deleted: ReadonlySet<string>): Item;
}

interface Listing<Item> {
  items: Item[];
  next: string | null;
  total: number;
  pageBytes: number;
}

const EMPTY = { items: [], next: null, total: 0, pageBytes: 0 };

/**
 * The feed of one kind. `available` is whether the portal makes this kind at all: its jobs are followed then, whatever
 * the gallery shows. `filter` is what the gallery asks for, or null where it is not to show this kind: nothing is
 * loaded then, and its jobs have no tiles.
 *
 * A filter asks again from the top, and an answer to what was asked before it is not wanted. The agent makes media in
 * chats while the page is open, and the list is seen again whenever the tab is; a job that is running is asked about
 * every second or two, and each holds its place in the grid as the item being made.
 */
export function useGalleryFeed<Item extends FeedItem, Job extends FeedJob, Filter, Tile>(source: FeedSource<Item, Job, Filter, Tile>, available: boolean, filter: Filter | null) {
  const filterKey = filter ? JSON.stringify(filter) : null;
  const latestFilter = useRef(filter);
  latestFilter.current = filter;
  const availableNow = useRef(available);
  availableNow.current = available;

  // The gallery, as far as it has been loaded.
  const [list, setList] = useState<Listing<Item>>(EMPTY as Listing<Item>);
  const listRef = useRef(list);
  listRef.current = list;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const asked = useRef(0);
  // The gallery's own error, apart: a page of it that loads ends a page that could not, and nothing else that went wrong.
  const [galleryError, setGalleryError] = useState<string | null>(null);
  // What the callbacks below read, kept where they can: the jobs, and what was deleted here.
  const jobsRef = useRef<Job[]>([]);
  // Deleted here: their jobs are not shown any more either, though the server may still have them.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const goneRef = useRef(gone);
  goneRef.current = gone;
  // What an edit that is done was made to fit (scaled down, compressed): it went ahead, so it is a warning and not an error. Each with the job it is of, which says what the pictures were for.
  const [notes, setNotes] = useState<{ job: Job; text: string }[]>([]);

  useEffect(() => {
    const mine = ++asked.current;
    // Not loaded: `loading` stays as it was, so that a feed that is switched on is not seen empty before its first page is asked for.
    if (!available || !filter) {
      setList(EMPTY as Listing<Item>);
      return;
    }
    setLoading(true);
    setList((cur) => ({ items: [], next: null, total: 0, pageBytes: cur.pageBytes }));
    source.page({ ...filter, limit: source.pageSize }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList({ items: page.items, next: page.next, total: page.total, pageBytes: page.pageBytes });
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
  }, [filterKey, available]);

  /**
   * The top of the list again, joined to what is loaded: an item was made, or taken away, or the agent made one in a chat.
   * The portal does not look through the folders for items nobody listed more than once a minute, unless `look` says so: the Refresh button.
   */
  const refreshTop = useCallback((look = false) => {
    const filterNow = latestFilter.current;
    if (!filterNow) return;
    const mine = asked.current;
    source.page({ ...filterNow, limit: source.pageSize, again: !look }).then(
      (page) => {
        if (asked.current !== mine) return;
        setList((cur) => {
          const items = source.mergeTop(cur.items, page);
          const next = items.length > page.items.length ? cur.next : page.next;
          // Nothing moved: nothing is drawn again.
          return sameList(items, cur.items) && next === cur.next && page.total === cur.total && page.pageBytes === cur.pageBytes ? cur : { items, total: page.total, next, pageBytes: page.pageBytes };
        });
        // An item that a job made, which this list does not have: asked for, and if the portal has not got it, it was deleted somewhere else (another tab, a phone) and its job does not stand in for it.
        const have = new Set(source.mergeTop(listRef.current.items, page).map((x) => x.id));
        const lost = source.lost(jobsRef.current, have, goneRef.current, filterNow);
        if (!lost.length) return;
        source.byIds(lost).then(
          (found) => {
            const there = new Set(found.map((x) => x.id));
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
    const filterNow = latestFilter.current;
    if (!next || !filterNow || loadingMoreRef.current) return;
    const mine = asked.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    source
      .page({ ...filterNow, before: next, limit: source.pageSize })
      .then(
        (page) => {
          if (asked.current !== mine) return;
          setList((cur) => ({ items: source.appendPage(cur.items, page.items), next: page.next, total: page.total, pageBytes: page.pageBytes }));
        },
        (e: Error) => asked.current === mine && setGalleryError(e.message),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    if (available && filter) return pollWhileVisible(refreshTop, 30_000);
  }, [refreshTop, available, filterKey]);

  // What is being made. Asked after every start, and every second or two while something is, which is all it takes to see an item arrive.
  const [jobs, setJobs] = useState<Job[]>([]);
  jobsRef.current = jobs;
  const [limit, setLimit] = useState(4);
  // What was done already when the page was opened: the items are in the gallery, and the jobs are not shown again.
  const ignored = useRef<Set<string> | null>(null);
  const running = useRef<Set<string>>(new Set());
  const poll = useCallback(() => {
    // Asked for by the page's Refresh whether this kind is made or not.
    if (!availableNow.current) return;
    source.jobs().then(
      (r) => {
        ignored.current ??= new Set(r.jobs.filter((j) => j.state === "done").map((j) => j.id));
        const shown = r.jobs.filter((j) => !ignored.current!.has(j.id));
        // An item that was being made and is done now is in the gallery, and the list asks for it.
        const finished = shown.filter((j) => j.state === "done" && running.current.has(j.id));
        if (finished.length) refreshTop();
        const said = finished.flatMap((job) => (source.notes?.(job) ?? []).map((text) => ({ job, text })));
        if (said.length) setNotes(said);
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
    if (!available) return;
    poll();
    if (!active) return;
    return pollWhileVisible(poll, source.jobsEvery);
  }, [available, active, poll]);

  const started = useCallback((made: Job[]) => {
    for (const job of made) running.current.add(job.id);
    setNotes([]);
    setJobs((cur) => [...made, ...cur.filter((j) => !made.some((m) => m.id === j.id))]);
  }, []);
  const dismiss = useCallback((id: string) => {
    running.current.delete(id);
    setJobs((cur) => cur.filter((j) => j.id !== id));
    source.stopJob(id).catch(() => {});
  }, []);

  /** Takes items out of the list after they were deleted: what was made of one does not name it any more, and `freed` is what the page's own took of the disk. */
  const forget = useCallback((deleted: ReadonlySet<string>, freed: number) => {
    setList((cur) => ({ ...cur, items: cur.items.filter((x) => !deleted.has(x.id)).map((x) => source.unlink?.(x, deleted) ?? x), total: Math.max(0, cur.total - deleted.size), pageBytes: Math.max(0, cur.pageBytes - freed) }));
    setGone((cur) => new Set([...cur, ...deleted]));
  }, []);

  const tiles = useMemo(() => (filter ? source.tiles(list.items, jobs, filter, gone) : []), [list.items, jobs, filterKey, gone]);

  return {
    list,
    listRef,
    loading,
    loadingMore,
    galleryError,
    clearGalleryError: () => setGalleryError(null),
    jobs,
    limit,
    /** How many are being made. */
    making: jobs.filter((j) => j.state === "running").length,
    notes,
    clearNotes: () => setNotes([]),
    tiles,
    refreshTop,
    loadMore,
    poll,
    started,
    dismiss,
    forget,
    gone,
  };
}
