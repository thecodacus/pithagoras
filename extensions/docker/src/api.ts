/**
 * What Docker gives an extension that builds on it: name `pithagoras-docker` in `pithagoras.requires` (or `optional`)
 * in its package.json, and ask for it with `portal.extensions.use<Docker>("pithagoras-docker")`.
 *
 * Each extension has its own: the containers, volumes and networks it makes carry its name, and it may start, stop,
 * change, remove, read and run commands in only those, and the ones it took over (`adopt`). Another extension's are not its to touch, and
 * neither is a container nobody made through here until one takes it over. The person sees all of them in Settings →
 * Docker, by the extension that runs each, and may stop or remove any.
 *
 * A server half runs with the portal's own rights, and Docker's socket is root on the machine: what a container is made
 * with (`spec`, Docker's own create body) is the extension's to choose. This keeps extensions apart, and shows the person
 * what each runs; it does not make one safe that is not.
 */

/**
 * How a call fails where Docker said no, or was not reached: an Error with `status`. That is Docker's own HTTP status
 * where it gave one (403 and 404 among them, for a container that is not the extension's or that there is none of, and
 * 409 where `networks.reach` cannot be given: below), and 0 where Docker was not reached or gave no HTTP status: there
 * is no socket, it did not answer in time, its answer was cut off partway, the name is not one Docker takes, a
 * download failed partway, or a Docker older than 28.0 made a network with a way out (`networks.create`).
 */
export interface DockerError extends Error {
  status: number;
}

/** A container as Docker has it now. */
export interface ContainerInfo {
  /** Its name, as Docker knows it (no leading slash). */
  name: string;
  id: string;
  image: string;
  /** Docker's word for it: created, running, paused, restarting, removing, exited or dead. */
  state: string;
  /** What Docker says of it, in its own words: "Up 3 hours", "Exited (0) 2 minutes ago". */
  status: string;
  /** The extension it belongs to. */
  owner: string;
  /** Its labels as it was made with them, the one that says whose it is among them: what an extension wrote there to know it by. */
  labels: Record<string, string>;
}

/** A volume, and the extension it belongs to. */
export interface VolumeInfo {
  name: string;
  owner: string;
}

/** A network of an extension's, as Docker has it now. */
export interface NetworkInfo {
  name: string;
  id: string;
  /** The extension it belongs to, or "" for nobody's. */
  owner: string;
}

/**
 * Where the portal reaches a port of a container on a network of an extension's (`networks.reach`): the host and the
 * port to connect to, over TCP, for HTTP, a WebSocket or anything else that runs on it.
 */
export interface Reach {
  host: string;
  port: number;
}

/**
 * What a container is made with: Docker's own create body (the Engine API's ContainerCreate: `Image`, `Env`, `Cmd`,
 * `HostConfig`, …), as the extension writes it. Its labels are kept, with the one that says whose it is added.
 */
export type ContainerSpec = { Image: string } & Record<string, unknown>;

/**
 * What a container that is there is changed with: Docker's own update body (the Engine API's ContainerUpdate:
 * `RestartPolicy`, and the resources, `Memory`, `NanoCpus`, …), as the extension writes it. What it does not name stays.
 */
export type ContainerChanges = Record<string, unknown>;

/** How a command is run in a container (`containers.exec`). */
export interface ExecOptions {
  /** Its environment, besides the container's: names and values. */
  env?: Record<string, string>;
  /** The folder it runs in; the container's own where none is given. */
  workingDir?: string;
  /** With a terminal: its output and its errors come back as it wrote them, colours and all. */
  tty?: boolean;
  /** How long to wait for it to end, in milliseconds; none, or 0, waits as long as it takes. */
  timeoutMs?: number;
}

/** What a command run in a container came to. */
export interface ExecResult {
  /** What it wrote, both its output and its errors, as text; where it was given up on, what it had written by then. */
  output: string;
  /** Its exit code: null where it was given up on. */
  exitCode: number | null;
  /** It did not end within `timeoutMs`. Docker cannot end it, so it may still be running in the container: ending it is the caller's. */
  timedOut: boolean;
}

/** How a download of an image is going: under way, with what Docker last said of it, or ended, with a failure or not. */
export interface PullState {
  active: boolean;
  line: string;
  error?: string;
}

export interface Docker {
  /** Whether Docker can be reached now: its socket is there, and answers. */
  available(): Promise<boolean>;
  /**
   * The `NetworkMode` (in `spec.HostConfig`) that puts a container on the portal's own loopback, so that each reaches
   * what the other serves on 127.0.0.1: `host` for a portal on the machine itself (Linux only), else `container:<id>` of
   * the portal's running container, named by `PORTAL_CONTAINER_NAME`, or else by `HOSTNAME`. The id changes when the
   * portal's container is made again, and a container made with the old one is then to be made again with the new.
   * Refused, with an Error that says what to do, on another system than Linux outside a container, or where the
   * portal's container is not found running. A container that runs code from elsewhere (the agent's) is on a network
   * of its own instead (`networks`), where it reaches nothing of the portal's but, for a portal in a container of its
   * own network namespace, what is listened for on 0.0.0.0 in that namespace (`networks.reach`).
   */
  sharedNetwork(): Promise<string>;
  images: {
    present(image: string): Promise<boolean>;
    /** The image is there, or is downloaded, with how the download goes told as it goes. One download for an image at a time, whoever asks. */
    ensure(image: string, onProgress?: (state: PullState) => void): Promise<void>;
  };
  containers: {
    /** This extension's containers. */
    list(): Promise<ContainerInfo[]>;
    /** A container by its name: nothing where there is none; with `owner` saying whose it is, which may be another's, or "" for nobody's. */
    get(name: string): Promise<ContainerInfo | undefined>;
    /**
     * Made, and not started, from `spec`, under `name`: one of this extension's by that name is removed first. A name
     * another extension's container has, or one nobody's has, is refused: take that one over first (`adopt`). Refused
     * too, with 403 and what Docker made taken away again, where it would be on a network that is not this extension's
     * (another extension's, or nobody's), Docker's own `bridge`, `host` and `none` aside, by `HostConfig.NetworkMode` or
     * `NetworkingConfig.EndpointsConfig`, or share the network (`container:<name or id>`) of a container that is
     * neither this extension's nor the portal's own, or that is not there.
     */
    create(name: string, spec: ContainerSpec): Promise<ContainerInfo>;
    start(name: string): Promise<void>;
    stop(name: string): Promise<void>;
    /** Stopped, and gone. One that is gone already is gone. */
    remove(name: string): Promise<void>;
    /** The end of what it wrote, both its output and its errors, as text. */
    logs(name: string, options?: { tail?: number }): Promise<string>;
    /**
     * How one of this extension's containers was made, and how it stands: Docker's own inspect body (`Config`,
     * `HostConfig`, `State`, …), as `create` takes Docker's own create body. Nothing where there is none; refused as
     * `start` is for one that is another's, or nobody's.
     */
    inspect(name: string): Promise<Record<string, unknown> | undefined>;
    /**
     * One of this extension's containers changed as it is (`changes`), running or not: Docker neither makes it again nor
     * restarts it, so what it runs and what it keeps go on as they were. Refused as `start` is for one that is another's,
     * or nobody's, and for one there is none of.
     */
    update(name: string, changes: ContainerChanges): Promise<void>;
    /**
     * `cmd` run in one of this extension's containers, which has to be running, to its end or until `timeoutMs`. Given up
     * on, it is not a failure: `timedOut` says so.
     */
    exec(name: string, cmd: string[], options?: ExecOptions): Promise<ExecResult>;
    /**
     * A container made before there was this extension, which carries no extension's name (one of the portal's own,
     * from before its app was an extension), made this extension's from now on. Another extension's is refused.
     */
    adopt(name: string): Promise<ContainerInfo>;
  };
  volumes: {
    /** This extension's volumes. */
    list(): Promise<VolumeInfo[]>;
    /** Made, with this extension's name on it; one of its own by that name is kept as it is. */
    create(name: string): Promise<void>;
    /** Gone, with all it holds. */
    remove(name: string): Promise<void>;
    /** A volume nobody's, made this extension's: as `containers.adopt`. */
    adopt(name: string): Promise<void>;
  };
  networks: {
    /**
     * A network for this extension's containers that has no way out: Docker's bridge, internal, in the gateway mode
     * `isolated`, with no IPv6. Nothing on it reaches the machine, the local network or the internet, and the machine
     * has no way onto it either; the containers on it reach one another, by name. With no IPv6 on it, Docker turns IPv6
     * off on each container's interface on it, which keeps the container from the IPv6 address the machine still has on
     * the bridge (fe80::): a `spec` that turns it on again (the endpoint's driver option
     * `com.docker.network.endpoint.sysctls`) gives that way to the machine back. Made with this extension's name on
     * it; one of its own by that name is kept as it is. Refused for a name another extension's network has, or one
     * nobody's has, and refused, with what was made taken away again, where Docker makes it with a way out after all:
     * Docker Engine before 28.0 has no `isolated`.
     */
    create(name: string): Promise<NetworkInfo>;
    /** A network by its name: nothing where there is none; with `owner` saying whose it is, which may be another's, or "" for nobody's. */
    get(name: string): Promise<NetworkInfo | undefined>;
    /**
     * Where the portal reaches `port` of `container`, one of this extension's containers on one of its networks
     * (`name`), which need not be running yet. Where the portal runs in a container of its own network namespace, its
     * container is put on the network, and the host is the container's name, which Docker's own DNS on the network
     * answers with wherever the container is after a restart. Where the portal is in the machine's namespace (on the
     * machine itself, or in a container with the network mode `host`), to which no network can be added, a forwarder
     * runs: a container of this extension's, `<container>-forward`, on the network and on a network of its own, which
     * publishes `port` on the machine's 127.0.0.1 and passes each connection on to `container`; the host is 127.0.0.1.
     * Each call puts right what is not as it should be: a portal's container made again, with a new id, is put on the
     * network, and a forwarder that is not as it would be made now, or is gone, is made again, and started where it is
     * stopped. Refused for a network or a container that is not this extension's, a container that is not on the
     * network, and a portal whose container shares another container's network namespace. With the portal's container
     * on the network, the containers on it reach what is listened for on 0.0.0.0 in the portal's network namespace: the
     * portal's own port, and that of every container that shares the namespace (`sharedNetwork`) and listens on every
     * interface. Through a forwarder they reach its port alone, which leads back to `container`.
     */
    reach(name: string, container: string, port: number): Promise<Reach>;
    /**
     * Gone: the portal's container taken off it, and the forwarder `reach` ran for it gone with that one's network.
     * A network that one of this extension's containers is still on is refused, in Docker's words: remove that
     * container first. One that is gone already is gone.
     */
    remove(name: string): Promise<void>;
  };
}
