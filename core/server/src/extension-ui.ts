import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import semver from "semver";

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
  /** Changes when a file of `dir` does (see revOf), so a page loads it again rather than the one it has. */
  rev: string;
}

/** The server half a package declares: a module the portal loads into its own process. See extension-host.ts. */
export interface ServerHalf {
  name: string;
  version?: string;
  /** The module's file. */
  file: string;
  /**
   * Changes when a file of the module's folder does (see revOf), so the portal loads it again rather than the one it has, with
   * every file of that folder it imports (see half-modules.ts).
   */
  rev: string;
  /** The extensions it builds on and cannot start without, by name, with the versions it takes (`pithagoras.requires`). */
  requires?: Record<string, string>;
  /** Those it uses when they are there, and starts without (`pithagoras.optional`). */
  optional?: Record<string, string>;
  /**
   * It runs in a process of its own (`pithagoras.isolated`, or installed from an extension's data folder): see
   * isolated-half.ts.
   */
  isolated?: true;
}

/** What a package says it builds on: extensions by name, each with a version range. What is not that is not read. */
function buildsOn(given: unknown): Record<string, string> | undefined {
  if (!given || typeof given !== "object" || Array.isArray(given)) return undefined;
  const entries = Object.entries(given).filter(([name, range]) => validName(name) && typeof range === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** What a package's package.json (`meta`) says it cannot work without (`pithagoras.requires`): extensions by name, each with the versions it takes. */
export const requiresOf = (meta: any): Record<string, string> | undefined => buildsOn(meta?.pithagoras?.requires);

/** Whether `version` of an extension is one that `range` takes; a range that is none takes nothing. */
export const takes = (range: string, version: string | undefined) => Boolean(version && semver.validRange(range) && semver.satisfies(version, range, { includePrerelease: true }));

/**
 * A name a package's files, addresses and data folder can go by: an npm name,
 * with or without a scope. Anything else (a `..`, a slash of its own) and the
 * package has no halves here.
 */
export const validName = (name: unknown): name is string =>
  typeof name === "string" && /^(@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(name);

/** How many files of a half's folder its revision looks at: see revOf. */
const REV_FILES = 1000;

/**
 * A half's revision: of the files it is made of, which are `files` and those of the folder `dir`, its folders' as well,
 * by when each last changed, its size and where it is. A change to any of them, a file more or a file less, is another
 * revision. Not what is in `node_modules`, which a half imports by name and which is not loaded again (see
 * half-modules.ts), nor a file or folder whose name starts with a dot. Of the folder, the first REV_FILES files met are
 * looked at, each folder's entries taken by name and a folder's own files before the entries after it: a change to a file
 * past them alone is not another revision. `files` always count.
 */
function revOf(dir: string, ...files: string[]): string {
  const hash = createHash("sha256");
  const add = (file: string, at: string): boolean => {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    hash.update(`${at}\0${stat.mtimeMs}\0${stat.size}\n`);
    return true;
  };
  for (const file of files) {
    try {
      add(file, file);
    } catch {
      // Gone since the half was found: another revision, and the next look finds the half without it.
      hash.update(`${file}\0gone\n`);
    }
  }
  let left = REV_FILES;
  const walk = (folder: string, at: string) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!left) return;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, `${at}${entry.name}/`);
      else {
        try {
          if (add(full, `${at}${entry.name}`)) left--;
        } catch {
          // Gone meanwhile, or a link that leads nowhere.
        }
      }
    }
  };
  walk(dir, "");
  return hash.digest("base64url").slice(0, 16);
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
  if (!validName(meta?.name) || typeof declared?.client !== "string") return undefined;
  const root = path.resolve(packageDir);
  const client = path.resolve(root, declared.client);
  const dir = path.dirname(client);
  if (dir === root || !fileIn(root, client)) return undefined;
  const style = typeof declared.style === "string" ? fileIn(dir, path.resolve(root, declared.style)) : undefined;
  let rev: string | undefined;
  return {
    name: meta.name,
    ...(typeof meta.version === "string" ? { version: meta.version } : {}),
    dir,
    entry: path.basename(client),
    ...(style ? { style } : {}),
    // Read as it is first asked for: a file a page fetches is found by the folder alone, and every fetch would otherwise
    // look at every file of every half. The stylesheet too, however many files there are: the page tells one revision
    // from another by the module's address alone.
    get rev() {
      return (rev ??= style ? revOf(dir, client, path.join(dir, style)) : revOf(dir, client));
    },
  };
}

/** What a module names after `from`, or by an `import` of its own, to load with it: not `import()`, which waits until it is called. */
const STATIC_IMPORTS = [
  // Anchored where a statement starts and with a gap of bounded length, so that the time it takes is in step with the size of the file
  // whatever is in it: an unbounded gap from every `import` or `export` in a long stretch without a quote is quadratic.
  /(?:^|[;}\n/])\s*(?:import|export)\b\s*(?:type\s+)?[^'"`;]{0,1000}?\bfrom\s*(['"])([^'"]{1,500})\1/g,
  /(?:^|[;}\n/])\s*import\s*(['"])([^'"]{1,500})\1/g,
];
/** A module longer than this is not read for what it imports: an extension's own modules, bundled, are far below it. */
const SCAN_LIMIT = 2 * 1024 * 1024;
/** What a module imported, by where it was and how it stood: read again only when the file is not as it was. */
const importsOf = new Map<string, { stamp: string; files: string[] }>();
/** More than this is a folder that is not one module's, and preloading it would be a cost, not a help. */
const PRELOAD_LIMIT = 64;

/**
 * The files of the browser half's folder that its module loads along with itself, by what each says it
 * imports, as far down as they go: the paths from the folder, the module's own left out.
 *
 * The page asks for them all at once. A browser that is left to find them reads a module, sees what it
 * imports, asks for that, reads it, and so on down: a round trip for every level of a bundle that has
 * levels, which is most of the time a page of an extension takes to be there. A relative address is
 * what the module's own import resolves to, without the revision the module itself is asked for under,
 * so what is fetched ahead is the very file the import then finds there.
 */
export function staticImports(half: ClientHalf): string[] {
  const found = new Set<string>();
  const entry = half.entry;
  const queue = [entry];
  while (queue.length && found.size < PRELOAD_LIMIT) {
    const from = queue.shift()!;
    const file = fileIn(half.dir, path.join(half.dir, from));
    if (!file) continue;
    let files: string[];
    try {
      const stat = statSync(path.join(half.dir, file));
      if (stat.size > SCAN_LIMIT) continue;
      const stamp = `${stat.size}-${stat.mtimeMs}`;
      const had = importsOf.get(path.join(half.dir, file));
      if (had?.stamp === stamp) {
        files = had.files;
      } else {
        const text = readFileSync(path.join(half.dir, file), "utf8");
        files = [];
        for (const pattern of STATIC_IMPORTS) {
          for (const match of text.matchAll(pattern)) {
            const spec = match[2]!;
            if (!/^\.{1,2}\//.test(spec) || !/\.m?js$/.test(spec)) continue;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
            if (!target.startsWith("../") && !path.posix.isAbsolute(target) && !files.includes(target)) files.push(target);
          }
        }
        importsOf.set(path.join(half.dir, file), { stamp, files });
      }
    } catch {
      continue;
    }
    for (const target of files) {
      if (target === entry || found.has(target) || !fileIn(half.dir, path.join(half.dir, target))) continue;
      found.add(target);
      queue.push(target);
    }
  }
  return [...found];
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
  const requires = requiresOf(meta), optional = buildsOn(meta.pithagoras.optional);
  let rev: string | undefined;
  return {
    name: meta.name,
    ...(typeof meta.version === "string" ? { version: meta.version } : {}),
    file,
    // Read as it is first asked for, as a browser half's is.
    get rev() {
      return (rev ??= revOf(path.dirname(file), file));
    },
    ...(requires ? { requires } : {}),
    ...(optional ? { optional } : {}),
    ...(meta.pithagoras.isolated === true ? { isolated: true as const } : {}),
  };
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
