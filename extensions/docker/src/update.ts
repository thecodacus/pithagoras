import type { ContainerSpec, ImageWarning, WantedImage } from "./api";

/**
 * Making a container again on another image (docker.ts, `person.updateImage`): what the container is made with this
 * time, and whether its image is the one its extension wants. Docker has no call that changes a container's image, so
 * the container is made again from how it was made, which its inspect gives back.
 */

/** Of Docker's inspect of a container, what is read here. */
export type ContainerBody = {
  Id: string;
  Name: string;
  /** The id of the image it runs: what the reference it was made with pointed to then. */
  Image?: string;
  Config?: {
    Image?: string;
    Hostname?: string;
    Domainname?: string;
    Tty?: boolean;
    Labels?: Record<string, string> | null;
  } & Record<string, unknown>;
  HostConfig?: { NetworkMode?: string; Binds?: string[] | null; Mounts?: { Type?: string; Source?: string; Target?: string }[] | null; PortBindings?: Record<string, unknown> | null } & Record<string, unknown>;
  State?: { Status?: string; Running?: boolean; Restarting?: boolean; ExitCode?: number; Error?: string };
  Mounts?: { Type?: string; Name?: string; Destination?: string; RW?: boolean }[] | null;
  NetworkSettings?: { Networks?: Record<string, EndpointBody> | null };
};
type EndpointBody = { NetworkID?: string; IPAMConfig?: unknown; Links?: string[] | null; Aliases?: string[] | null; DriverOpts?: Record<string, string> | null };

/** Of Docker's inspect of an image, what its containers inherit from it. */
export type ImageConfig = {
  Env?: string[] | null;
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  WorkingDir?: string;
  User?: string;
  ExposedPorts?: Record<string, unknown> | null;
  Volumes?: Record<string, unknown> | null;
  Labels?: Record<string, string> | null;
  Healthcheck?: unknown;
  StopSignal?: string;
  Shell?: string[] | null;
  OnBuild?: string[] | null;
};

/** Docker's own networks, which a container is on without naming them. */
const OWN = new Set(["bridge", "host", "none", "default"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** What a container has of its own: nothing where it is what its image gives, so that a new image's is what it gets. */
const ownOf = <T>(mine: T, image: T): T | undefined => (same(mine, image) ? undefined : mine);
/** What a map holds that its image's does not hold the same of, or that is kept all the same; nothing where none is left. */
const beyond = <T>(mine: Record<string, T> | null | undefined, image: Record<string, T> | null | undefined, keep: (key: string) => boolean = () => false) => {
  const left = Object.fromEntries(Object.entries(mine ?? {}).filter(([key, value]) => keep(key) || !same(value, image?.[key])));
  return Object.keys(left).length ? left : undefined;
};

/** The folders a container has something mounted in by name, a path or the mount API, as its create body had them. */
const mountedAt = (host: NonNullable<ContainerBody["HostConfig"]>) => new Set([...(host.Binds ?? []).map((bind) => bind.split(":")[1]), ...(host.Mounts ?? []).map((mount) => mount.Target)]);

/**
 * The body that makes `old` again on `image`: how it was made, as its inspect has it, less what it only had from its
 * old image. A container's inspect holds the image's own settings as well (its environment, command, labels, ports,
 * user), and made again with those, the new image's would give way to the old one's. What the old image gives is left
 * out, so that the new one gives it; what the container was given besides is kept. The folders the old container
 * mounted a volume of no name in (an image's `VOLUME`) are mounted on that volume by its name, so that what it holds
 * stays.
 */
export function recreation(old: ContainerBody, oldImage: ImageConfig | undefined, image: string): ContainerSpec {
  const config = old.Config ?? {};
  const host = { ...old.HostConfig };
  const mode = host.NetworkMode ?? "";
  // Another container's network, or the machine's, brings its own host name and ports: a body that names them is refused.
  const shared = mode.startsWith("container:") || mode === "host" || mode === "none";
  const portBound = new Set(Object.keys(host.PortBindings ?? {}));
  const inherited = oldImage ?? {};

  const { Image: _image, MacAddress: _mac, Hostname: hostname, Domainname: domainname, Env: env, Cmd: cmd, Entrypoint: entrypoint, WorkingDir: workingDir, User: user, ExposedPorts: ports, Volumes: volumes, Labels: labels, Healthcheck: healthcheck, StopSignal: stopSignal, Shell: shell, OnBuild: onBuild, ...rest } = config as Record<string, unknown> & ImageConfig & { Hostname?: string; Domainname?: string };
  const envLeft = ((env as string[] | null | undefined) ?? []).filter((entry) => !(inherited.Env ?? []).includes(entry));
  const ownEntrypoint = ownOf(entrypoint, inherited.Entrypoint);
  const body: Record<string, unknown> = {
    ...rest,
    Image: image,
    ...(hostname && hostname !== old.Id.slice(0, 12) && !shared ? { Hostname: hostname } : {}),
    ...(domainname && !shared ? { Domainname: domainname } : {}),
    ...(envLeft.length ? { Env: envLeft } : {}),
    // Docker takes the image's command only where the body names no entrypoint: with one of its own, the command stays as it is.
    Cmd: ownEntrypoint !== undefined ? cmd : ownOf(cmd, inherited.Cmd),
    Entrypoint: ownEntrypoint,
    WorkingDir: ownOf(workingDir, inherited.WorkingDir) || undefined,
    User: ownOf(user, inherited.User) || undefined,
    ExposedPorts: shared ? undefined : beyond(ports, inherited.ExposedPorts, (port) => portBound.has(port)),
    Volumes: beyond(volumes, inherited.Volumes),
    Labels: beyond(labels, inherited.Labels),
    Healthcheck: ownOf(healthcheck, inherited.Healthcheck),
    StopSignal: ownOf(stopSignal, inherited.StopSignal) || undefined,
    Shell: ownOf(shell, inherited.Shell),
    OnBuild: ownOf(onBuild, inherited.OnBuild),
  };

  // A volume made for a folder no create body named is only known by its name now.
  const there = mountedAt(host);
  const binds = [...(host.Binds ?? [])];
  for (const mount of old.Mounts ?? []) {
    if (mount.Type !== "volume" || !mount.Name || !mount.Destination || there.has(mount.Destination)) continue;
    binds.push(`${mount.Name}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`);
  }
  // A volume the mount API made with no source is only known by its name now as well.
  const named = new Map((old.Mounts ?? []).filter((mount) => mount.Type === "volume" && mount.Name && mount.Destination).map((mount) => [mount.Destination, mount.Name] as const));
  const mounts = host.Mounts?.map((mount) => (mount.Type === "volume" && !mount.Source && named.has(mount.Target) ? { ...mount, Source: named.get(mount.Target) } : mount));
  body.HostConfig = { ...host, ...(mounts ? { Mounts: mounts } : {}), ...(binds.length ? { Binds: binds } : {}) };

  const endpoints = shared
    ? {}
    : Object.fromEntries(
        Object.entries(old.NetworkSettings?.Networks ?? {})
          .map(([name, endpoint]) => {
            // Docker gives a container the start of its id as a name on a network of its own: made again, it has another.
            const aliases = (endpoint.Aliases ?? []).filter((alias) => alias !== old.Id.slice(0, 12) && alias !== old.Id);
            const carried = {
              ...(endpoint.IPAMConfig ? { IPAMConfig: endpoint.IPAMConfig } : {}),
              ...(endpoint.Links?.length ? { Links: endpoint.Links } : {}),
              ...(aliases.length ? { Aliases: aliases } : {}),
              ...(endpoint.DriverOpts && Object.keys(endpoint.DriverOpts).length ? { DriverOpts: endpoint.DriverOpts } : {}),
            };
            return [name, carried] as const;
          })
          // Docker's own networks are on by the network mode; they are named only for what the container has there.
          .filter(([name, carried]) => !OWN.has(name) || Object.keys(carried).length > 0),
      );
  if (Object.keys(endpoints).length) body.NetworkingConfig = { EndpointsConfig: endpoints };

  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as ContainerSpec;
}

/**
 * Whether a reference names one version: a digest, or a tag that is not `latest`. No tag is `latest`, which moves on by
 * itself and is not a version anyone asked for; a registry's port (`localhost:5000/app`) is no tag.
 */
export function pinned(image: string): boolean {
  if (image.includes("@")) return true;
  const name = image.slice(image.lastIndexOf("/") + 1);
  const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : "";
  return tag !== "" && tag !== "latest";
}

/**
 * Whether a container runs another image than the one its extension wants, said only for a pinned one (`pinned`): a
 * floating `latest` is never a warning, and neither is a pinned tag that was moved in its registry and downloaded again
 * (the extension asked for the same version still, which the registry rebuilt). `running` is the reference the container
 * was made with, `ran` the id of the image it runs, and `local` the id the wanted reference has here now, none where it
 * is not downloaded: another reference is outdated, unless it is the same image under another name.
 */
export function warning(running: string, ran: string | undefined, wanted: WantedImage, local: string | undefined): ImageWarning | undefined {
  if (!pinned(wanted.image) || running === wanted.image) return undefined;
  if (local && ran && local === ran) return undefined;
  return { running, wanted: wanted.image, ...(wanted.busy ? { busy: wanted.busy } : {}) };
}

/** The names of the containers that share the network of the one with this id and name, from Docker's list of all of them. */
export function sharing(all: { Names?: string[]; HostConfig?: { NetworkMode?: string } }[], id: string, name: string): string[] {
  return all
    .filter((c) => {
      const mode = c.HostConfig?.NetworkMode ?? "";
      return mode.startsWith("container:") && [id, id.slice(0, 12), name].includes(mode.slice("container:".length));
    })
    .map((c) => (c.Names?.[0] ?? "").replace(/^\//, ""));
}
