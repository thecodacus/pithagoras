import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { OWNER_LABEL } from "./docker";
import { checked, logs, request, socketPath } from "./engine";

/**
 * `docker compose`, run in Docker's own command-line image as a container of this extension's: the portal's image has
 * no compose, and a download of it to keep up with is not needed where Docker is. The container has Docker's socket and
 * the chat's folder, read-only, at the path the folder has on Docker's machine: what compose resolves in it (a folder to
 * mount, what an image is built from) is then a path Docker finds as it is.
 */

/** Pinned: what compose takes, and what its normalized output says, is this version's. */
export const RUNNER_IMAGE = "docker:29.8.1-cli";

export type Ran = { code: number; stdout: string; stderr: string };

/**
 * Runs `docker compose <args>` with `folder` (a path on Docker's machine) as the folder it works in, with `input` as
 * what it reads (`-f -`), and stops it when `signal` is aborted. `as` is the user it runs as, with its groups: the
 * chat's agent, where it runs as a user of its own, so that compose reads the folder as the agent may.
 */
export type Runner = (args: string[], options: { folder: string; input?: string; signal?: AbortSignal; as?: { uid: number; gid: number; groups: number[] } }) => Promise<Ran>;

export function composeRunner(own: string, ensure: (image: string) => Promise<void>, onHost: (where: string) => Promise<string>): Runner {
  return async (args, { folder, input, signal, as }) => {
    // A call stopped before this step, or while the image downloads, runs nothing more.
    signal?.throwIfAborted();
    await ensure(RUNNER_IMAGE);
    signal?.throwIfAborted();
    const socket = await onHost(socketPath());
    const { Id } = await checked<{ Id: string }>("POST", `/containers/create?name=pithagoras-docker-compose-${randomBytes(4).toString("hex")}`, {
      Image: RUNNER_IMAGE,
      // What it reads goes in by the environment: a container's input needs a connection held open to give it.
      Cmd: input === undefined ? ["docker", "compose", ...args] : ["sh", "-c", 'printf %s "$COMPOSE_INPUT" | docker compose "$@"', "compose", ...args],
      Env: [...(input === undefined ? [] : [`COMPOSE_INPUT=${input}`]), ...(as ? ["HOME=/tmp"] : [])],
      WorkingDir: folder,
      Labels: { [OWNER_LABEL]: own },
      // As another user, with the group the socket is Docker's to, for compose to reach Docker; its home is not that user's.
      ...(as ? { User: `${as.uid}:${as.gid}` } : {}),
      HostConfig: {
        Binds: [`${socket}:/var/run/docker.sock`, `${folder}:${folder}:ro`],
        ...(as ? { GroupAdd: [...as.groups, statSync(socketPath()).gid].map(String) } : {}),
      },
    });
    const kill = () => void request("POST", `/containers/${Id}/kill`).catch(() => {});
    signal?.addEventListener("abort", kill, { once: true });
    try {
      // Stopped while it was being made: it is not started.
      signal?.throwIfAborted();
      await checked("POST", `/containers/${Id}/start`);
      // As long as it takes: a build can take many minutes.
      const { StatusCode } = await checked<{ StatusCode: number }>("POST", `/containers/${Id}/wait`, undefined, 0);
      const [stdout, stderr] = await Promise.all([
        logs(Id, "all", false, { stdout: true, stderr: false }),
        logs(Id, "all", false, { stdout: false, stderr: true }),
      ]);
      return { code: StatusCode, stdout, stderr };
    } finally {
      signal?.removeEventListener("abort", kill);
      await request("DELETE", `/containers/${Id}?force=true`).catch(() => {});
    }
  };
}
