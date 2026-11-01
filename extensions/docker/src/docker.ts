import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ContainerInfo, ContainerSpec, Docker, ImageUpdate, ImageWarning, NetworkInfo, OverviewContainer, PullState, Reach, VolumeInfo, WantedImage } from "./api";
import { checked, DockerError, exec, logs, ping, pull, request, socketThere } from "./engine";
import { FORWARD_SPEC_LABEL, FORWARDER_IMAGE, FORWARDS_LABEL, forwarderName, forwarderSpec, forwarderWish } from "./forward";
import { type ContainerBody, type ImageConfig, pinned, recreation, sharing, warning } from "./update";

/**
 * Docker as each extension is given it (api.ts), and as the person sees it all (`overview`). What is whose is the label
 * an extension's containers, volumes and networks are made with (OWNER_LABEL), or, for a container or a volume it took
 * over, what is kept in this extension's own folder (`adopted.json`): a container's labels cannot be changed once it is
 * made, and one taken over is kept by its id, so that one made again under its name by someone else is not taken for
 * it. A network is the extension's by its label alone: none was made before there were extensions.
 */

/** The label that says which extension a container, a volume or a network is. */
export const OWNER_LABEL = "pithagoras.extension";

type Raw = { Id: string; Names?: string[]; Image: string; State: string; Status: string; Labels?: Record<string, string> | null };
type Inspected = ContainerBody;
type Adopted = { containers: Record<string, string>; volumes: Record<string, string> };
/** The portal's own container, as much of Docker's inspect as is read of it. */
type PortalContainer = { Id: string; HostConfig?: { NetworkMode?: string }; NetworkSettings?: Inspected["NetworkSettings"] };

/** The driver option that sets how a bridge network's IPv4 gateway works: `isolated` gives it none. */
const GATEWAY_MODE = "com.docker.network.bridge.gateway_mode_ipv4";
type RawNetwork = {
  Id: string;
  Name: string;
  Internal?: boolean;
  EnableIPv6?: boolean;
  Options?: Record<string, string> | null;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] | null };
  Labels?: Record<string, string> | null;
  /** The containers on it now, by their ids: those running. */
  Containers?: Record<string, { Name?: string }> | null;
};
/**
 * A network that has no way out: internal, so that Docker routes nothing from it to anywhere else, and in the gateway
 * mode `isolated`, with no IPv6, so that the machine has no address on it either, and so no gateway: a plain internal
 * network leaves every service the machine listens for on 0.0.0.0 open through its bridge's address. The machine's side
 * of the bridge still has an IPv6 link-local address (fe80::), as every bridge of Docker's has, whatever the network;
 * with no IPv6 on the network, Docker turns IPv6 off on each container's interface on it (its
 * `net.ipv6.conf.<interface>.disable_ipv6`), so that a container has no IPv6 there but its own loopback, and code in it
 * cannot turn it on again, as a container's /proc/sys is read-only. A create body that turns it on (the endpoint's
 * driver option `com.docker.network.endpoint.sysctls`) gives the container that way to the machine back.
 */
const noWayOut = (n: RawNetwork) => n.Internal === true && n.EnableIPv6 !== true && n.Options?.[GATEWAY_MODE] === "isolated" && !(n.IPAM?.Config ?? []).some((c) => c.Gateway);
const wayOut = (name: string) => new DockerError(`${name} has a way out to the machine, which an extension's network may not have: remove it, and it is made again`, 409);

/** Docker's own networks, which no extension makes and every container may be on: the default bridge, the machine's, and none. */
const DOCKERS_OWN = new Set(["bridge", "host", "none"]);

/** How long what an update came to, or why it failed, is told on Docker's page. */
const UPDATE_SHOWN_MS = 10 * 60_000;
/** An update of a container's image, as the page is told of it. */
type Tracked = ImageUpdate & { ended?: number };
/** How long a container made again on a new image has to stay up for the update to count: a start Docker accepts is not one that works. */
const SETTLE_MS = 3_000;

/** An update that failed after the old container was renamed, and could not name it back: `stranded` is the name it still has. */
class SwapFailed extends DockerError {
  constructor(message: string, status: number, readonly stranded?: string) {
    super(message, status);
  }
}

/** How much of what a container wrote `logs` gives, unless asked for another amount, and the most it gives. */
const TAIL = 200;
const MOST_TAIL = 5_000;

const nameOf = (raw: Raw) => (raw.Names?.[0] ?? "").replace(/^\//, "");
/** A name Docker takes for a container or a volume. */
const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);

/**
 * The portal's running container, as Docker has it: the one `PORTAL_CONTAINER_NAME` names, or else `HOSTNAME`, where the
 * portal runs in a container or the name is set; nothing for a portal on the machine itself. Whether the portal runs
 * in a container is the portal's own unless a test gives it.
 */
export async function portalContainer(inContainer = existsSync("/.dockerenv")): Promise<PortalContainer | undefined> {
  if (!inContainer && !process.env.PORTAL_CONTAINER_NAME) return undefined;
  const name = process.env.PORTAL_CONTAINER_NAME || process.env.HOSTNAME;
  if (!name) throw new Error("Set PORTAL_CONTAINER_NAME to the portal Docker container name.");
  const detail = await request<PortalContainer & { State?: { Running?: boolean } }>("GET", `/containers/${encodeURIComponent(name)}/json`);
  if (detail.status !== 200 || !detail.body?.Id || !detail.body.State?.Running) {
    throw new Error("Cannot identify the running portal container. Set PORTAL_CONTAINER_NAME to its Docker name.");
  }
  return detail.body;
}

/**
 * The network mode that puts a container on the portal's own loopback (api.ts): `host` for a portal on the machine itself
 * (Linux only), else `container:<id>` of the portal's running container (`portalContainer`). Whether the portal runs in
 * a container, and on which system, are the portal's own unless a test gives them.
 */
export async function sharedNetwork(inContainer = existsSync("/.dockerenv"), platform = process.platform): Promise<string> {
  const portal = await portalContainer(inContainer);
  if (portal) return `container:${portal.Id}`;
  if (platform !== "linux") throw new Error("A container shares the network of a portal on the machine itself only on Linux. Run the portal in Docker on this platform.");
  return "host";
}

/** Docker for each extension, and for the person, with what it keeps in `dataDir`. Whether the portal runs in a container is the portal's own unless a test gives it. */
export function dockerFor(dataDir: string, inContainer = existsSync("/.dockerenv"), settleMs = SETTLE_MS) {
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

  /** What each extension says its containers should run (api.ts, `wantImage`), and the updates under way or lately done, by the container's name. */
  const wants = new Map<string, (container: ContainerInfo) => WantedImage | undefined>();
  const updates = new Map<string, Tracked>();
  /**
   * The names of the containers an update is swapping just now (the container's and the one it is renamed to): no one else
   * makes, starts, stops or removes them meanwhile, as the update works on the container it checked.
   */
  const swapping = new Set<string>();
  const notSwapping = (name: string) => {
    if (swapping.has(name)) throw new DockerError(`${name} is being updated: wait until that is done`, 409);
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

  /**
   * Why `who` may not have made the container `name` as Docker made it (`made`), where it may not: it is on a network
   * that is not the extension's own (another extension's, or nobody's), Docker's own aside, or shares the network of a
   * container that is neither the extension's own nor the portal's. Read back from Docker, which has found what the
   * create body named (a name, an id or the start of one, `default`), and keeps the network by its name and the
   * container by its id. A container to share that is not there is refused too: Docker keeps that one by the name it
   * was given, and the container made would share the network of whichever is made under that name later.
   */
  async function notWhosToMake(who: string, name: string, made: Inspected): Promise<string | undefined> {
    for (const net of Object.keys(made.NetworkSettings?.Networks ?? {})) {
      if (DOCKERS_OWN.has(net)) continue;
      const found = await network(net);
      const owner = found ? networkOwner(found) : "";
      if (owner !== who) return `${name} would be on ${net}, which is ${owner ? `${owner}'s network` : "no extension's network"}, not ${who}'s`;
    }
    const mode = made.HostConfig?.NetworkMode ?? "";
    if (!mode.startsWith("container:")) return undefined;
    const to = mode.slice("container:".length);
    const shared = await inspect(to);
    if (!shared) return `${name} would share the network of ${to}, which there is no container of`;
    if (containerOwner(shared.Id, shared.Config?.Labels) === who || shared.Id === (await portalContainer(inContainer))?.Id) return undefined;
    return `${name} would share the network of ${shared.Name.replace(/^\//, "")}, which is neither ${who}'s container nor the portal's`;
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

  /** Whether an image is a chat's own build, which carries the label of the extension that built it: no extension's wish names one. */
  const chats = (image: { Config?: ImageConfig }) => Boolean(image.Config?.Labels?.[OWNER_LABEL]);

  /** An image by its reference or id, as Docker has it: nothing where it is not downloaded. */
  async function imageInfo(image: string): Promise<{ Id: string; Config?: ImageConfig } | undefined> {
    const { status, body } = await request<{ Id: string; Config?: ImageConfig; message?: string }>("GET", `/images/${encodeURIComponent(image)}/json`);
    if (status === 404) return undefined;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body;
  }

  /**
   * How `container`'s image is not the one its extension wants (api.ts, `wantImage`): nothing where it has no wish, where
   * the wish is not a pinned image (`pinned`), or where the wish cannot be told, which a failing extension is not to
   * take Docker's page down with. A forwarder is Docker's own, and its wish is the image it makes forwarders on.
   */
  async function outdated(container: ContainerInfo): Promise<ImageWarning | undefined> {
    let asked: unknown;
    try {
      asked = forwarderWish(container) ?? wants.get(container.owner)?.(container);
    } catch {
      return undefined;
    }
    // A wish is a plain answer: one from an extension's isolated half is a promise, which is no wish, and is not left to reject unheard.
    if (typeof (asked as { then?: unknown } | undefined)?.then === "function") {
      void Promise.resolve(asked).catch(() => {});
      return undefined;
    }
    const wanted = asked as WantedImage | undefined;
    if (!wanted || typeof wanted.image !== "string" || !wanted.image || (wanted.busy !== undefined && typeof wanted.busy !== "string")) return undefined;
    // Before Docker is asked anything: a floating image is never a warning.
    if (!pinned(wanted.image)) return undefined;
    const found = await inspect(container.id);
    if (!found) return undefined;
    // A reference a chat's build took over is not the image that was downloaded under it.
    const local = await imageInfo(wanted.image);
    return warning(found.Config?.Image ?? container.image, found.Image, wanted, local && !chats(local) ? local.Id : undefined);
  }

  /** One download for an image at a time, whoever asks: the others are told how it goes too. */
  const pulling = new Map<string, { done: Promise<void>; listeners: Set<(state: PullState) => void>; last: PullState }>();
  async function ensureImage(image: string, onProgress?: (state: PullState) => void, replaceBuild = false): Promise<void> {
    const have = await imageInfo(image);
    // Where a chat's build holds the reference, an update downloads the image all the same, which takes the reference back.
    if (have && !(replaceBuild && chats(have))) return;
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

  /** A network by its name: nothing where there is none, or where Docker answered for another (its inspect also takes an id, or the start of one). */
  async function network(name: string): Promise<RawNetwork | undefined> {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    const { status, body } = await request<RawNetwork & { message?: string }>("GET", `/networks/${encodeURIComponent(name)}`);
    if (status === 404) return undefined;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body.Name === name ? body : undefined;
  }
  const networkOwner = (n: RawNetwork) => n.Labels?.[OWNER_LABEL] ?? "";
  const networkInfo = (n: RawNetwork): NetworkInfo => ({ name: n.Name, id: n.Id, owner: networkOwner(n) });
  /** The network `name` is, for `who` to act on: refused where it is someone else's, or nobody's. Nothing where there is none. */
  async function ownNetwork(who: string, name: string): Promise<RawNetwork | undefined> {
    const found = await network(name);
    if (!found) return undefined;
    const owner = networkOwner(found);
    if (owner !== who) throw new DockerError(owner ? `${name} is ${owner}'s network, not ${who}'s` : `${name} is no extension's network`, 403);
    return found;
  }
  /** A network gone, by its id: Docker's no passed on (403 while a container is on it), and one gone already is gone. */
  async function removeNetwork(id: string): Promise<void> {
    const { status, body } = await request<{ message?: string }>("DELETE", `/networks/${encodeURIComponent(id)}`);
    if (status >= 400 && status !== 404) throw new DockerError(body?.message || `Docker answered ${status}`, status);
  }

  /**
   * The portal's container put on `island`, where it is not on it yet. Docker refuses one that is on it already (403):
   * the refusal counts as done where the container, read again, is on it, which is checked rather than read from
   * Docker's words, which are Docker's to change.
   */
  async function connect(island: RawNetwork, portal: PortalContainer): Promise<void> {
    if (portal.NetworkSettings?.Networks?.[island.Name]) return;
    const { status, body } = await request<{ message?: string }>("POST", `/networks/${encodeURIComponent(island.Id)}/connect`, { Container: portal.Id });
    if (status < 400) return;
    if ((await inspect(portal.Id))?.NetworkSettings?.Networks?.[island.Name]) return;
    throw new DockerError(body?.message || `Docker answered ${status}`, status);
  }

  /**
   * The forwarder to `port` of `container` on `island` (forward.ts), as it would be made now, and running: its own
   * network made where it is not there, kept where it is; the forwarder made again where its mark is not the one it
   * would be made with now, or where there is none, and started (Docker answers a start of one that runs with 304).
   * Its start fails in Docker's words where 127.0.0.1:`port` is taken.
   */
  async function forwarder(who: string, island: RawNetwork, container: string, port: number): Promise<void> {
    const name = forwarderName(container);
    // Not internal: Docker publishes no port of a container that is only on internal networks.
    const door = (await ownNetwork(who, name)) ?? {
      Name: name,
      Id: (await checked<{ Id: string }>("POST", "/networks/create", { Name: name, Driver: "bridge", Labels: { [OWNER_LABEL]: who, [FORWARDS_LABEL]: island.Name } })).Id,
    };
    const spec = forwarderSpec(container, port, island, door);
    const mine = forExtension(who);
    if ((await own(who, name))?.Config?.Labels?.[FORWARD_SPEC_LABEL] !== spec.Labels[FORWARD_SPEC_LABEL]) {
      await ensureImage(FORWARDER_IMAGE);
      await mine.containers.create(name, spec);
    }
    await mine.containers.start(name);
  }

  /** The forwarder of `container` gone, with its own network, where there is one: for a portal that needs none, it would hold the port for nothing. */
  async function dropForwarder(who: string, container: string): Promise<void> {
    const name = forwarderName(container);
    const was = await own(who, name);
    if (was) await act(was.Id, "remove");
    const door = await ownNetwork(who, name);
    if (door) await removeNetwork(door.Id);
  }

  /** Where the portal reaches `port` of `container` on the network `name`, with what that takes put right (api.ts, `networks.reach`). */
  async function reach(who: string, name: string, container: string, port: number): Promise<Reach> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DockerError(`${port} is not a port`);
    const island = await ownNetwork(who, name);
    if (!island) throw new DockerError(`There is no network ${name}`, 404);
    if (!noWayOut(island)) throw wayOut(name);
    const found = await own(who, container);
    if (!found) throw new DockerError(`There is no container ${container}`, 404);
    if (!found.NetworkSettings?.Networks?.[name]) throw new DockerError(`${container} is not on ${name}`, 409);
    const portal = await portalContainer(inContainer);
    const mode = portal?.HostConfig?.NetworkMode;
    if (mode?.startsWith("container:")) {
      throw new DockerError("The portal's container shares the network of another container, to which no network can be added: run the portal with a network of its own, or on the machine's (network_mode: host).", 409);
    }
    if (portal && mode !== "host") {
      await dropForwarder(who, container);
      await connect(island, portal);
      return { host: container, port };
    }
    await forwarder(who, island, container, port);
    return { host: "127.0.0.1", port };
  }

  /** One reach at a time for a container, whoever asks: two at once would each make its forwarder and its network. */
  const reaching = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (reaching.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    reaching.set(key, next);
    void next.catch(() => {}).finally(() => reaching.get(key) === next && reaching.delete(key));
    return next;
  }

  /** A container of `who`'s made under `name`, in place of one of theirs by that name. */
  async function make(who: string, name: string, spec: ContainerSpec): Promise<ContainerInfo> {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    // By its id: one taken over is kept by its id, and let go of when it is removed.
    const was = await own(who, name);
    if (was) await act(was.Id, "remove");
    const labels = { ...((spec.Labels as Record<string, string> | undefined) ?? {}), [OWNER_LABEL]: who };
    const { Id } = await checked<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, { ...spec, Labels: labels });
    const refused = await notWhosToMake(who, name, (await inspect(Id))!);
    if (refused) {
      await act(Id, "remove");
      throw new DockerError(refused, 403);
    }
    return (await get(name))!;
  }

  /** What one extension is given: its own containers, volumes and networks, by its name. */
  function forExtension(who: string): Docker {
    return {
      available: async () => socketThere() && (await ping()),
      sharedNetwork: () => sharedNetwork(inContainer),
      images: {
        present: async (image) => (await request("GET", `/images/${encodeURIComponent(image)}/json`)).status === 200,
        ensure: (image, onProgress) => ensureImage(image, onProgress),
      },
      containers: {
        list: async () => (await containers()).filter((c) => c.owner === who),
        get,
        async create(name, spec) {
          notSwapping(name);
          return make(who, name, spec);
        },
        async start(name) {
          notSwapping(name);
          const found = await own(who, name);
          if (!found) throw new DockerError(`There is no container ${name}`, 404);
          await act(found.Id, "start");
        },
        async stop(name) {
          notSwapping(name);
          const found = await own(who, name);
          if (found) await act(found.Id, "stop");
        },
        async remove(name) {
          notSwapping(name);
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
        wantImage(wanted) {
          wants.set(who, wanted);
        },
        async outdated(name) {
          if (!(await own(who, name))) return undefined;
          const info = await get(name);
          return info && outdated(info);
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
      networks: {
        async create(name) {
          const there = await ownNetwork(who, name);
          if (there) {
            if (!noWayOut(there)) throw wayOut(name);
            return networkInfo(there);
          }
          const { Id } = await checked<{ Id: string }>("POST", "/networks/create", {
            Name: name,
            Driver: "bridge",
            Internal: true,
            EnableIPv6: false,
            Options: { [GATEWAY_MODE]: "isolated" },
            Labels: { [OWNER_LABEL]: who },
          });
          // What Docker made, read back: one older than 28.0 may make it with a gateway, the option ignored.
          const made = await checked<RawNetwork>("GET", `/networks/${encodeURIComponent(Id)}`);
          if (!noWayOut(made)) {
            await removeNetwork(Id);
            throw new DockerError("This Docker cannot make a network with no way out: that takes Docker Engine 28.0 or later.");
          }
          return networkInfo(made);
        },
        async get(name) {
          const found = await network(name);
          return found && networkInfo(found);
        },
        reach: (name, container, port) => oneAtATime(`${who}\n${container}`, () => reach(who, name, container, port)),
        async remove(name) {
          const island = await ownNetwork(who, name);
          if (!island) return;
          // The forwarders that lead onto it, and their own networks: by their labels.
          const of = encodeURIComponent(JSON.stringify({ label: [`${OWNER_LABEL}=${who}`, `${FORWARDS_LABEL}=${name}`] }));
          for (const c of await checked<Raw[]>("GET", `/containers/json?all=1&filters=${of}`)) await act(c.Id, "remove");
          for (const n of await checked<RawNetwork[]>("GET", `/networks?filters=${of}`)) await removeNetwork(n.Id);
          const portal = await portalContainer(inContainer);
          if (portal && island.Containers?.[portal.Id]) await checked("POST", `/networks/${encodeURIComponent(island.Id)}/disconnect`, { Container: portal.Id, Force: true });
          await removeNetwork(island.Id);
        },
      },
    };
  }

  async function rename(id: string, name: string): Promise<void> {
    await checked("POST", `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
  }

  /**
   * `old` made again on `image` (the image `expect`, which is what the reference is here), as `recreation` has it made,
   * and started if it was running: made under its name once the old one is out of the way under another, and the old
   * one removed once the new one has stayed up. Where anything fails before that, the new one is removed again and the
   * old one has its name back, and runs again if it ran: it is stopped only after the new one is made, so a refusal of
   * the new one's body leaves it running all along. It answers with the old one's name where that one could not be
   * removed, which leaves it stopped.
   */
  async function swap(old: Inspected, image: string, expect: string): Promise<{ leftover?: string }> {
    const who = containerOwner(old.Id, old.Config?.Labels);
    if (!who) throw new DockerError(`${old.Name.replace(/^\//, "")} is no extension's container any more`, 409);
    const name = old.Name.replace(/^\//, "");
    // The name it waits under: one an unfinished update left of this extension's stops a new one, while another's container by that name only makes it pick another.
    let before = `${name}-before-update`;
    const there = await inspect(before);
    if (there && containerOwner(there.Id, there.Config?.Labels) === who) throw new DockerError(`${before} is there already, left by an update that did not finish: remove it first`, 409);
    if (there) before = `${before}-${randomBytes(3).toString("hex")}`;
    swapping.add(before);
    try {
      const spec = recreation(old, (await imageInfo(old.Image ?? ""))?.Config, image);
      const ran = old.State?.Running === true;
      await rename(old.Id, before);
      // Whatever fails from here, the old one has its name back, and runs again if it ran; and what is made is removed.
      const putBack = async (e: unknown, made?: string) => {
        if (made) await act(made, "remove").catch(() => {});
        const named = await rename(old.Id, name).then(
          () => true,
          () => false,
        );
        if (ran) await act(old.Id, "start").catch(() => {});
        return new SwapFailed(`${(e as Error).message}${named ? "" : ` It is still named ${before}.`}`, e instanceof DockerError ? e.status : 0, named ? undefined : before);
      };
      let made: ContainerInfo;
      try {
        made = await make(who, name, spec);
      } catch (e) {
        throw await putBack(e);
      }
      try {
        // The reference may have been given to another image since it was checked.
        if ((await inspect(made.id))?.Image !== expect) throw new DockerError(`${image} is another image now than the one that was downloaded`, 409);
        if (ran) {
          await act(old.Id, "stop");
          await act(made.id, "start");
          // Docker takes a start whose command fails a moment later: it has to stay up.
          await sleep(settleMs);
          const state = (await inspect(made.id))?.State;
          if (!state?.Running || state.Restarting) throw new DockerError(`${name} did not stay up on ${image}: ${state?.Error || `it ${state?.Status ?? "is gone"}, exit code ${state?.ExitCode ?? "unknown"}`}`, 409);
        }
      } catch (e) {
        throw await putBack(e, made.id);
      }
      try {
        await act(old.Id, "remove");
      } catch {
        return { leftover: before };
      }
      return {};
    } finally {
      swapping.delete(before);
    }
  }

  /** What the person is shown and may do: every extension's containers and volumes. */
  const person = {
    async overview() {
      if (!socketThere()) return { available: false as const, socket: false };
      if (!(await ping())) return { available: false as const, socket: true };
      const version = await checked<{ Version?: string }>("GET", "/version").catch(() => ({ Version: undefined }));
      const now = Date.now();
      const all: OverviewContainer[] = await Promise.all(
        (await containers()).map(async (c) => {
          const tracked = updates.get(c.name);
          if (tracked?.ended && now - tracked.ended > UPDATE_SHOWN_MS) updates.delete(c.name);
          const { ended: _ended, ...update } = updates.get(c.name) ?? {};
          // A Docker that hiccups on one container's image does not take the page down.
          const imageWarning = await outdated(c).catch(() => undefined);
          return { ...c, ...(imageWarning ? { imageWarning } : {}), ...(updates.has(c.name) ? { update: update as ImageUpdate } : {}) };
        }),
      );
      return { available: true as const, version: version.Version ?? "", containers: all, volumes: await volumes() };
    },
    /** A container of an extension's, for the person to act on: one that is no extension's is not shown, and not theirs to act on here. */
    async container(name: string): Promise<Inspected> {
      const found = await inspect(name);
      if (!found || !containerOwner(found.Id, found.Config?.Labels)) throw new DockerError(`There is no container ${name} of an extension's`, 404);
      return found;
    },
    start: async (name: string) => act((await person.settled(name)).Id, "start"),
    stop: async (name: string) => act((await person.settled(name)).Id, "stop"),
    remove: async (name: string) => act((await person.settled(name)).Id, "remove"),
    /** `container`, once no update is swapping it. */
    async settled(name: string): Promise<Inspected> {
      notSwapping(name);
      const found = await person.container(name);
      notSwapping(found.Name.replace(/^\//, ""));
      return found;
    },
    /**
     * The image of a container made again as its extension wants it, in the background: refused here, in Docker's words,
     * where there is nothing to update, where the extension says the container is in use, where another container
     * shares its network (it would lose it), or while it is being updated. Otherwise the wanted image is downloaded if
     * it is not, and the container made again with the same settings, mounts, networks and volumes; what it comes to is
     * in the overview (`update`). Where it fails, the container is as it was.
     */
    async updateImage(name: string): Promise<void> {
      const found = await person.container(name);
      const mine = found.Name.replace(/^\//, "");
      if (updates.get(mine)?.active) throw new DockerError(`${mine} is being updated already`, 409);
      // Claimed before anything is awaited again: two requests at once would each swap it.
      updates.set(mine, { active: true, line: "starting" });
      const refuse = (message: string) => new DockerError(message, 409);
      let started = false;
      try {
        const info = await get(mine);
        const asked = info && (await outdated(info));
        if (!info || !asked) throw refuse(`${mine} runs the image its extension wants`);
        if (asked.busy) throw refuse(`${mine} is in use: ${asked.busy}`);
        const sharers = sharing(await checked<Parameters<typeof sharing>[0]>("GET", "/containers/json?all=1"), found.Id, mine);
        if (sharers.length) throw refuse(`${sharers.join(", ")} share${sharers.length === 1 ? "s" : ""} the network of ${mine}, which ${sharers.length === 1 ? "it" : "they"} would lose: remove ${sharers.length === 1 ? "it" : "them"} first`);
        started = true;
        void (async () => {
          try {
            await ensureImage(
              asked.wanted,
              (state) => {
                if (state.active && state.line !== "starting") updates.set(mine, { active: true, line: state.line });
              },
              true,
            );
            const local = await imageInfo(asked.wanted);
            if (!local || chats(local)) throw new DockerError(`${asked.wanted} is not the image that was downloaded`, 409);
            updates.set(mine, { active: true, line: "replacing the container" });
            // From here on, no one else works on it; and what was checked before the download is checked again, as a download takes minutes.
            swapping.add(mine);
            const now = await inspect(mine);
            const again = await get(mine);
            const askedAgain = again && (await outdated(again));
            if (!now || now.Id !== found.Id || !again || again.owner !== info.owner) throw refuse(`${mine} was replaced while the image was downloaded`);
            if (!askedAgain) throw refuse(`${mine} runs the image its extension wants now`);
            if (askedAgain.wanted !== asked.wanted) throw refuse(`${mine}'s extension wants ${askedAgain.wanted} now, not ${asked.wanted}`);
            if (askedAgain.busy) throw refuse(`${mine} is in use now: ${askedAgain.busy}`);
            const { leftover } = await swap(now, asked.wanted, local.Id);
            updates.set(mine, { active: false, line: "", done: { from: asked.running, to: asked.wanted }, ...(leftover ? { leftover } : {}), ended: Date.now() });
          } catch (e) {
            const failed = { active: false, line: "", error: (e as Error).message, ended: Date.now() };
            // An old container that could not be named back is the row to tell it on: the name is no container's now.
            if (e instanceof SwapFailed && e.stranded) updates.set(e.stranded, { ...failed, stranded: true });
            else updates.set(mine, failed);
          } finally {
            swapping.delete(mine);
          }
        })();
      } catch (e) {
        if (!started) updates.delete(mine);
        throw e;
      }
    },
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
