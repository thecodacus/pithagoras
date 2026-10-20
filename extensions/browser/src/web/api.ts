import { portal } from "../portal";

/**
 * What the browser half asks of Browser's server half: its own routes, under
 * the address the portal gives the package (`portal.api.url`). A request made
 * while the server half is not running is refused as one the server refused
 * is, so that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** The agent's browser, and who may drive it. */
export interface BrowserState {
  running: boolean;
  /** Running with no password on its web UI. */
  unprotected: boolean;
  /** Whether the agent has the browser tools. */
  connected: boolean;
  /** How and whether a browser can run here at all. */
  install: {
    available: boolean;
    /** "external": a browser the deployment runs itself, which the portal only looks at. */
    mode: "docker" | "local" | "external";
    image: boolean;
    container: "absent" | "stopped" | "running" | "unavailable";
    binary?: string | null;
    headless?: boolean;
    pulling: { active: boolean; line: string; error?: string };
  };
  config: { user: string; hasPassword: boolean };
  version: string | null;
  pages: { title: string; url: string }[];
  uiPort: string;
  /** Does that port answer other machines? The page links to it only then. */
  uiExposed: boolean;
  /** A container made before the port was kept to one address: it answers every machine until it is installed again. */
  uiOutdated: boolean;
  /** Whether the browser tools glide a cursor to what they act on. */
  cursor: boolean;
  /** Does a conversation that has never said anything about it get the browser? */
  byDefault: boolean;
  /** Only the chats that disagree with that: see "Who may drive it". */
  chats: { id: string; title: string; kind: string; allowed: boolean }[];
  /** The routines whose own switches give their runs another answer, with that answer. */
  routines: { slug: string; name: string; allowed: boolean }[];
}

export const api = {
  state: () => call<BrowserState>("/state"),
  install: () => call<{ ok: true }>("/install", { method: "POST" }),
  remove: () => call<{ ok: true }>("/install", { method: "DELETE" }),
  start: () => call<{ ok: true }>("/start", { method: "POST" }),
  stop: () => call<{ ok: true }>("/stop", { method: "POST" }),
  setConfig: (patch: { password?: string }) => call<{ user: string; hasPassword: boolean }>("/config", { method: "PUT", body: JSON.stringify(patch) }),
  suggestPassword: () => call<{ password: string }>("/suggest-password"),
  connect: () => call<{ connected: boolean }>("/connect", { method: "POST" }),
  disconnect: () => call<{ connected: boolean }>("/connect", { method: "DELETE" }),
  setCursor: (on: boolean) => call<{ cursor: boolean }>("/cursor", { method: "PUT", body: JSON.stringify({ on }) }),
  /** Where the browser's own web UI is, through the server half: asked only once it has answered, as it throws while it is not running. */
  uiUrl: () => portal.api.url("/ui/"),
};
