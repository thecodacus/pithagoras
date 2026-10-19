import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Ran, Runner } from "./compose";
import { OWNER_LABEL } from "./docker";
import { checked, DockerError, logs as written, request } from "./engine";

/**
 * Docker for a chat's agent (tools.ts): containers it runs from a Dockerfile or a compose file in the chat's folder,
 * and lists, starts, stops, deletes and reads, and no others. What it runs belongs to the folder: each container,
 * network, volume and built image carries the folder (FOLDER_LABEL) and this extension's name, and the chats in one
 * folder share them.
 *
 * Docker's socket is root on its machine, so what the agent runs is held to what stays in the chat's folder. compose
 * makes what it would run without starting it, and that is read back from Docker and refused, before any of it starts,
 * where it mounts a folder outside the chat's, runs privileged, with added capabilities or with the machine's devices,
 * shares the machine's network, processes or IPC, drops its confinement, or uses a network or a volume the project did
 * not make. What compose would do before that (build an image, run a program of its own) is refused from the file.
 *
 * With the sandbox on, the agent runs as a user of its own, and a container that ran as root would read and change
 * in the folders it mounts what that user may not. So then everything Docker does with the chat's folder is done as
 * the agent (AgentUser): compose runs as it, every container runs as it, with its groups and no way to gain more,
 * and a folder to mount that is not there is made by it, not by Docker as root. An image that needs root inside its
 * container does not work then.
 */

export const FOLDER_LABEL = "pithagoras.folder";
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const DEPENDS_LABEL = "com.docker.compose.depends_on";

/** A container of the folder's, as the agent is told of it. */
export interface AgentContainer {
  name: string;
  project: string;
  service: string;
  image: string;
  state: string;
  status: string;
  /** Published ports, the machine's first: "8080->80/tcp". */
  ports: string[];
}

type Labels = Record<string, string> | null | undefined;
type Listed = { Id: string; Names?: string[]; Image: string; State: string; Status: string; Labels?: Labels; Ports?: { PrivatePort: number; PublicPort?: number; Type: string }[] };
type Inspected = {
  Id: string;
  Name: string;
  State?: { Status?: string };
  Config?: { Tty?: boolean; Labels?: Labels; User?: string };
  HostConfig?: {
    Privileged?: boolean;
    CapAdd?: string[] | null;
    Devices?: { PathOnHost: string }[] | null;
    DeviceCgroupRules?: string[] | null;
    NetworkMode?: string;
    PidMode?: string;
    IpcMode?: string;
    UTSMode?: string;
    UsernsMode?: string;
    CgroupnsMode?: string;
    SecurityOpt?: string[] | null;
    GroupAdd?: string[] | null;
    MaskedPaths?: string[] | null;
    ReadonlyPaths?: string[] | null;
    VolumesFrom?: string[] | null;
  };
  Mounts?: { Type: string; Source?: string; Name?: string }[];
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
};

/** compose's normalized project, as much of it as is looked at here. */
type Project = {
  services?: Record<
    string,
    {
      labels?: Record<string, string>;
      provider?: unknown;
      build?: { network?: string; privileged?: boolean; entitlements?: string[]; labels?: Record<string, string> };
      user?: string;
      group_add?: (string | number)[];
      security_opt?: string[];
      volumes?: { type: string; source?: string }[];
      post_start?: Hook[];
      pre_stop?: Hook[];
    }
  >;
  models?: Record<string, unknown>;
} & Partial<Record<"networks" | "volumes" | "secrets" | "configs", Record<string, { external?: boolean; driver?: string; driver_opts?: Record<string, string>; labels?: Record<string, string> } | null>>>;

/** A command compose runs in a service's container as it starts or stops it, as whom it says. */
type Hook = { user?: string; privileged?: boolean };

/** The chat's agent, where it runs as a user of its own (the sandbox on): who it is, and a command run as it. */
export interface AgentUser {
  uid: number;
  gid: number;
  /** Its other groups: the ones it writes the folders it shares through. */
  groups: number[];
  run(argv: string[]): Promise<{ code: number | null; stderr: string }>;
}

const filters = (labels: string[]) => encodeURIComponent(JSON.stringify({ label: labels }));
const nameOf = (raw: { Names?: string[]; Name?: string }) => (raw.Names?.[0] ?? raw.Name ?? "").replace(/^\//, "");
/** The end of what compose said, for the agent to read why. */
const tail = (text: string) => text.trim().split("\n").slice(-40).join("\n").slice(-4000);

/**
 * What a file's containers are called together: after the folder the file is in, with a hash of the chat's folder
 * and the file, so that two folders of one name, or two files in one folder, are two projects.
 */
export function projectName(folder: string, rel: string): string {
  const dir = path.dirname(rel);
  const base = (dir === "." ? path.basename(folder) : path.basename(dir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "")
    .slice(0, 30);
  return `${base || "app"}-${createHash("sha256").update(`${folder}\n${rel}`).digest("hex").slice(0, 8)}`;
}

export interface AgentOptions {
  /** This extension's name, which what the agent runs carries. */
  owner: string;
  runner: Runner;
  /** A path of the portal's, as Docker's machine has it (host-paths.ts). */
  onHost: (where: string) => Promise<string>;
  /** `rel` inside `base`, links followed, or an error: `portal.files.inside`. */
  inside: (base: string, rel: string) => string;
}

export function agentDocker({ owner, runner, onHost, inside }: AgentOptions) {
  /** One run of a project at a time: two would make and remove each other's containers. */
  const running = new Map<string, Promise<unknown>>();
  function queued<T>(project: string, work: () => Promise<T>): Promise<T> {
    const done = (running.get(project) ?? Promise.resolve()).then(work, work);
    const settled = done.catch(() => {});
    running.set(project, settled);
    void settled.then(() => running.get(project) === settled && running.delete(project));
    return done;
  }

  async function ok(ran: Promise<Ran>, doing: string): Promise<string> {
    const { code, stdout, stderr } = await ran;
    if (code !== 0) throw new DockerError(`docker compose could not ${doing}:\n${tail(stderr || stdout)}`);
    return stdout;
  }

  /**
   * What a chat in `folder` may do. `folder` is the chat's folder, from `portal.chats.folder`; `user` its agent, where
   * it runs as a user of its own.
   */
  return function forFolder(folder: string, user?: () => Promise<AgentUser | undefined>) {
    const labels = { [OWNER_LABEL]: owner, [FOLDER_LABEL]: folder };
    const ours = Object.entries(labels).map(([key, value]) => `${key}=${value}`);

    async function list(): Promise<AgentContainer[]> {
      const raw = await checked<Listed[]>("GET", `/containers/json?all=1&filters=${filters(ours)}`);
      return raw
        .map((c) => ({
          name: nameOf(c),
          project: c.Labels?.[PROJECT_LABEL] ?? "",
          service: c.Labels?.[SERVICE_LABEL] ?? "",
          image: c.Image,
          state: c.State,
          status: c.Status,
          // Once, though Docker lists a port for each of the machine's addresses.
          ports: [...new Set((c.Ports ?? []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}->${p.PrivatePort}/${p.Type}`))],
        }))
        .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    }

    /** The containers `name` is: one by its name, or a project's. Only the folder's are found. */
    async function pick(name: string): Promise<AgentContainer[]> {
      const all = await list();
      const one = all.filter((c) => c.name === name);
      const picked = one.length ? one : all.filter((c) => c.project === name);
      if (!picked.length) throw new DockerError(`There is no container or project ${name} of this chat's: docker_list says what there is`, 404);
      return picked;
    }

    /** What is refused in the project before compose does anything with it: what it would build or run itself. */
    function refusedInFile(project: Project, as: AgentUser | undefined): string[] {
      const out: string[] = [];
      if (Object.keys(project.models ?? {}).length) out.push("models: not run here");
      for (const [name, service] of Object.entries(project.services ?? {})) {
        if (service.provider) out.push(`${name}: a provider service runs a program of compose's own, which is not done here`);
        // A hook runs as its service's user unless it says another: with the sandbox on, that is the agent.
        if (as) {
          for (const kind of ["post_start", "pre_stop"] as const) {
            for (const hook of service[kind] ?? []) {
              if (hook.user) out.push(`${name}: its ${kind} runs as ${hook.user}, and with the sandbox on everything runs as the agent`);
              if (hook.privileged) out.push(`${name}: its ${kind} runs privileged`);
            }
          }
        }
        if (service.build?.network === "host") out.push(`${name}: is built on the machine's network`);
        if (service.build?.privileged) out.push(`${name}: is built privileged`);
        if (service.build?.entitlements?.length) out.push(`${name}: is built with ${service.build.entitlements.join(", ")}`);
      }
      for (const kind of ["networks", "volumes", "secrets", "configs"] as const) {
        for (const [name, item] of Object.entries(project[kind] ?? {})) {
          if (item?.external) out.push(`${name}: one of the ${kind} that is there already, and not this project's to use`);
          if (kind === "volumes" && item && ((item.driver && item.driver !== "local") || Object.keys(item.driver_opts ?? {}).length)) {
            out.push(`${name}: a volume with a driver or options of its own`);
          }
        }
      }
      return out;
    }

    /** Each thing the project makes carries the folder and this extension's name. */
    function label(project: Project): void {
      for (const service of Object.values(project.services ?? {})) {
        service.labels = { ...service.labels, ...labels };
        if (service.build) service.build.labels = { ...service.build.labels, ...labels };
      }
      for (const kind of ["networks", "volumes"] as const) for (const item of Object.values(project[kind] ?? {})) if (item) item.labels = { ...item.labels, ...labels };
    }

    /** With the sandbox on, each service runs as the agent, with its groups, and cannot gain more: whatever its file says. */
    function asTheAgent(project: Project, as: AgentUser): void {
      for (const service of Object.values(project.services ?? {})) {
        service.user = `${as.uid}:${as.gid}`;
        service.group_add = as.groups.map(String);
        service.security_opt = [...new Set([...(service.security_opt ?? []), "no-new-privileges:true"])];
      }
    }

    /** A folder of the chat's to mount that is not there yet, made by the agent: Docker would make it as root. */
    async function makeMounts(project: Project, hostFolder: string, as: AgentUser): Promise<void> {
      for (const service of Object.values(project.services ?? {})) {
        for (const mount of service.volumes ?? []) {
          if (mount.type !== "bind" || !mount.source) continue;
          const rel = path.posix.relative(hostFolder, mount.source);
          // One outside the folder is refused once compose has made the container.
          if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) continue;
          const local = path.join(folder, ...rel.split("/").filter(Boolean));
          if (existsSync(local)) continue;
          const ran = await as.run(["mkdir", "-p", "--", local]);
          if (ran.code !== 0) throw new DockerError(`${rel || "."} could not be made for a container to mount: ${ran.stderr || `exit ${ran.code}`}`);
        }
      }
    }

    /** What is refused in what compose made: read back from Docker, which is what would run. */
    async function refusedInMade(project: string, hostFolder: string, made: Inspected[], as: AgentUser | undefined): Promise<string[]> {
      const out: string[] = [];
      const own = new Set(made.flatMap((c) => [c.Id, nameOf(c)]));
      const volumes = new Map<string, Promise<{ Driver?: string; Options?: Record<string, string> | null; Labels?: Labels }>>();
      const networks = new Map<string, Promise<{ Labels?: Labels }>>();
      for (const c of made) {
        const who = c.Config?.Labels?.[SERVICE_LABEL] || nameOf(c);
        const say = (what: string) => out.push(`${who}: ${what}`);
        const host = c.HostConfig ?? {};
        if (host.Privileged) say("runs privileged");
        if (host.CapAdd?.length) say(`adds the capabilities ${host.CapAdd.join(", ")}`);
        if (host.Devices?.length) say(`is given the machine's devices ${host.Devices.map((d) => d.PathOnHost).join(", ")}`);
        if (host.DeviceCgroupRules?.length) say("is let at the machine's devices");
        const shared: [string, string | undefined][] = [
          ["network", host.NetworkMode],
          ["processes", host.PidMode],
          ["IPC", host.IpcMode],
          ["host name", host.UTSMode],
          ["users", host.UsernsMode],
          ["cgroups", host.CgroupnsMode],
        ];
        for (const [what, mode] of shared) {
          if (mode === "host") say(`shares the machine's ${what}`);
          else if (mode?.startsWith("container:") && !own.has(mode.slice("container:".length))) say(`shares the ${what} of ${mode.slice("container:".length)}, which is not this project's`);
        }
        // Docker turns SELinux's labels off by itself for a container that is privileged or shares the machine's processes or IPC, each said above.
        const unlabelled = host.Privileged || host.PidMode === "host" || host.IpcMode === "host";
        for (const option of host.SecurityOpt ?? []) {
          if (!/^no-new-privileges([:=]true)?$/.test(option) && !(unlabelled && option === "label=disable")) say(`is run with ${option}`);
        }
        if (as) {
          const agent = `${as.uid}:${as.gid}`;
          if (c.Config?.User !== agent) say(`runs as ${c.Config?.User || "root"}, not as the agent (${agent})`);
          const extra = (host.GroupAdd ?? []).filter((g) => !as.groups.map(String).includes(g));
          if (extra.length) say(`is given the groups ${extra.join(", ")}`);
          if (!(host.SecurityOpt ?? []).some((option) => /^no-new-privileges([:=]true)?$/.test(option))) say("can gain privileges (no-new-privileges is not set)");
        }
        // `systempaths=unconfined` does not reach Docker as an option: compose sends these lists empty instead.
        if (host.MaskedPaths?.length === 0) say("is run with the kernel's files under /proc unmasked");
        if (host.ReadonlyPaths?.length === 0) say("is run with the kernel's files under /proc writable");
        for (const from of host.VolumesFrom ?? []) if (!own.has(from.split(":")[0])) say(`takes the volumes of ${from.split(":")[0]}, which is not this project's`);
        for (const mount of c.Mounts ?? []) {
          if (mount.Type === "bind") {
            const why = bindRefused(mount.Source ?? "", hostFolder);
            if (why) say(why);
          } else if (mount.Type === "volume" && mount.Name) {
            const name = mount.Name;
            if (!volumes.has(name)) volumes.set(name, checked("GET", `/volumes/${encodeURIComponent(name)}`));
            const volume = await volumes.get(name)!;
            if (volume.Labels?.[PROJECT_LABEL] !== project && !(volume.Labels && "com.docker.volume.anonymous" in volume.Labels)) say(`uses the volume ${name}, which this project did not make`);
            else if ((volume.Driver && volume.Driver !== "local") || Object.keys(volume.Options ?? {}).length) say(`uses the volume ${name}, made with a driver or options of its own`);
          } else if (mount.Type !== "tmpfs" && mount.Type !== "image") say(`mounts something of the kind ${mount.Type}`);
        }
        for (const network of Object.keys(c.NetworkSettings?.Networks ?? {})) {
          if (network === "bridge" || network === "none") continue;
          if (network === "host") continue; // Said of NetworkMode.
          if (!networks.has(network)) networks.set(network, checked("GET", `/networks/${encodeURIComponent(network)}`));
          if ((await networks.get(network)!).Labels?.[PROJECT_LABEL] !== project) say(`joins the network ${network}, which this project did not make`);
        }
      }
      return out;
    }

    /** Why a folder of the machine's is not the container's to mount: outside the chat's folder, or reached by a link. */
    function bindRefused(source: string, hostFolder: string): string | undefined {
      const rel = path.posix.relative(hostFolder, source);
      if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return `mounts ${source}, which is outside this chat's folder`;
      let real: string;
      try {
        real = inside(folder, rel);
      } catch {
        return `mounts ${rel}, which leads outside this chat's folder`;
      }
      // A link is read one way here and another on Docker's machine, where a path of the portal's may be another place.
      if (real !== path.join(folder, ...rel.split("/").filter(Boolean))) return `mounts ${rel}, which is reached by a link: mount the folder it leads to by its own path`;
      return undefined;
    }

    async function run(file: string, given: { ports?: string[]; environment?: Record<string, string> } = {}, signal?: AbortSignal) {
      const real = inside(folder, path.isAbsolute(file) ? path.relative(folder, file) : file);
      let isFile = false;
      try {
        isFile = statSync(real).isFile();
      } catch {
        // Said below.
      }
      if (!isFile) throw new DockerError(`There is no file ${file} in this chat's folder`, 404);
      const rel = path.relative(folder, real);
      const composeFile = /\.ya?ml$/i.test(rel);
      if (composeFile && (given.ports?.length || Object.keys(given.environment ?? {}).length)) {
        throw new DockerError("ports and environment are for a Dockerfile: a compose file says its own");
      }
      const hostFolder = await onHost(folder);
      const hostFile = path.posix.join(hostFolder, ...rel.split(path.sep));
      const project = projectName(folder, rel);
      const as = await user?.();
      // compose, too, reads the chat's folder (the file, what an image is built from) as the agent.
      const who = as ? { uid: as.uid, gid: as.gid, groups: as.groups } : undefined;
      return queued(project, async () => {
        const fromDockerfile = {
          services: {
            app: {
              build: { context: path.posix.dirname(hostFile), dockerfile: path.posix.basename(hostFile) },
              ...(given.ports?.length ? { ports: given.ports } : {}),
              ...(Object.keys(given.environment ?? {}).length ? { environment: given.environment } : {}),
            },
          },
        };
        const read = await ok(
          runner(["-p", project, "-f", composeFile ? hostFile : "-", "config", "--format", "json"], { folder: hostFolder, input: composeFile ? undefined : JSON.stringify(fromDockerfile), signal, as: who }),
          `read ${rel}`,
        );
        const config = JSON.parse(read) as Project;
        const refused = refusedInFile(config, as);
        if (refused.length) throw new DockerError(`Refused, and nothing was made:\n- ${refused.join("\n- ")}`, 403);
        label(config);
        if (as) {
          asTheAgent(config, as);
          await makeMounts(config, hostFolder, as);
        }
        const input = JSON.stringify(config);
        const asRead = ["-p", project, "--project-directory", path.posix.dirname(hostFile), "-f", "-"];
        await ok(runner([...asRead, "up", "--no-start", "--build", "--remove-orphans"], { folder: hostFolder, input, signal, as: who }), `make ${rel}'s containers`);

        const listed = await checked<Listed[]>("GET", `/containers/json?all=1&filters=${filters([`${PROJECT_LABEL}=${project}`])}`);
        const made = await Promise.all(listed.map((c) => checked<Inspected>("GET", `/containers/${c.Id}/json`)));
        const wrong = await refusedInMade(project, hostFolder, made, as);
        if (wrong.length) {
          // What was made for this run and not started goes.
          for (const c of made) if (c.State?.Status === "created") await request("DELETE", `/containers/${c.Id}?force=true`).catch(() => {});
          throw new DockerError(`Refused, and none of it was started:\n- ${wrong.join("\n- ")}`, 403);
        }
        await ok(runner([...asRead, "up", "--detach", "--no-recreate", "--no-build"], { folder: hostFolder, input, signal, as: who }), `start ${rel}'s containers`);
        return { project, containers: (await list()).filter((c) => c.project === project) };
      });
    }

    async function start(name: string) {
      const picked = await pick(name);
      // What a container needs started first, as compose wrote it on the container: "db:service_started:false,…".
      const needs = new Map<string, string[]>();
      for (const c of picked) {
        const found = await checked<Inspected>("GET", `/containers/${encodeURIComponent(c.name)}/json`);
        needs.set(c.service, (found.Config?.Labels?.[DEPENDS_LABEL] ?? "").split(",").map((d) => d.split(":")[0]).filter(Boolean));
      }
      const started = new Set<string>();
      const startOne = async (c: AgentContainer, seen: Set<string>) => {
        if (started.has(c.name) || seen.has(c.service)) return;
        seen.add(c.service);
        for (const dep of needs.get(c.service) ?? []) for (const d of picked.filter((x) => x.service === dep)) await startOne(d, seen);
        const { status, body } = await request<{ message?: string }>("POST", `/containers/${encodeURIComponent(c.name)}/start`);
        if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
        started.add(c.name);
      };
      for (const c of picked) await startOne(c, new Set());
      return { started: [...started] };
    }

    async function stop(name: string) {
      const picked = await pick(name);
      // One stopped already is answered 304, which is no failure.
      await Promise.all(picked.map((c) => checked("POST", `/containers/${encodeURIComponent(c.name)}/stop?t=10`)));
      return { stopped: picked.map((c) => c.name) };
    }

    async function remove(name: string, volumes = false) {
      const picked = await pick(name);
      for (const c of picked) {
        const { status, body } = await request<{ message?: string }>("DELETE", `/containers/${encodeURIComponent(c.name)}?force=true`);
        if (status >= 400 && status !== 404) throw new DockerError(body?.message || `Docker answered ${status}`, status);
      }
      const left = await list();
      const gone: string[] = [];
      for (const project of new Set(picked.map((c) => c.project).filter(Boolean))) {
        if (left.some((c) => c.project === project)) continue;
        // The project has no container left: what was made for it goes too.
        const of = filters([`${PROJECT_LABEL}=${project}`, ...ours]);
        for (const network of await checked<{ Id: string }[]>("GET", `/networks?filters=${of}`)) await request("DELETE", `/networks/${network.Id}`).catch(() => {});
        // One another image is built on stays.
        for (const image of await checked<{ Id: string }[]>("GET", `/images/json?filters=${of}`)) await request("DELETE", `/images/${image.Id}`).catch(() => {});
        if (volumes) {
          const { Volumes } = await checked<{ Volumes: { Name: string }[] | null }>("GET", `/volumes?filters=${of}`);
          for (const volume of Volumes ?? []) {
            await checked("DELETE", `/volumes/${encodeURIComponent(volume.Name)}`);
            gone.push(volume.Name);
          }
        }
      }
      return { deleted: picked.map((c) => c.name), ...(volumes ? { volumesDeleted: gone } : {}) };
    }

    async function logs(name: string, lines = 200) {
      const picked = await pick(name);
      const count = Math.min(Math.max(1, Math.floor(lines)), 5_000);
      const texts = await Promise.all(
        picked.map(async (c) => {
          const found = await checked<Inspected>("GET", `/containers/${encodeURIComponent(c.name)}/json`);
          return { name: c.name, text: await written(found.Id, count, Boolean(found.Config?.Tty)) };
        }),
      );
      return texts.length === 1 && texts[0].name === name ? { text: texts[0].text } : { containers: texts };
    }

    return { list, run, start, stop, remove, logs };
  };
}

export type AgentDocker = ReturnType<ReturnType<typeof agentDocker>>;
