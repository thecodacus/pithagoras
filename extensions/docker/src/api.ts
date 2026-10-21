/**
 * What Docker gives an extension that builds on it: name `pithagoras-docker` in `pithagoras.requires` (or `optional`)
 * in its package.json, and ask for it with `portal.extensions.use<Docker>("pithagoras-docker")`.
 *
 * Each extension has its own: the containers and volumes it makes carry its name, and it may start, stop, remove and
 * read only those, and the ones it took over (`adopt`). Another extension's are not its to touch, and neither is a
 * container nobody made through here until one takes it over. The person sees all of them in Settings → Docker, by the
 * extension that runs each, and may stop or remove any.
 *
 * A server half runs with the portal's own rights, and Docker's socket is root on the machine: what a container is made
 * with (`spec`, Docker's own create body) is the extension's to choose. This keeps extensions apart, and shows the person
 * what each runs; it does not make one safe that is not.
 */

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

/**
 * What a container is made with: Docker's own create body (the Engine API's ContainerCreate: `Image`, `Env`, `Cmd`,
 * `HostConfig`, …), as the extension writes it. Its labels are kept, with the one that says whose it is added.
 */
export type ContainerSpec = { Image: string } & Record<string, unknown>;

/** How a command is run in a container (`containers.exec`). */
export interface ExecOptions {
  /** Its environment, besides the container's: names and values. */
  env?: Record<string, string>;
  /** The folder it runs in; the container's own where none is given. */
  workingDir?: string;
  /** With a terminal: its output and its errors come back as it wrote them, colours and all. */
  tty?: boolean;
  /** How long to wait for it to end, in milliseconds; none, or 0, waits as long as it takes. Not Docker's 30 s for a request. */
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
     * another extension's container has, or one nobody's has, is refused: take that one over first (`adopt`).
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
}
