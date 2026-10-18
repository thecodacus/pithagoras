import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bundledPath } from "./bundled.js";
import { getSetting, packageRemoved, putSetting } from "./db.js";
import { pi } from "./api/packages.js";
import { followPackages, listInstalledPackages, preparingExtensions } from "./api/extensions.js";
import { isLocalSource, localPackagePath } from "./features.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { readPiSettings, updatePiSettings } from "./pi-settings.js";

/**
 * The extensions a portal starts with.
 *
 * extensions/defaults.json names folders of the portal's own extensions/
 * folder. Each is installed once, with `pi install <folder>`, as Settings →
 * Extensions → Discover installs one: from then on it is an installed package
 * like any other, switched off or removed the same way, and one removed is not
 * put back on the next start. One already installed under its name, from that
 * folder or from anywhere else, is left as it is: the portal's copy is not
 * pushed in beside someone's own.
 *
 * What was installed, or found installed, is kept in the portal's settings by
 * folder: a portal that is updated installs what the new list adds, once.
 *
 * An extension the portal stopped shipping (Dusk and Warm, now themes of `themes`) is taken out of pi's list at the
 * start, and its replacement installed where it was in use: see replaceRetiredExtensions.
 *
 * `PORTAL_DEFAULT_EXTENSIONS=off` installs none of them: a portal whose
 * operator chooses every extension, and the test portals, which start by the
 * hundred and have no use for them.
 */

const DONE = "default_extensions_installed";

/** The portal is stopping: no install of the list begins after this. */
let stopping = false;
/**
 * No more of the list is installed: the one going on finishes, and what is left is installed on the next start.
 * Waiting for the whole list on a stop ran past the ten seconds docker gives a container before it kills it.
 */
export function stopInstallingDefaults(): void {
  stopping = true;
}

/** The folders the list names, with the package each holds. A name that is not a folder of the portal's is left out. */
export function defaultExtensions(dir = bundledPath("extensions")): { folder: string; dir: string; name: string }[] {
  if (!dir) return [];
  let listed: unknown;
  try {
    listed = JSON.parse(readFileSync(path.join(dir, "defaults.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const found: { folder: string; dir: string; name: string }[] = [];
  for (const folder of listed) {
    if (typeof folder !== "string" || !/^[\w.-]+$/.test(folder) || folder.startsWith(".")) continue;
    const at = path.join(dir, folder);
    try {
      const name = JSON.parse(readFileSync(path.join(at, "package.json"), "utf8"))?.name;
      if (typeof name === "string") found.push({ folder, dir: at, name });
    } catch {
      console.error(`[extensions] extensions/defaults.json names "${folder}", which is not a package of the portal's`);
    }
  }
  return found;
}

/**
 * Extensions of the portal's own folder that are no longer there, and the one that has what they had.
 * Dusk and Warm were folders of their own before they became themes of `themes`.
 */
const RETIRED: { folder: string; replacedBy: string }[] = [
  { folder: "theme-dusk", replacedBy: "themes" },
  { folder: "theme-warm", replacedBy: "themes" },
];

/** The names of the packages pi has installed, as their own package.json says. */
async function installedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const pkg of await listInstalledPackages()) {
    if (!pkg.path || !existsSync(path.join(pkg.path, "package.json"))) continue;
    try {
      names.add(JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"))?.name);
    } catch {
      // Not one it could read: it names nothing.
    }
  }
  return names;
}

/**
 * pi's list has entries for the folders of extensions the portal no longer ships: left in, pi reports each as a
 * package that is missing. They are taken out, with what the portal kept for them, and where one was switched on the
 * package that replaces it is installed unless it is installed already, so the person keeps what it gave.
 * A folder of that name that is still there is someone's own and is left alone.
 * Resolves with the sources taken out.
 */
export async function replaceRetiredExtensions(dir = bundledPath("extensions")): Promise<string[]> {
  const retiredAs = (entry: unknown) => {
    const source = sourceOf(entry);
    if (!source || !isLocalSource(source)) return undefined;
    const at = localPackagePath(source);
    return existsSync(path.join(at, "package.json")) ? undefined : RETIRED.find((r) => path.basename(at) === r.folder);
  };
  const listed = readPiSettings().packages;
  const gone = (Array.isArray(listed) ? listed : []).filter((entry) => retiredAs(entry));
  if (!gone.length) return [];
  await updatePiSettings((all) => {
    if (Array.isArray(all.packages)) all.packages = all.packages.filter((entry) => !retiredAs(entry));
  });
  const sources = gone.map((entry) => sourceOf(entry)!);
  for (const source of sources) await packageRemoved(source);
  console.log(`[extensions] took out ${sources.join(", ")}: extensions the portal does not ship any more`);
  const wanted = new Set(gone.filter((entry) => !isSwitchedOff(entry)).map((entry) => retiredAs(entry)!.replacedBy));
  if (dir && wanted.size) {
    const names = await installedNames();
    for (const folder of wanted) {
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(path.join(dir, folder, "package.json"), "utf8"))?.name;
      } catch {
        continue;
      }
      if (typeof name !== "string" || names.has(name)) continue;
      try {
        await pi(["install", path.join(dir, folder)]);
        console.log(`[extensions] installed ${name}, which has what the extensions taken out had`);
      } catch (e) {
        console.error(`[extensions] could not install ${name}: ${(e as Error).message}`);
      }
    }
  }
  await followPackages();
  return sources;
}

const installedOnce = (): string[] => {
  try {
    const kept = JSON.parse(getSetting(DONE) ?? "[]");
    return Array.isArray(kept) ? kept.filter((folder): folder is string => typeof folder === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Installs each package of the list not installed once before. Resolves with
 * the folders it installed now. One that fails is said, and tried again on the
 * next start, as is one a stop came before (see stopInstallingDefaults).
 */
export async function installDefaultExtensions(dir = bundledPath("extensions")): Promise<string[]> {
  // Before the list: what it finds installed is what is left, not what an earlier version of the portal shipped.
  try {
    await preparingExtensions(replaceRetiredExtensions(dir));
  } catch (e) {
    console.error("[extensions] could not take out the extensions the portal does not ship any more:", e);
  }
  if (/^(off|0|false|no)$/i.test(process.env.PORTAL_DEFAULT_EXTENSIONS ?? "")) return [];
  const done = installedOnce();
  const due = defaultExtensions(dir).filter((ext) => !done.includes(ext.folder));
  if (!due.length) return [];
  const names = await installedNames();
  const installed: string[] = [];
  for (const ext of due) {
    if (stopping) break;
    if (!names.has(ext.name)) {
      try {
        await pi(["install", ext.dir]);
        installed.push(ext.folder);
        console.log(`[extensions] installed ${ext.name}, which a portal starts with`);
      } catch (e) {
        console.error(`[extensions] could not install ${ext.name}, which a portal starts with: ${(e as Error).message}`);
        continue;
      }
    }
    done.push(ext.folder);
    putSetting(DONE, JSON.stringify(done));
  }
  if (installed.length && !stopping) await followPackages();
  return installed;
}
