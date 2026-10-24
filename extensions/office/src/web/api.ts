import { portal } from "../portal";

/**
 * What the browser half asks of its server half: the routes under the address the portal gives the package
 * (portal.api.url, core-mounted at /api/x/pithagoras-office, session-gated there). A request made while the
 * server half is not running is refused as one the server refused is.
 */

/** One document of the library, as GET /state says it (store.DocMeta verbatim). */
export interface OfficeDoc {
  docId: string;
  title: string;
  ext: "docx" | "xlsx";
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  /** The document's current revision: its file's mtimeMs, what office_edit passes back as baseRevision. */
  mtimeMs: number;
  /** The home chat that created it, or null for one made from the global page. */
  owner: string | null;
  /** Mentions in its comments that opened it to those homes. */
  grants: { chatId: string; commentId: string; at: number }[];
  createdBy?: string;
}

/** A pull in progress, out of the server half's memory (container.PullState). */
export interface OfficePull {
  active: boolean;
  line: string;
  error?: string;
}

/** The Document Server container, as status() reports it. */
export interface OfficeContainer {
  state: string;
  version?: string;
  memBytes?: number;
  pull?: OfficePull | null;
}

/** GET /state -- the payload of the 5 s poll (plan 5.7 tier 1): settings, container, every doc, who is in what. */
export interface OfficeState {
  enabled: boolean;
  imageTag: string;
  container: OfficeContainer;
  docs: OfficeDoc[];
  /** Every doc has an entry: empty while nobody is editing it, so the badge code needs no null check. */
  locks: Record<string, { id: string; name?: string }[]>;
}

/** POST /editor-config: the plain DocsAPI.DocEditor config plus its JWT and where api.js lives -- apiJs is dropped again before the call. */
export interface EditorConfig extends Record<string, unknown> {
  token: string;
  apiJs: string;
}

export type SettingsPatch = { enabled?: boolean; imageTag?: string };

/** The settings answer: what was saved, where the container stands as of now, and that a start went on its own. */
export interface SettingsAnswer {
  settings: { enabled: boolean; imageTag: string };
  container: OfficeContainer;
  starting?: boolean;
}

/** A JSON route of the server half, at its address. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

export const api = {
  state: () => call<OfficeState>("/state"),
  createDocument: (body: { title: string; type: "word" | "cell"; owner?: string }) =>
    call<OfficeDoc>("/documents", { method: "POST", body: JSON.stringify(body) }),
  renameDocument: (id: string, title: string) =>
    call<OfficeDoc>(`/documents/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  deleteDocument: (id: string) => call<{ ok: true }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Re-run the workspace scan now (boot does it automatically): { added, updated }. */
  rescanLibrary: () => call<{ added: number; updated: number }>("/documents/rescan", { method: "POST" }),
  editorConfig: (docId: string) => call<EditorConfig>("/editor-config", { method: "POST", body: JSON.stringify({ doc: docId }) }),
  saveSettings: (patch: SettingsPatch) => call<SettingsAnswer>("/settings", { method: "POST", body: JSON.stringify(patch) }),
  /** Awaits the whole first pull to completion -- the page shows its progress from /state meanwhile. */
  startContainer: () => call<{ started: boolean; container: OfficeContainer }>("/container/start", { method: "POST" }),
  stopContainer: () => call<{ container: OfficeContainer }>("/container/stop", { method: "POST" }),
  /** The library bytes as an attachment -- plain addresses, the session rides along on the cookie. */
  downloadUrl: (id: string) => portal.api.url(`/documents/${encodeURIComponent(id)}`),
  exportUrl: (id: string) => portal.api.url(`/documents/${encodeURIComponent(id)}/export`),
};

/** A refusal of the server half, in words for where it says the rest. The ApiError of core's json() carries
 * exactly that message (the { error } field), so a failure of POST /documents -- including the retryable 503
 * "dependencies_pending" while jszip is still installing -- reaches an ErrorBanner verbatim, never a dead click. */
export function sayError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
