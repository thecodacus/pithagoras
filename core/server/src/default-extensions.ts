import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bundledPath } from "./bundled.js";
import { getSetting, packageRemoved, putSetting } from "./db.js";
import { pi } from "./api/packages.js";
import { followPackages, installingDefaults, listInstalledPackages, preparingExtensions, shippedExtensions, switchPackage } from "./api/extensions.js";
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
 * The list is short on purpose (Terminal, Files and the themes): the rest of what comes with the portal is the person's
 * to choose, in the setup assistant's extension step (the presets below) or in Settings → Extensions. Shrinking the
 * list takes nothing out of a portal that has the others: what was installed stays installed.
 *
 * `PORTAL_DEFAULT_EXTENSIONS=off` installs none of them: a portal whose
 * operator chooses every extension, and the test portals, which start by the
 * hundred and have no use for them. A preset's name or a comma list of
 * extensions (see defaultsChoice) installs that in place of the list, for a portal set up without the assistant.
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

/**
 * The folders the list names (or `folders`, where a choice of the operator's is installed in its place), with the
 * package each holds. A name that is not a folder of the portal's is left out.
 */
export function defaultExtensions(dir = bundledPath("extensions"), folders?: string[]): { folder: string; dir: string; name: string }[] {
  if (!dir) return [];
  let listed: unknown = folders;
  if (!folders) {
    try {
      listed = JSON.parse(readFileSync(path.join(dir, "defaults.json"), "utf8"));
    } catch {
      return [];
    }
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
 * The sets the setup assistant offers, and `PORTAL_DEFAULT_EXTENSIONS` takes by name. Each is the default set and what
 * it adds, by folder; "everything" is every extension that comes with the portal. Docker for extensions is listed
 * before Voice: it is installed first either way (see withRequirements), but the list reads in the order it happens.
 */
const PRESETS: { id: string; adds: string[] | "all" }[] = [
  { id: "minimal", adds: [] },
  { id: "developer", adds: ["git", "docker", "docs"] },
  { id: "creative", adds: ["media", "canvas", "voice"] },
  { id: "everything", adds: "all" },
];

export interface ExtensionPreset {
  id: string;
  /** The folders of the portal's own extensions/ folder. */
  folders: string[];
  /** The package each folder holds, in the same order. */
  extensions: string[];
}

/** The extensions in the portal's own folder; none where there is no folder to read. */
const shippedExtensionsIn = (dir: string | undefined): ReturnType<typeof shippedExtensions> => {
  try {
    return dir ? shippedExtensions(dir) : [];
  } catch {
    return [];
  }
};

/** The presets, with the folders and packages of this install: a folder the install does not have is left out. */
export function extensionPresets(dir = bundledPath("extensions")): ExtensionPreset[] {
  const names = new Map(shippedExtensionsIn(dir).map((ext) => [path.basename(ext.spec), ext.name]));
  const minimal = defaultExtensions(dir).map((ext) => ext.folder);
  return PRESETS.map(({ id, adds }) => {
    const folders = [...new Set(adds === "all" ? [...minimal, ...names.keys()] : [...minimal, ...adds])].filter((folder) => names.has(folder));
    return { id, folders, extensions: folders.map((folder) => names.get(folder)!) };
  });
}

/**
 * What PORTAL_DEFAULT_EXTENSIONS asks for, as the folders to install: nothing for `off`, the default set for nothing, `on`
 * and the like, a preset's folders for its name (`developer`), and for a comma list (`terminal,files,git`) the folders it
 * names, by folder or package name. Anything else is refused, whole: `refused` says so and the default set is what is
 * installed, so a typo does not leave a new portal without even a terminal.
 */
export function defaultsChoice(value: string | undefined, dir = bundledPath("extensions")): { folders: string[]; refused?: string } {
  const text = (value ?? "").trim().toLowerCase();
  const standard = defaultExtensions(dir).map((ext) => ext.folder);
  if (/^(off|0|false|no)$/.test(text)) return { folders: [] };
  if (/^(|on|1|true|yes|default)$/.test(text)) return { folders: standard };
  const presets = extensionPresets(dir);
  const preset = presets.find((p) => p.id === text);
  if (preset) return { folders: preset.folders };
  const known = new Map<string, string>();
  for (const ext of shippedExtensionsIn(dir)) {
    known.set(path.basename(ext.spec), path.basename(ext.spec));
    known.set(ext.name.toLowerCase(), path.basename(ext.spec));
  }
  const asked = text.split(",").map((name) => name.trim());
  const folders = asked.map((name) => known.get(name));
  if (folders.every(Boolean)) return { folders: [...new Set(folders as string[])] };
  const unknown = asked.filter((name, i) => !folders[i]).map((name) => name || "(empty)");
  return {
    folders: standard,
    refused:
      `PORTAL_DEFAULT_EXTENSIONS="${value}" is refused: ${unknown.join(", ")} is neither a preset nor an extension that comes with the portal. ` +
      `It takes off, a preset (${presets.map((p) => p.id).join(", ")}) or a comma list of ${[...new Set(known.values())].join(", ")}. ` +
      `The extensions a portal starts with are installed instead`,
  };
}

/**
 * `folders` with the shipped extensions they cannot work without added, each before what needs it (a choice with Voice
 * installs Docker for extensions first, as installing Voice from Settings does).
 */
function withRequirements(folders: string[], dir: string): string[] {
  const shipped = shippedExtensionsIn(dir);
  const byName = new Map(shipped.map((ext) => [ext.name, ext]));
  const byFolder = new Map(shipped.map((ext) => [path.basename(ext.spec), ext]));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (folder: string) => {
    if (seen.has(folder)) return;
    seen.add(folder);
    for (const need of Object.keys(byFolder.get(folder)?.requires ?? {})) {
      const found = byName.get(need);
      if (found) visit(path.basename(found.spec));
    }
    order.push(folder);
  };
  folders.forEach(visit);
  return order;
}

/**
 * Extensions of the portal's own folder that are no longer there, and the one that has what they had.
 * Dusk and Warm were folders of their own before they became themes of `themes`.
 */
const RETIRED: { folder: string; replacedBy: string }[] = [
  { folder: "theme-dusk", replacedBy: "themes" },
  { folder: "theme-warm", replacedBy: "themes" },
];

/** The packages pi has installed, by the name their own package.json gives, with the source pi lists each as. */
async function installedByName(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const pkg of await listInstalledPackages()) {
    if (!pkg.path || !existsSync(path.join(pkg.path, "package.json"))) continue;
    try {
      names.set(JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"))?.name, pkg.spec);
    } catch {
      // Not one it could read: it names nothing.
    }
  }
  return names;
}

/**
 * pi's list has entries for the folders of extensions the portal no longer ships: left in, pi reports each as a
 * package that is missing. They are taken out, with what the portal kept for them. Where one was switched on, the
 * package that replaces it is made sure of first (installed, or switched on where it was installed and switched off),
 * so the person keeps what it gave; the entries stay until that worked, and a start where it did not tries again.
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
  const wanted = new Set(gone.filter((entry) => !isSwitchedOff(entry)).map((entry) => retiredAs(entry)!.replacedBy));
  if (dir && wanted.size) {
    const names = await installedByName();
    for (const folder of wanted) {
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(path.join(dir, folder, "package.json"), "utf8"))?.name;
      } catch {
        continue;
      }
      if (typeof name !== "string") continue;
      const spec = names.get(name);
      if (spec === undefined) {
        // A failure ends here, before anything is taken out: the next start finds the entries and tries again.
        await pi(["install", path.join(dir, folder)]);
        console.log(`[extensions] installed ${name}, which has what the extensions taken out had`);
      } else if (isSwitchedOff((readPiSettings().packages as unknown[] | undefined)?.find((e) => sourceOf(e) === spec))) {
        await switchPackage(spec, true);
        console.log(`[extensions] switched ${name} on, which has what the extensions taken out had`);
      }
    }
  }
  await updatePiSettings((all) => {
    if (Array.isArray(all.packages)) all.packages = all.packages.filter((entry) => !retiredAs(entry));
  });
  const sources = gone.map((entry) => sourceOf(entry)!);
  for (const source of sources) await packageRemoved(source);
  console.log(`[extensions] took out ${sources.join(", ")}: extensions the portal does not ship any more`);
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
export const installDefaultExtensions = (dir = bundledPath("extensions")): Promise<string[]> => installingDefaults(installDefaults(dir));

async function installDefaults(dir: string | undefined): Promise<string[]> {
  // Before the list: what it finds installed is what is left, not what an earlier version of the portal shipped.
  try {
    await preparingExtensions(replaceRetiredExtensions(dir));
  } catch (e) {
    console.error("[extensions] could not take out the extensions the portal does not ship any more:", e);
  }
  const choice = defaultsChoice(process.env.PORTAL_DEFAULT_EXTENSIONS, dir);
  if (choice.refused) console.error(`[extensions] ${choice.refused}`);
  if (!choice.folders.length) return [];
  const done = installedOnce();
  const due = defaultExtensions(dir, dir ? withRequirements(choice.folders, dir) : choice.folders).filter((ext) => !done.includes(ext.folder));
  if (!due.length) return [];
  const names = new Set((await installedByName()).keys());
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
