import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * An extension's interface in the portal.
 *
 * A pi package may bring a browser half beside what pi loads from it: its
 * package.json says where, under a key of the portal's own, and pi reads
 * nothing of it.
 *
 *   "pi":         { "extensions": ["./index.ts"] }
 *   "pithagoras": { "client": "./web/client.js", "style": "./web/client.css", "server": "./server.js",
 *                   "themes": [{ "id": "dusk", "name": "Dusk", "dark": { "canvas": "#1b1626" } }] }
 *
 * `client` is a JavaScript module the portal's page loads, which puts what it
 * draws into the portal's slots (see web/src/extensions). The folder it is in
 * is the package's web folder: the portal serves that folder, and nothing else
 * of the package, to whoever is signed in. `style`, in the same folder, is a
 * stylesheet loaded with it.
 *
 * `server` is a JavaScript module the portal itself loads, once, for all
 * chats: the package's own routes, what it keeps, and what outlives a chat's
 * pi (see extension-host.ts).
 *
 * `themes` are colours in place of the portal's own, each by the portal's name
 * for it: no code, so a package may be nothing but themes. The page checks
 * them and offers them where themes are chosen (web/src/extensions/themes.ts).
 *
 * What the browser half draws in a chat talks to the package's own pi
 * extension there over pi's event bus (`pi.events` inside an extension), so
 * the extension needs no dependency on the portal and does nothing different
 * when it is not there.
 *
 * Extension → the pages open on its chat:
 *
 *   pithagoras:v1:ui:send     { extension, data }
 *
 * A page → the extension in that chat:
 *
 *   pithagoras:v1:ui:receive  { extension, data }
 *
 * `extension` is the package's name, as its package.json has it; each side
 * takes only what carries its own. `data` is the package's to define: anything
 * that is JSON. Nothing is stored: a page that opens later asks its extension
 * for where things stand.
 */
export const UI_SEND = "pithagoras:v1:ui:send";
export const UI_RECEIVE = "pithagoras:v1:ui:receive";

export interface ClientHalf {
  /** The package's name: what its slots' entries, and its messages, go by. */
  name: string;
  version?: string;
  /** The package's web folder, which is all of it the portal serves. */
  dir: string;
  /** The module, and the stylesheet if it has one, as paths inside `dir`. */
  entry: string;
  style?: string;
  /** Changes when the module's file does, so a page loads it again rather than the one it has. */
  rev: string;
}

/** The server half a package declares: a module the portal loads into its own process. See extension-host.ts. */
export interface ServerHalf {
  name: string;
  version?: string;
  /** The module's file. */
  file: string;
  /** Changes when the file does, so the portal loads it again rather than the one it has. */
  rev: string;
}

/**
 * A name a package's files, addresses and data folder can go by: an npm name,
 * with or without a scope. Anything else (a `..`, a slash of its own) and the
 * package has no halves here.
 */
export const validName = (name: unknown): name is string =>
  typeof name === "string" && /^(@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(name);

const revOf = (file: string) => {
  const stat = statSync(file);
  return `${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
};

/** A file's path inside `dir`, or nothing when it is outside it or not a file. */
function fileIn(dir: string, file: string): string | undefined {
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  try {
    return statSync(file).isFile() ? rel.split(path.sep).join("/") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The browser half the package in `packageDir` declares, or nothing: it
 * declares none, or what it names is not a file inside it.
 *
 * The module is in a folder of its own, below the package's: a module at the
 * package's root would have the portal serve all of the package, with what its
 * server half keeps beside it.
 */
export function clientHalf(packageDir: string): ClientHalf | undefined {
  let meta: any;
  try {
    meta = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const declared = meta?.pithagoras;
  if (!validName(meta?.name) || typeof declared?.client !== "string") return undefined;
  const root = path.resolve(packageDir);
  const client = path.resolve(root, declared.client);
  const dir = path.dirname(client);
  if (dir === root || !fileIn(root, client)) return undefined;
  const style = typeof declared.style === "string" ? fileIn(dir, path.resolve(root, declared.style)) : undefined;
  return {
    name: meta.name,
    ...(typeof meta.version === "string" ? { version: meta.version } : {}),
    dir,
    entry: path.basename(client),
    ...(style ? { style } : {}),
    rev: revOf(client),
  };
}

/** A theme a package names: who it is, and its colours as written, for the page to check. */
export interface NamedTheme {
  id: string;
  name: string;
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

export interface PackageThemes {
  name: string;
  version?: string;
  themes: NamedTheme[];
}

const colourMap = (given: unknown): Record<string, string> | undefined =>
  given && typeof given === "object" && !Array.isArray(given) && Object.values(given).every((v) => typeof v === "string") ? (given as Record<string, string>) : undefined;

/** The themes the package in `packageDir` names, or nothing: it names none, or goes by no name of its own. */
export function packageThemes(packageDir: string): PackageThemes | undefined {
  let meta: any;
  try {
    meta = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const named = meta?.pithagoras?.themes;
  if (!validName(meta?.name) || !Array.isArray(named)) return undefined;
  const themes = named
    .filter((theme) => typeof theme?.id === "string" && typeof theme.name === "string")
    .map((theme): NamedTheme => ({ id: theme.id, name: theme.name, ...(colourMap(theme.light) ? { light: theme.light } : {}), ...(colourMap(theme.dark) ? { dark: theme.dark } : {}) }));
  return themes.length ? { name: meta.name, ...(typeof meta.version === "string" ? { version: meta.version } : {}), themes } : undefined;
}

/** The server half the package in `packageDir` declares, or nothing: it declares none, or what it names is not a file inside it. */
export function serverHalf(packageDir: string): ServerHalf | undefined {
  let meta: any;
  try {
    meta = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!validName(meta?.name) || typeof meta?.pithagoras?.server !== "string") return undefined;
  const root = path.resolve(packageDir);
  const file = path.resolve(root, meta.pithagoras.server);
  if (!fileIn(root, file)) return undefined;
  return { name: meta.name, ...(typeof meta.version === "string" ? { version: meta.version } : {}), file, rev: revOf(file) };
}

/** What a package brings: something for pi (the agent), something drawn or run by the portal, colours for the portal. */
export type PackageKind = "pi" | "pithagoras" | "themes";

const PI_RESOURCES = ["extensions", "skills", "prompts", "themes"];

/**
 * Whether the package in `packageDir` brings pi anything, as pi itself reads
 * it: what its `pi` key names, or without one the folders pi looks in.
 */
function bringsPi(packageDir: string): boolean {
  let declared: any;
  try {
    declared = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"))?.pi;
  } catch {
    // No package.json to say: the folders do.
  }
  if (declared && typeof declared === "object" && !Array.isArray(declared)) return PI_RESOURCES.some((type) => Array.isArray(declared[type]) && declared[type].length > 0);
  return PI_RESOURCES.some((type) => existsSync(path.join(packageDir, type)));
}

/** The kinds of thing the package in `packageDir` brings, for a list of packages to be told apart by. */
export function packageKinds(packageDir: string): PackageKind[] {
  const kinds: PackageKind[] = [];
  if (bringsPi(packageDir)) kinds.push("pi");
  if (clientHalf(packageDir) || serverHalf(packageDir)) kinds.push("pithagoras");
  if (packageThemes(packageDir)) kinds.push("themes");
  return kinds;
}

type Bus = { on(channel: string, handler: (data: unknown) => void): () => void };
type Emit = (event: Record<string, unknown>) => void;

/**
 * Listens on a chat's bus and hands the portal what an extension says to its
 * browser half, as a session event: `portal_extension_ui`, streamed to the
 * pages open on the chat and not stored. Returns the unsubscribe.
 */
export function bridgeExtensionUi(bus: Bus, emit: Emit): () => void {
  return bus.on(UI_SEND, (message: any) => {
    if (typeof message?.extension !== "string" || !message.extension) return;
    emit({ type: "portal_extension_ui", extension: message.extension, data: message.data ?? null });
  });
}
