import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerInfo, ContainerSpec, Docker, PullState, VolumeInfo } from "./api";
import { checked, DockerError, exec, logs, ping, pull, request, socketThere } from "./engine";

/**
 * Docker as each extension is given it (api.ts), and as the person sees it all (`overview`). What is whose is the label
 * an extension's containers and volumes are made with (OWNER_LABEL), or, for one it took over, what is kept in this
 * extension's own folder (`adopted.json`): a container's labels cannot be changed once it is made, and one taken over
 * is kept by its id, so that one made again under its name by someone else is not taken for it.
 */

/** The label that says which extension a container or a volume is. */
export const OWNER_LABEL = "pithagoras.extension";

type Raw = { Id: string; Names?: string[]; Image: string; State: string; Status: string; Labels?: Record<string, string> | null };
type Inspected = { Id: string; Name: string; Config?: { Image?: string; Tty?: boolean; Labels?: Record<string, string> | null }; State?: { Status?: string; Running?: boolean } };
type Adopted = { containers: Record<string, string>; volumes: Record<string, string> };

/** How much of what a container wrote `logs` gives, unless asked for another amount, and the most it gives. */
const TAIL = 200;
const MOST_TAIL = 5_000;

const nameOf = (raw: Raw) => (raw.Names?.[0] ?? "").replace(/^\//, "");
/** A name Docker takes for a container or a volume. */
const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);

/**
 * The network mode that puts a container on the portal's own loopback (api.ts): `host` for a portal on the machine itself
 * (Linux only), else `container:<id>` of the running container named by `PORTAL_CONTAINER_NAME`, or by `HOSTNAME`.
 * Whether the portal runs in a container, and on which system, are the portal's own unless a test gives them.
 */
export async function sharedNetwork(inContainer = existsSync("/.dockerenv"), platform = process.platform): Promise<string> {
  if (!inContainer && !process.env.PORTAL_CONTAINER_NAME) {
    if (platform !== "linux") throw new Error("A container shares the network of a portal on the machine itself only on Linux. Run the portal in Docker on this platform.");
    return "host";
  }
  const name = process.env.PORTAL_CONTAINER_NAME || process.env.HOSTNAME;
  if (!name) throw new Error("Set PORTAL_CONTAINER_NAME to the portal Docker container name.");
  const detail = await request<{ Id?: string; State?: { Running?: boolean } }>("GET", `/containers/${encodeURIComponent(name)}/json`);
  if (detail.status !== 200 || !detail.body?.Id || !detail.body.State?.Running) {
    throw new Error("Cannot identify the running portal container. Set PORTAL_CONTAINER_NAME to its Docker name.");
  }
  return `container:${detail.body.Id}`;
}

export function dockerFor(dataDir: string) {
  const file = path.join(dataDir, "adopted.json");
  const adopted = (): Adopted => {
    try {
      const read = JSON.parse(readFileSync(file, "utf8"));
      return { containers: read.containers ?? {}, volumes: read.volumes ?? {} };
    } catch {
      return { containers: {}, volumes: {} };
    }
  };
  const keep = (next: Adopted) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };

  const containerOwner = (id: string, labels: Record<string, string> | null | undefined) => labels?.[OWNER_LABEL] ?? adopted().containers[id] ?? "";
  const info = (raw: Raw): ContainerInfo => ({ name: nameOf(raw), id: raw.Id, image: raw.Image, state: raw.State, status: raw.Status, owner: containerOwner(raw.Id, raw.Labels), labels: raw.Labels ?? {} });

  /** Every container that is an extension's, by its label or as one taken over. */
  async function containers(): Promise<ContainerInfo[]> {
    const all = await checked<Raw[]>("GET", "/containers/json?all=1");
    return all.map(info).filter((c) => c.owner);
  }

  async function inspect(name: string): Promise<Inspected | undefined> {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    const { status, body } = await request<Inspected & { message?: string }>("GET", `/containers/${encodeURIComponent(name)}/json`);
    if (status === 404) return undefined;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body;
  }

  async function get(name: string): Promise<ContainerInfo | undefined> {
    const found = await inspect(name);
    if (!found) return undefined;
    const all = await checked<Raw[]>("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ id: [found.Id] }))}`);
    const raw = all.find((c) => c.Id === found.Id);
    return raw
      ? info(raw)
      : { name: found.Name.replace(/^\//, ""), id: found.Id, image: found.Config?.Image ?? "", state: found.State?.Status ?? "", status: "", owner: containerOwner(found.Id, found.Config?.Labels), labels: found.Config?.Labels ?? {} };
  }

  /** The container `name` is, for `who` to act on: refused where it is someone else's, or nobody's. Nothing where there is none. */
  async function own(who: string, name: string): Promise<Inspected | undefined> {
    const found = await inspect(name);
    if (!found) return undefined;
    const owner = containerOwner(found.Id, found.Config?.Labels);
    if (owner !== who) throw new DockerError(owner ? `${name} is ${owner}'s container, not ${who}'s` : `${name} is no extension's container: take it over first (adopt)`, 403);
    return found;
  }

  async function act(id: string, verb: "start" | "stop" | "remove"): Promise<void> {
    if (verb === "remove") {
      // Stopped first, so that it ends what it was doing; one that will not stop goes all the same.
      await request("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`).catch(() => {});
      const { status, body } = await request<{ message?: string }>("DELETE", `/containers/${encodeURIComponent(id)}?force=true`);
      if (status >= 400 && status !== 404) throw new DockerError(body?.message || `Docker answered ${status}`, status);
      const was = adopted();
      if (id in was.containers) {
        delete was.containers[id];
        keep(was);
      }
      return;
    }
    const { status, body } = await request<{ message?: string }>("POST", `/containers/${encodeURIComponent(id)}/${verb}${verb === "stop" ? "?t=10" : ""}`);
    // 304: it is as asked already.
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
  }

  /** One download for an image at a time, whoever asks: the others are told how it goes too. */
  const pulling = new Map<string, { done: Promise<void>; listeners: Set<(state: PullState) => void>; last: PullState }>();
  async function ensure(image: string, onProgress?: (state: PullState) => void): Promise<void> {
    const { status } = await request("GET", `/images/${encodeURIComponent(image)}/json`);
    if (status === 200) return;
    let going = pulling.get(image);
    if (!going) {
      const listeners = new Set<(state: PullState) => void>();
      const tell = (state: PullState) => {
        current.last = state;
        for (const listener of listeners) listener(state);
      };
      const current = { listeners, last: { active: true, line: "starting" } as PullState, done: Promise.resolve() };
      current.done = pull(image, (line) => tell({ active: true, line })).then(
        () => tell({ active: false, line: "done" }),
        (e) => {
          tell({ active: false, line: "", error: (e as Error).message });
          throw e;
        },
      ).finally(() => pulling.delete(image));
      pulling.set(image, (going = current));
    }
    if (onProgress) {
      going.listeners.add(onProgress);
      onProgress(going.last);
    }
    try {
      await going.done;
    } finally {
      if (onProgress) going.listeners.delete(onProgress);
    }
  }

  type RawVolume = { Name: string; Labels?: Record<string, string> | null };
  const volumeOwner = (volume: RawVolume) => volume.Labels?.[OWNER_LABEL] ?? adopted().volumes[volume.Name] ?? "";
  async function volumes(): Promise<VolumeInfo[]> {
    const { Volumes } = await checked<{ Volumes: RawVolume[] | null }>("GET", "/volumes");
    return (Volumes ?? []).map((v) => ({ name: v.Name, owner: volumeOwner(v) })).filter((v) => v.owner);
  }
  async function volume(name: string): Promise<RawVolume | undefined> {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    const { status, body } = await request<RawVolume & { message?: string }>("GET", `/volumes/${encodeURIComponent(name)}`);
    if (status === 404) return undefined;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body;
  }
  async function ownVolume(who: string, name: string): Promise<RawVolume | undefined> {
    const found = await volume(name);
    if (!found) return undefined;
    const owner = volumeOwner(found);
    if (owner !== who) throw new DockerError(owner ? `${name} is ${owner}'s volume, not ${who}'s` : `${name} is no extension's volume: take it over first (adopt)`, 403);
    return found;
  }
  async function removeVolume(name: string): Promise<void> {
    const { status, body } = await request<{ message?: string }>("DELETE", `/volumes/${encodeURIComponent(name)}`);
    if (status >= 400 && status !== 404) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    const was = adopted();
    if (name in was.volumes) {
      delete was.volumes[name];
      keep(was);
    }
  }

  /** What one extension is given: its own containers and volumes, by its name. */
  function forExtension(who: string): Docker {
    return {
      available: async () => socketThere() && (await ping()),
      sharedNetwork: () => sharedNetwork(),
      images: {
        present: async (image) => (await request("GET", `/images/${encodeURIComponent(image)}/json`)).status === 200,
        ensure,
      },
      containers: {
        list: async () => (await containers()).filter((c) => c.owner === who),
        get,
        async create(name, spec) {
          if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
          // By its id: one taken over is kept by its id, and let go of when it is removed.
          const was = await own(who, name);
          if (was) await act(was.Id, "remove");
          const labels = { ...((spec.Labels as Record<string, string> | undefined) ?? {}), [OWNER_LABEL]: who };
          await checked("POST", `/containers/create?name=${encodeURIComponent(name)}`, { ...spec, Labels: labels });
          return (await get(name))!;
        },
        async start(name) {
          const found = await own(who, name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          await act(found.Id, "start");
        },
        async stop(name) {
          const found = await own(who, name);
          if (found) await act(found.Id, "stop");
        },
        async remove(name) {
          const found = await own(who, name);
          if (found) await act(found.Id, "remove");
        },
        async logs(name, options) {
          const found = await own(who, name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          return logs(found.Id, Math.min(Math.max(1, Math.floor(options?.tail ?? TAIL)), MOST_TAIL), Boolean(found.Config?.Tty));
        },
        // Docker's whole answer: how it was made, and how it stands.
        inspect: (name) => own(who, name),
        async update(name, changes) {
          const found = await own(who, name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          await checked("POST", `/containers/${encodeURIComponent(found.Id)}/update`, changes);
        },
        async exec(name, cmd, options = {}) {
          const found = await own(who, name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          const tty = Boolean(options.tty);
          // Docker refuses one in a container that is not running.
          const made = await checked<{ Id: string }>("POST", `/containers/${encodeURIComponent(found.Id)}/exec`, {
            Cmd: cmd,
            Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
            WorkingDir: options.workingDir,
            AttachStdout: true,
            AttachStderr: true,
            Tty: tty,
          });
          return exec(made.Id, tty, options.timeoutMs ?? 0);
        },
        async adopt(name) {
          const found = await inspect(name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          const owner = containerOwner(found.Id, found.Config?.Labels);
          if (owner && owner !== who) throw new DockerError(`${name} is ${owner}'s container, not ${who}'s`, 403);
          if (!owner) {
            const was = adopted();
            was.containers[found.Id] = who;
            keep(was);
          }
          return (await get(name))!;
        },
      },
      volumes: {
        list: async () => (await volumes()).filter((v) => v.owner === who),
        async create(name) {
          if (await ownVolume(who, name)) return;
          await checked("POST", "/volumes/create", { Name: name, Labels: { [OWNER_LABEL]: who } });
        },
        async remove(name) {
          if (await ownVolume(who, name)) await removeVolume(name);
        },
        async adopt(name) {
          const found = await volume(name);
          if (!found) throw new DockerError(`There is no volume ${name}`, 404);
          const owner = volumeOwner(found);
          if (owner && owner !== who) throw new DockerError(`${name} is ${owner}'s volume, not ${who}'s`, 403);
          if (!owner) {
            const was = adopted();
            was.volumes[name] = who;
            keep(was);
          }
        },
      },
    };
  }

  /** What the person is shown and may do: every extension's containers and volumes. */
  const person = {
    async overview() {
      if (!socketThere()) return { available: false as const, socket: false };
      if (!(await ping())) return { available: false as const, socket: true };
      const version = await checked<{ Version?: string }>("GET", "/version").catch(() => ({ Version: undefined }));
      return { available: true as const, version: version.Version ?? "", containers: await containers(), volumes: await volumes() };
    },
    /** A container of an extension's, for the person to act on: one that is no extension's is not shown, and not theirs to act on here. */
    async container(name: string): Promise<Inspected> {
      const found = await inspect(name);
      if (!found || !containerOwner(found.Id, found.Config?.Labels)) throw new DockerError(`There is no container ${name} of an extension's`, 404);
      return found;
    },
    start: async (name: string) => act((await person.container(name)).Id, "start"),
    stop: async (name: string) => act((await person.container(name)).Id, "stop"),
    remove: async (name: string) => act((await person.container(name)).Id, "remove"),
    async logs(name: string, tail = TAIL) {
      const found = await person.container(name);
      return logs(found.Id, Math.min(Math.max(1, Math.floor(tail)), MOST_TAIL), Boolean(found.Config?.Tty));
    },
    async removeVolume(name: string) {
      const found = await volume(name);
      if (!found || !volumeOwner(found)) throw new DockerError(`There is no volume ${name} of an extension's`, 404);
      await removeVolume(name);
    },
  };

  return { forExtension, person };
}
