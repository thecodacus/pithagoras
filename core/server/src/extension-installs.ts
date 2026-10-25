import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionInstalled, ExtensionStatus } from "@pithagoras/extension-api/server";
import { installNotes, packageRemoved, setInstallNote } from "./db.js";
import { dataOwner } from "./extension-data.js";
import { serverHalfStatus } from "./extension-host.js";
import { isSwitchedOff, sourceOf } from "./extension-switch.js";
import { serverHalf, validName } from "./extension-ui.js";
import { piPackageArg } from "./features.js";
import { scrubSecrets } from "./logs.js";
import { oneAtATime } from "./one-at-a-time.js";
import { INLINE_EXTENSIONS } from "./pi/inline-extensions.js";
import { readPiSettings } from "./pi-settings.js";
import { sessions } from "./session-manager.js";
import { realPath } from "./within.js";
import { browserFailure, followPackages, listInstalledPackages, shippedExtensions } from "./api/extensions.js";
import { pi } from "./api/packages.js";

/**
 * What a server half asks for when it installs, loads again and removes a package it wrote into its own data folder,
 * and when it asks where an installed extension stands (`portal.extensions.install`, `remove` and `status`).
 * Imported by extension-host.ts when first asked: this imports what imports that.
 *
 * An install and a removal each run whole, from the name check to the note, one at a time for every extension: `pi()`
 * keeps only its call of the CLI apart, and two installs of one name from two folders would otherwise both find the
 * name free, and the second would be installed and never loaded (`halves()` keeps the first package of a name). A
 * person's install in Settings is not in this line, and checks no names.
 */
const inTurn = oneAtATime();

type Listed = { spec: string; path?: string; scope?: string };

/** What a package pi lists says of itself in its package.json; nothing where that cannot be read. */
function metaOf(pkg: Listed): { name?: unknown; version?: unknown } | undefined {
  if (!pkg.path) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The packages pi lists for the portal's own user, with their folders: what the portal loads (see halves() in api/extensions.ts). */
const usersOwn = async () => (await listInstalledPackages()).filter((pkg) => pkg.path && (!pkg.scope || /^user/i.test(pkg.scope)));

/**
 * Installs the package in `folder`, a folder in an extension's own data folder `dataDir`, with `note`: see
 * `extensions.install`. Which extension's it is, is said by the folder (dataOwner), not here.
 */
export function installFor(dataDir: string, folder: string, note?: string): Promise<ExtensionInstalled> {
  return inTurn(async () => {
    const real = realpathSync(folder);
    if (!real.startsWith(realpathSync(dataDir) + path.sep)) throw new TypeError("install takes a folder in the extension's own dataDir()");
    let meta: { name?: unknown };
    try {
      meta = JSON.parse(readFileSync(path.join(real, "package.json"), "utf8"));
    } catch (e) {
      throw new TypeError(`${folder} has no package.json that can be read: ${(e as Error).message}`);
    }
    const name = meta?.name;
    if (!validName(name)) throw new TypeError(`The package.json in ${folder} has no valid name: an npm name, with or without a scope`);
    // halves() keeps the first package of a name: a second would be installed, and never loaded.
    if (shippedExtensions().some((ext) => ext.name === name)) throw new Error(`${name} is the name of an extension that comes with Pithagoras`);
    // A chat's pi files a server half's factory by its name, as it files the portal's own inline extensions.
    if (INLINE_EXTENSIONS.includes(name)) throw new Error(`${name} is the name of one of the portal's own extensions in a chat's pi`);
    const other = (await usersOwn()).find((pkg) => metaOf(pkg)?.name === name && realPath(pkg.path!) !== real);
    if (other) throw new Error(`${name} is installed already, from ${other.spec}`);
    // pi keeps a folder it has listed already as it is, switched off or not: installed again, it is loaded again.
    await pi(["install", real]);
    const spec = (await usersOwn()).find((pkg) => realPath(pkg.path!) === real)?.spec;
    if (!spec) throw new Error(`pi installed ${folder}, and does not list it`);
    // Before the halves follow, for a page that follows the install to find it.
    setInstallNote(spec, { ...(note ? { note } : {}), at: new Date().toISOString() });
    await followPackages();
    const { reloaded, waiting } = await sessions.reloadIdle();
    return { ...(await statusOf(name))!, reloaded, waiting };
  });
}

/** Uninstalls the package `name` that is in `caller`'s own data folder, however it was installed: see `extensions.remove`. */
export function removeFor(caller: string, name: string): Promise<{ reloaded: number; waiting: number }> {
  return inTurn(async () => {
    const pkg = (await usersOwn()).find((pkg) => metaOf(pkg)?.name === name && dataOwner(pkg.path!) === caller);
    if (!pkg) throw new Error(`${name} is not installed from ${caller}'s folder`);
    // As DELETE /api/packages does it. The files stay: they are the extension's own.
    await pi(["remove", piPackageArg(pkg.spec)]);
    await packageRemoved(pkg.spec);
    await followPackages();
    return sessions.reloadIdle();
  });
}

/** Where the installed extension `name` stands now (see ExtensionStatus): of the packages of that name, the first, as halves() has it. */
export async function statusOf(name: string, { chatId, since }: { chatId?: string; since?: number } = {}): Promise<ExtensionStatus | undefined> {
  const found = (await usersOwn()).map((pkg) => ({ pkg, meta: metaOf(pkg) })).find(({ meta }) => meta?.name === name);
  if (!found) return undefined;
  const { pkg } = found;
  const version = found.meta!.version;
  const folder = pkg.path!;
  const listed = readPiSettings().packages;
  const entry = (Array.isArray(listed) ? listed : []).find((e) => sourceOf(e) === pkg.spec);
  const extension = dataOwner(folder);
  const status: ExtensionStatus = {
    name,
    ...(typeof version === "string" ? { version } : {}),
    spec: pkg.spec,
    enabled: entry === undefined || !isSwitchedOff(entry),
    ...(extension ? { installedFrom: { extension, ...installNotes()[pkg.spec] } } : {}),
  };
  if (serverHalf(folder)) {
    const { running, failure, crash, lines } = serverHalfStatus(name);
    status.server = {
      running,
      ...(failure ? { failure } : {}),
      ...(crash ? { crash: { rev: crash.rev, at: crash.at, error: crash.error, ...(crash.stack ? { stack: crash.stack } : {}) } } : {}),
      // What it said can hold what it was given: nothing in it that looks like a secret.
      lines: lines.filter((line) => since === undefined || line.id > since).map((line) => ({ ...line, text: scrubSecrets(line.text) })),
    };
  }
  const client = await browserFailure(name);
  if (client) status.client = client;
  // Its own of what the chat could not load: of a factory of its server half (pi files it as `<inline:name>`), or of a file of its folder (its pi half).
  if (chatId !== undefined) {
    status.loadErrors = sessions
      .loadErrors(chatId)
      .filter((failure) => failure.path === `<inline:${name}>` || failure.path.startsWith(folder + path.sep))
      .map((failure) => ({ error: failure.error }));
  }
  return status;
}
