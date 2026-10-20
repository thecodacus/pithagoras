import semver from "semver";
import { registryPackage, type RegistryPackage } from "./catalog.js";
import { requiresOf, takes } from "./extension-ui.js";

/**
 * What installing an extension brings with it.
 *
 * An extension names what it cannot work without in its package.json
 * (`pithagoras.requires`), and does not start until each of those is there,
 * switched on, in a version it takes (see extension-host.ts). Before one is
 * installed, the page asks what that leaves to be done: each extension it
 * requires, and each that those require, that is not there as it is needed,
 * with what is done for it, each before what needs it.
 *
 * A requirement is installed from the portal's own folder where an extension
 * there goes by its name, and otherwise from npm, by its name within the range
 * taken. A name the portal ships is never asked of npm: anyone can publish a
 * package under it there. One that is installed but switched off is switched
 * on. One that is nowhere in a version taken, or is installed or in the
 * portal's folder in a version not taken, is said, and nothing is done for it:
 * the extension can be installed all the same, and waits for it as the host
 * says. So is a requirement met a second time, by a range that does not take
 * the version the first left there.
 *
 * What a spec installs is known beforehand for the portal's own folder, and for
 * npm, whose registry has the package.json of every version. A git URL or a
 * folder of the server's is known only once it is installed: nothing is said
 * of it.
 */

/** Something an extension being installed needs that is not there as it is needed, and what is done for it. */
export interface Need {
  /** The extension needed. */
  name: string;
  /** The versions of it taken, as the extension that needs it says. */
  range: string;
  /** The extension that needs it: the one being installed, or one it needs. */
  for: string;
  /**
   * `install`: installed by `spec`, from the portal's own folder or npm (`from`). `switch-on`: installed, switched
   * off, and switched on by `spec`. `missing`: nowhere in a version taken, or npm could not be asked (`error`).
   * `version`: there in `version`, which is not taken: installed, or, with `from`, the one in the portal's own folder,
   * or the one installed from npm for what needed it first. For the last two nothing is done.
   */
  action: "install" | "switch-on" | "missing" | "version";
  spec?: string;
  from?: "shipped" | "npm";
  /** The version installed, or the one that will be. */
  version?: string;
  /** Why npm could not say whether it has it. */
  error?: string;
}

export interface InstallPlan {
  /** The extension the spec installs, where that is known beforehand. */
  name?: string;
  version?: string;
  /** What is done first, each before what needs it. Empty where nothing is, or nothing can be known. */
  needs: Need[];
}

/** An extension installed for the portal: by its package.json, with the spec pi installed it by. */
export interface InstalledExtension {
  name: string;
  version?: string;
  spec: string;
  enabled: boolean;
  requires?: Record<string, string>;
}

/** An extension in the portal's own folder, installed from it by `spec`. */
export interface FolderExtension {
  name: string;
  version?: string;
  spec: string;
  requires?: Record<string, string>;
}

/** An npm spec's name and what it asks of the version, as pi reads it: `npm:@scope/name@^1.0.0`. */
function npmSpec(spec: string): { name: string; wanted?: string } | undefined {
  const match = /^npm:(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec.trim());
  return match ? { name: match[1]!, ...(match[2] ? { wanted: match[2] } : {}) } : undefined;
}

/** The version of a package npm installs for what a spec asks: a tag ("latest" without one), or the newest a range takes, "latest" first where it does. */
function versionOf(pkg: RegistryPackage, wanted = "latest"): string | undefined {
  if (pkg.tags[wanted]) return pkg.tags[wanted];
  if (!semver.validRange(wanted)) return undefined;
  const latest = pkg.tags.latest;
  if (latest && pkg.versions[latest] && semver.satisfies(latest, wanted)) return latest;
  return semver.maxSatisfying(Object.keys(pkg.versions), wanted) ?? undefined;
}

/** What npm would install for `name` and what is wanted of its version: that version and its package.json. Nothing where there is none. */
async function onNpm(name: string, wanted?: string): Promise<{ version: string; manifest: Record<string, any> } | undefined> {
  const pkg = await registryPackage(name);
  const version = pkg && versionOf(pkg, wanted);
  return pkg && version && pkg.versions[version] ? { version, manifest: pkg.versions[version] } : undefined;
}

/**
 * What installing `spec` brings with it, as things are: `installed` is what is installed for the portal, and
 * `folder` what is in its own folder. npm is asked for what is in neither.
 */
export async function planInstall(spec: string, { installed, folder }: { installed: InstalledExtension[]; folder: FolderExtension[] }): Promise<InstallPlan> {
  let root: { name: string; version?: string; requires?: Record<string, string> } | undefined = folder.find((ext) => ext.spec === spec);
  const npm = root ? undefined : npmSpec(spec);
  if (npm) {
    // The registry that cannot be asked says nothing beforehand: installing says what is wrong, as it did.
    const found = await onNpm(npm.name, npm.wanted).catch(() => undefined);
    if (found && typeof found.manifest.name === "string") root = { name: found.manifest.name, version: found.version, requires: requiresOf(found.manifest) };
  }
  if (!root) return { needs: [] };

  const needs: Need[] = [];
  // Each once: one needed twice is done the first time, and one that needs itself through others is not looked at again.
  const seen = new Set([root.name]);
  // The version each will be there in, once what is planned is done, and where it comes from where it is not installed.
  const left = new Map<string, Pick<Need, "version" | "from">>();
  const visit = async (of: string, requires: Record<string, string> | undefined) => {
    for (const [name, range] of Object.entries(requires ?? {})) {
      const need = { name, range, for: of };
      if (seen.has(name)) {
        // Met again by another range: the version the first left there may not be one this takes.
        const was = left.get(name);
        if (was && !takes(range, was.version)) needs.push({ ...need, action: "version", ...was });
        continue;
      }
      seen.add(name);
      const there = installed.find((ext) => ext.name === name);
      if (there) {
        left.set(name, there.version ? { version: there.version } : {});
        if (!takes(range, there.version)) {
          needs.push({ ...need, action: "version", ...(there.version ? { version: there.version } : {}) });
          continue;
        }
        await visit(name, there.requires);
        if (!there.enabled) needs.push({ ...need, action: "switch-on", spec: there.spec, ...(there.version ? { version: there.version } : {}) });
        continue;
      }
      // The portal's own by its name, in whatever version: npm is not asked for a name the portal ships.
      const own = folder.find((ext) => ext.name === name);
      if (own) {
        const version = own.version ? { version: own.version } : {};
        if (!takes(range, own.version)) {
          needs.push({ ...need, action: "version", from: "shipped", ...version });
          continue;
        }
        left.set(name, { from: "shipped", ...version });
        await visit(name, own.requires);
        needs.push({ ...need, action: "install", spec: own.spec, from: "shipped", ...version });
        continue;
      }
      let found: Awaited<ReturnType<typeof onNpm>>;
      try {
        found = semver.validRange(range) ? await onNpm(name, range) : undefined;
      } catch (e) {
        needs.push({ ...need, action: "missing", error: (e as Error).name === "TimeoutError" ? "npm did not answer in time" : (e as Error).message });
        continue;
      }
      if (!found) {
        needs.push({ ...need, action: "missing" });
        continue;
      }
      left.set(name, { from: "npm", version: found.version });
      await visit(name, requiresOf(found.manifest));
      // By the range, not the version found: pi keeps it within the range when it updates it.
      needs.push({ ...need, action: "install", spec: `npm:${name}@${range}`, from: "npm", version: found.version });
    }
  };
  await visit(root.name, root.requires);
  return { name: root.name, ...(root.version ? { version: root.version } : {}), needs };
}
