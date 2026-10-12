import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * An extension's interface in the portal.
 *
 * A pi package may bring a browser half beside what pi loads from it: its
 * package.json says where, under a key of the portal's own, and pi reads
 * nothing of it.
 *
 *   "pi":         { "extensions": ["./index.ts"] }
 *   "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" }
 *
 * `client` is a JavaScript module the portal's page loads, which puts what it
 * draws into the portal's slots (see web/src/extensions). The folder it is in
 * is the package's web folder: the portal serves that folder, and nothing else
 * of the package, to whoever is signed in. `style`, in the same folder, is a
 * stylesheet loaded with it.
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
  if (typeof meta?.name !== "string" || !meta.name || typeof declared?.client !== "string") return undefined;
  const root = path.resolve(packageDir);
  const client = path.resolve(root, declared.client);
  const dir = path.dirname(client);
  if (dir === root || !fileIn(root, client)) return undefined;
  const stat = statSync(client);
  const style = typeof declared.style === "string" ? fileIn(dir, path.resolve(root, declared.style)) : undefined;
  return {
    name: meta.name,
    ...(typeof meta.version === "string" ? { version: meta.version } : {}),
    dir,
    entry: path.basename(client),
    ...(style ? { style } : {}),
    rev: `${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`,
  };
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
