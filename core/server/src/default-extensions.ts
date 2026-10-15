import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bundledPath } from "./bundled.js";
import { getSetting, putSetting } from "./db.js";
import { pi } from "./api/packages.js";
import { followPackages, listInstalledPackages } from "./api/extensions.js";

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
 * `PORTAL_DEFAULT_EXTENSIONS=off` installs none of them: a portal whose
 * operator chooses every extension, and the test portals, which start by the
 * hundred and have no use for them.
 */

const DONE = "default_extensions_installed";

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
 * next start.
 */
export async function installDefaultExtensions(dir = bundledPath("extensions")): Promise<string[]> {
  if (/^(off|0|false|no)$/i.test(process.env.PORTAL_DEFAULT_EXTENSIONS ?? "")) return [];
  const done = installedOnce();
  const due = defaultExtensions(dir).filter((ext) => !done.includes(ext.folder));
  if (!due.length) return [];
  const names = new Set<string>();
  for (const pkg of await listInstalledPackages()) {
    if (!pkg.path || !existsSync(path.join(pkg.path, "package.json"))) continue;
    try {
      names.add(JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"))?.name);
    } catch {
      // Not one it could read: it names nothing.
    }
  }
  const installed: string[] = [];
  for (const ext of due) {
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
  if (installed.length) await followPackages();
  return installed;
}
