import { readFileSync } from "node:fs";
import path from "node:path";
import { checked, DockerError } from "./engine";

/**
 * Where a path of the portal's is on Docker's side. Docker reads the paths it is given (a container's folders, what an
 * image is built from) on its own machine, and a portal that runs in a container sees that machine's folders where they
 * are mounted into it: its /workspaces may be /root/pithagoras-workspaces there. A portal that runs on the machine
 * itself sees them where they are.
 */

/**
 * The id of the container the portal runs in, from the files Docker mounts into each of its containers (/etc/hostname
 * among them, from the container's own folder): none where the portal runs on the machine itself.
 */
export function ownContainer(mountinfo = "/proc/self/mountinfo"): string | undefined {
  let text: string;
  try {
    text = readFileSync(mountinfo, "utf8");
  } catch {
    return undefined;
  }
  return /\/containers\/([0-9a-f]{64})\/hostname /.exec(text)?.[1];
}

type Mount = { Source: string; Destination: string };

/** What gives a path of the portal's as Docker's machine has it, for the portal in `container`, or on the machine itself. */
export function hostPaths(container = ownContainer()): (where: string) => Promise<string> {
  let mounts: Promise<Mount[]> | undefined;
  const ofContainer = () =>
    (mounts ??= checked<{ Mounts?: Mount[] }>("GET", `/containers/${container}/json`).then(
      (found) => found.Mounts ?? [],
      (e: DockerError) => {
        // Asked again next time: Docker may not have been there yet.
        mounts = undefined;
        throw e.status === 404 ? new DockerError("The portal runs in a container this Docker does not know, so where its folders are on Docker's side cannot be told") : e;
      },
    ));
  return async (where) => {
    if (!container) return where;
    const within = (m: Mount) => where === m.Destination || where.startsWith(m.Destination.endsWith("/") ? m.Destination : `${m.Destination}/`);
    // The one mounted deepest: a folder mounted inside another is its own.
    const holding = (await ofContainer()).filter(within).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!holding) throw new DockerError(`${where} is in the portal's container only, on no folder mounted into it, so Docker cannot reach it`);
    return path.posix.join(holding.Source, path.posix.relative(holding.Destination, where));
  };
}
