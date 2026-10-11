/**
 * The chats gathered by the folder they work in: each agent's home, the
 * one where "New" starts a chat (the agent picked for new chats), and each project. A chat started in a project's subfolder belongs to
 * the project all the same, as it does on the Projects page. One that is in
 * neither — the workspace root itself, say — goes under "Elsewhere", which is
 * only there while it has any.
 *
 * Every agent's home and every project are there even without chats, so that
 * a chat can be started in any of them from the tree. An agent's home is named
 * after the agent.
 */

import { msg, t } from "./i18n";
import { within } from "./paths";
export type FolderKind = "home" | "project" | "elsewhere";

export type Folder<S> = {
  /** What the folder is remembered by: its order, and whether it is open. */
  key: string;
  kind: FolderKind;
  name: string;
  /** The agent whose home it is, for a home. */
  agent?: string;
  /** Whether it is the home of the agent "New" starts chats with, for a home; left out where the server did not say. */
  newChats?: boolean;
  /** The name of the agent a project works with: its chats carry that agent's soul and memory. Left out for a blank slate. */
  with?: string;
  /** Where a chat started in it works; null for Elsewhere, which is no one place. */
  path: string | null;
  /** Its chats, in the order they were given. */
  sessions: S[];
  /** When one of its chats last moved: "" for none. */
  lastActive: string;
};

/**
 * What a folder is called where it is shown: an agent's home and a project as
 * they are named, Home (from a server without agents) and Elsewhere in the
 * language shown.
 */
export const folderName = (f: { kind: string; name: string; agent?: string }) => (f.kind === "project" || f.agent ? f.name : t(f.name));

/** The first agent's home: what it was called before there were others, so that what is kept about it stays. */
export const HOME = "home";
export const ELSEWHERE = "elsewhere";
export const projectKey = (name: string) => `project:${name}`;
const agentKey = (id: string) => (id === "home" ? HOME : `agent:${id}`);

/** `newChats`: the agent that "New" starts chats with; a server that does not say leaves it out. */
export type PlaceAgent = { id: string; name: string; home: string; newChats?: boolean };

/** What the chats are gathered into: where Home is, the agents' homes, and the projects. */
export type Places = { home: string; agents?: readonly PlaceAgent[]; projects: readonly { name: string; path: string; agent?: string }[] };

/** The agents: the first one's home is Home, from a server that names none. */
const agentsOf = (places: Places): PlaceAgent[] =>
  places.agents?.length ? [...places.agents] : places.home ? [{ id: "home", name: "", home: places.home }] : [];

/** Whether there is more than one place to gather chats in: a project, or a second agent's home. */
export const hasMoreThanHome = (places: Places) => places.projects.length > 0 || agentsOf(places).length > 1;

/**
 * The projects that are folders of their own: not one that is an agent's
 * home, which a home made inside the workspace root would be listed as.
 */
const projectsOf = (places: Places) => {
  const homes = new Set([places.home, ...agentsOf(places).map((a) => a.home)]);
  return places.projects.filter((p) => !homes.has(p.path));
};

/** The keys of every folder there can be with these places: the agents' homes, the projects, and Elsewhere. */
export const folderKeys = (places: Places) => [
  ...new Set([HOME, ...agentsOf(places).map((a) => agentKey(a.id))]),
  ...projectsOf(places).map((p) => projectKey(p.name)),
  ELSEWHERE,
];

/**
 * The chats in their folders, each in the deepest that holds it — Home
 * among them, which can be inside the workspace root or hold it. Elsewhere
 * is left out while it has none, unless `elsewhere` asks for it anyway.
 */
export function groupByFolder<S extends { workspace: string; updated_at: string }>(
  sessions: readonly S[],
  places: Places,
  { elsewhere: always = false }: { elsewhere?: boolean } = {},
): Folder<S>[] {
  const homes = agentsOf(places).map<Folder<S>>((a) => ({
    key: agentKey(a.id),
    kind: "home",
    // Home where the server has not said what the agent is called.
    ...(a.name ? { name: a.name, agent: a.id } : { name: msg("Home") }),
    ...(a.newChats === undefined ? {} : { newChats: a.newChats }),
    path: a.home,
    sessions: [],
    lastActive: "",
  }));
  const elsewhere: Folder<S> = { key: ELSEWHERE, kind: "elsewhere", name: msg("Elsewhere"), path: null, sessions: [], lastActive: "" };
  const named = new Map(agentsOf(places).map((a) => [a.id, a.name]));
  const projects = projectsOf(places).map<Folder<S>>((p) => ({
    key: projectKey(p.name),
    kind: "project",
    name: p.name,
    // An agent the server did not give a name is not one to say.
    ...(p.agent && named.get(p.agent) ? { with: named.get(p.agent) } : {}),
    path: p.path,
    sessions: [],
    lastActive: "",
  }));
  // Deepest first. A server that did not say where Home is: nothing is taken for it.
  const deepest = [...homes.filter((h) => h.path), ...projects].sort((a, b) => b.path!.length - a.path!.length);
  for (const s of sessions) {
    const folder = deepest.find((f) => within(f.path!, s.workspace)) ?? elsewhere;
    folder.sessions.push(s);
    if (s.updated_at > folder.lastActive) folder.lastActive = s.updated_at;
  }
  // Home is there even before the server has said where it is.
  const first = homes.length ? homes : [{ key: HOME, kind: "home" as const, name: msg("Home"), path: places.home, sessions: [], lastActive: "" }];
  return [...first, ...projects, ...(always || elsewhere.sessions.length ? [elsewhere] : [])];
}

/**
 * The name of the folder a chat is listed in, as the folders show it, for the places
 * that name it per chat (the Sessions page's rows, the search) instead of its path.
 * "" until the places are known.
 */
export function folderNameOf<S extends { id: string; workspace: string; updated_at: string }>(
  sessions: readonly S[],
  places: Places | null | undefined,
): (s: S) => string {
  const names = new Map<string, string>();
  if (places) for (const f of groupByFolder(sessions, places)) for (const s of f.sessions) names.set(s.id, folderName(f));
  return (s) => names.get(s.id) ?? "";
}

/** How the folders are ordered: by their latest chat, by name, or as they were put. */
export type FolderSort = "recent" | "name" | "manual";

const FOLDER_SORTS: FolderSort[] = ["recent", "name", "manual"];

/**
 * The folders in `sort`'s order. By name, Home comes first, as the place
 * chats start, then the other agents' homes. As they were put (`order`, by key), a folder never put
 * anywhere — a project made since — comes after the rest, the latest first.
 * Elsewhere is last unless it was put somewhere.
 */
export function sortFolders<S>(folders: readonly Folder<S>[], sort: FolderSort, order: readonly string[] = []): Folder<S>[] {
  const rank = (f: Folder<S>) => (f.key === HOME ? 0 : f.kind === "home" ? 1 : f.kind === "project" ? 2 : 3);
  const byName = (a: Folder<S>, b: Folder<S>) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  const byRecent = (a: Folder<S>, b: Folder<S>) =>
    Number(a.kind === "elsewhere") - Number(b.kind === "elsewhere") || (b.lastActive > a.lastActive ? 1 : b.lastActive < a.lastActive ? -1 : 0) || byName(a, b);
  if (sort === "name") return [...folders].sort(byName);
  if (sort === "recent") return [...folders].sort(byRecent);
  const at = (f: Folder<S>) => {
    const i = order.indexOf(f.key);
    return i < 0 ? Infinity : i;
  };
  return [...folders].sort((a, b) => at(a) - at(b) || byRecent(a, b));
}

/**
 * The order kept once `key` is put at `to` among the folders as they are
 * shown (`shown`, by key): the order they were shown in, since that is what
 * was moved from, whatever they were sorted by. A folder in the order kept
 * before (`kept`) that is not shown now — Elsewhere, in the sidebar, while
 * all its chats are pinned — keeps its place among them.
 */
export function moveFolder(shown: readonly string[], key: string, to: number, kept: readonly string[] = []): string[] {
  const rest = shown.filter((k) => k !== key);
  const at = Math.max(0, Math.min(rest.length, to));
  const next = [...rest.slice(0, at), key, ...rest.slice(at)];
  // The places of those shown are taken by them in their new order; the others stay where they were.
  const queue = [...next];
  const out = kept.map((k) => (next.includes(k) ? queue.shift()! : k));
  return [...out, ...queue];
}

/** An order read back from storage: the keys in it, once each. */
export function readFolderOrder(raw: string | null | undefined): string[] {
  try {
    const stored = JSON.parse(raw ?? "") as unknown;
    return Array.isArray(stored) ? [...new Set(stored.filter((k): k is string => typeof k === "string"))] : [];
  } catch {
    return [];
  }
}

export const readFolderSort = (raw: string | null | undefined): FolderSort =>
  FOLDER_SORTS.includes(raw as FolderSort) ? (raw as FolderSort) : "recent";

/** Which folders were opened or shut by hand, by key: the rest are as the place shows them first. */
export function readOpenFolders(raw: string | null | undefined): Record<string, boolean> {
  try {
    const stored = JSON.parse(raw ?? "") as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, open]) => typeof open === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** The folder a link names (`?folder=` and its key), when it is one of `folders`. */
export const folderFrom = <S>(folders: readonly Folder<S>[], key: string | null) => (key ? (folders.find((f) => f.key === key) ?? null) : null);
