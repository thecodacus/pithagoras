import { portal } from "../portal";
import type { ChatMessage } from "./memory-chat";

/**
 * What the browser half asks of Understory's server half: its own routes, under
 * the address the portal gives the package (`portal.api.url`). A request made
 * while the server half is not running is refused as one the server refused
 * is, so that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);
const query = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

/** The model that keeps Understory's memory, as the page is told it: never the key. */
export type UnderstoryLlm =
  | { source: "auto" }
  | { source: "provider"; provider: string; model: string }
  | { source: "custom"; baseUrl: string; model: string; format: "openai" | "anthropic"; hasKey?: boolean };

/** What the page sends for it: a custom key only when it is being changed. */
export type UnderstoryLlmChoice =
  | { source: "auto" }
  | { source: "provider"; provider: string; model: string }
  | { source: "custom"; baseUrl: string; model: string; format: "openai" | "anthropic"; apiKey?: string };

/** The Understory the portal runs itself, in a container of its own. */
export interface ManagedUnderstory {
  /** The portal can reach Docker. */
  available: boolean;
  image: boolean;
  /** "foreign": a container by that name the portal did not make, which it leaves alone. */
  container: "absent" | "stopped" | "running" | "foreign";
  pulling: { active: boolean; line: string; error?: string };
  url: string;
  /** `dreamAt`: once a day at this time ("03:00"), started by the portal; wins over the interval. */
  config: { llm: UnderstoryLlm; dreamInterval: string; dreamAt: string };
  /** "The chat's model" can be offered: the server half listens for Understory on its port. */
  autoPossible: boolean;
  /** Providers set up here that Understory can be pointed at. */
  providers: { id: string; models: string[] }[];
  /** A pass the portal started is running now. */
  dreaming: boolean;
  lastDream: { at: string; ok: boolean; ran?: boolean; said: string } | null;
  nextDream: string | null;
  /** The portal's time zone, which a set time is in. */
  timeZone: string;
}

/** Understory as the agent's memory, over MCP: `GET /state`. */
export interface UnderstoryState {
  enabled: boolean;
  url: string;
  /** A token is set for it and sent. */
  tokenSet: boolean;
  /** Something answers at the address. */
  reachable: boolean;
  managed: ManagedUnderstory;
}

/** What a change answers: the state after it, and where it wrote the MCP entry, the chats that have it now and those that wait. */
type Changed = { understory: UnderstoryState; reloaded?: number; waiting?: number };

/** A folder or a note in Understory's memory bundle. `reserved` are its own index and log. */
export interface MemoryNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: MemoryNode[];
}

export interface MemoryConcept {
  path: string;
  frontmatter: { type?: string; title?: string; description?: string; tags?: string[]; timestamp?: string; [key: string]: unknown };
  body: string;
}

export interface MemoryHit {
  path: string;
  type?: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface MemoryChange {
  date: string;
  action: string;
  summary: string;
}

export interface MemoryGraph {
  nodes: { path: string; title?: string; type?: string; description?: string; links: number }[];
  edges: { source: string; target: string }[];
}

/** A run of Understory's own agent over the memory: a question, a change it was asked for, or a chat. */
export interface MemoryTrace {
  id: string;
  kind: string;
  input: string;
  startedAt: string;
  durationMs?: number;
  notation?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** One tool the agent used in a run: what it was (`search_knowledge`, `read_concept`, `write_concept`, …), and the full paths of the notes it found, read or wrote. */
export interface MemoryTraceStep {
  seq: number;
  tool: string;
  summary: string;
  paths: string[];
  /** A step that changed the memory. */
  write?: boolean;
}

/** A run with its steps, which the list of runs leaves out. */
export interface MemoryTraceRun extends MemoryTrace {
  steps: MemoryTraceStep[];
  outcome?: string;
}

/** What a change may have left behind in the memory: links to nowhere, notes nothing links to, what the format says. */
export interface MemoryHealth {
  healthy: boolean;
  orphans: { path: string; title?: string }[];
  brokenLinks: { path: string; target: string }[];
  issues: { path: string; severity: string; message: string }[];
}

export interface MemoryValidation {
  conformant: boolean;
  conceptCount?: number;
  directoryCount?: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export const api = {
  state: () => call<UnderstoryState>("/state"),
  setUse: (patch: { enabled: boolean; url?: string }) => call<Changed>("/use", { method: "PUT", body: JSON.stringify(patch) }),
  setConfig: (config: { llm: UnderstoryLlmChoice; dreamInterval: string; dreamAt: string }) => call<Changed>("/config", { method: "PUT", body: JSON.stringify(config) }),
  dream: () => call<Changed>("/dream", { method: "POST" }),
  install: () => call<Changed>("/install", { method: "POST" }),
  /** The container goes; with `forgetMemory`, its volume too, with every note in it. */
  remove: (forgetMemory = false) => call<Changed>(`/install${forgetMemory ? query({ memory: "forget" }) : ""}`, { method: "DELETE" }),
  start: () => call<Changed>("/start", { method: "POST" }),
  stop: () => call<Changed>("/stop", { method: "POST" }),

  memoryTree: () => call<MemoryNode>("/tree"),
  memoryConcept: (path: string) => call<MemoryConcept>(`/concept${query({ path })}`),
  memorySearch: (q: string) => call<MemoryHit[]>(`/search${query({ q })}`),
  memoryLog: () => call<MemoryChange[]>("/log"),
  memoryGraph: () => call<MemoryGraph>("/graph"),
  memoryTraces: () => call<MemoryTrace[]>("/traces"),
  /** One run with its steps, and the full paths of the notes each touched. */
  memoryTrace: (id: string) => call<MemoryTraceRun>(`/trace${query({ id })}`),
  memoryValidate: () => call<MemoryValidation>("/validate"),
  /** Whether notes can be changed here: only in the Understory the portal runs. */
  memoryHealth: () => call<{ writable: boolean; health?: MemoryHealth }>("/health"),
  saveMemoryNote: (path: string, frontmatter: Record<string, unknown>, body: string) =>
    call<{ concept: MemoryConcept; health: MemoryHealth }>("/concept", { method: "PUT", body: JSON.stringify({ path, frontmatter, body }) }),
  deleteMemoryNote: (path: string) => call<{ health: MemoryHealth }>(`/concept${query({ path })}`, { method: "DELETE" }),
  reindexMemory: () => call<{ pruned: string[]; reindexed: number; health: MemoryHealth }>("/reindex", { method: "POST" }),
  /** The model mends links to nothing and wires in orphans; `ran` is false when there were none. */
  repairMemory: () => call<{ ran: boolean; reason?: string; summary?: string; filesChanged?: string[]; health: MemoryHealth }>("/repair", { method: "POST" }),
  clearMemoryLog: () => call<{ health: MemoryHealth }>("/clear-log", { method: "POST" }),
  /** Every note gone, the index and log empty: the memory from nothing. */
  wipeMemory: () => call<{ health: MemoryHealth }>("/wipe", { method: "POST" }),
  /** The librarian's answer to a conversation, as the stream it comes in: the caller reads the body. */
  askLibrarian: async (messages: ChatMessage[], signal: AbortSignal): Promise<Response> => {
    const res = await fetch(portal.api.url("/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }), signal });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new portal.api.ApiError(body.error || `HTTP ${res.status}`, res.status, body);
    }
    return res;
  },
};
