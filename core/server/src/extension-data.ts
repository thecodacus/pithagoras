import { realpathSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { DATA_DIR } from "./data-dir.js";

/**
 * Where an extension's own data is (`portal.dataDir()`), in one place: one folder for each package in the portal's
 * data folder, which no agent can write.
 */
const DATA = join(resolvePath(DATA_DIR), "extension-data");

/** A package's own data folder, by its name written as one part of a path (a scoped name has a slash, and a dot name is no step up). Not made here. */
export const dataDirOf = (name: string): string => join(DATA, encodeURIComponent(name).replace(/^\./, "%2E"));

/**
 * The extension whose data folder holds `path`, both followed through links: how a package installed from there is
 * told, by the folder itself. Nothing for a path that is not below it, and where either cannot be resolved: the
 * folder of every extension's data is made only once some extension first asks for its `dataDir()`, and a package's
 * folder can be gone while pi still lists it.
 */
export function dataOwner(path: string): string | undefined {
  let real: string, data: string;
  try {
    real = realpathSync(path);
    data = realpathSync(DATA);
  } catch {
    return undefined;
  }
  if (!real.startsWith(data + sep)) return undefined;
  return decodeURIComponent(relative(data, real).split(sep)[0]);
}
