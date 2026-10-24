import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A Docker daemon for the tests, on a socket of its own: the endpoints the extension uses, answered as Docker answers
 * them, from what it holds. `containers`, `volumes` and `networks` may be filled by a test, as if made with the docker
 * command.
 */
export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  State: string;
  Labels: Record<string, string>;
  Tty: boolean;
  /** What it wrote: its output, and its errors. */
  out: string;
  err: string;
  /** As Docker's inspect has them, for a test that says. */
  User?: string;
  HostConfig?: Record<string, unknown>;
  Mounts?: Record<string, unknown>[];
  /**
   * The networks it is on, by their names, as inspect's `NetworkSettings.Networks` has them: those it was made on, or
   * connected to. Each has its network's id (`NetworkID`) from the container's first start, or its connect, on: "" for
   * one that was made and never started, as Docker has it, and kept as it was after a stop.
   */
  Networks?: Record<string, { NetworkID?: string }>;
  Ports?: { PrivatePort: number; PublicPort?: number; Type: string; IP?: string }[];
  /** What it was made with: Docker's create body. */
  made?: Record<string, unknown>;
  /** The exit code `wait` answers with, and inspect has. */
  code?: number;
  /** Why it could not run, as inspect has it. */
  error?: string;
  /**
   * How many times Docker started it again by itself, after it exited, since it was last started by request: inspect's
   * `RestartCount`, which Docker keeps while a run it began goes on. Between those starts its `State` is "restarting",
   * as Docker has it while it waits to start it again.
   */
  restarts?: number;
  /**
   * When it last began to run, at a start by request or at one of Docker's own: inspect's `State.StartedAt`, which each
   * start sets anew. Docker's zero time where it was never started, or a test put it there without saying.
   */
  started?: string;
}

/** A command run in a container (`exec`), as it was asked for, and how it stands. */
export interface FakeExec {
  Id: string;
  /** The container's id. */
  ContainerID: string;
  Cmd: string[];
  Env: string[];
  WorkingDir?: string;
  Tty: boolean;
  Running: boolean;
  ExitCode: number | null;
}

/**
 * A network, as Docker's inspect has it, without the containers on it, which inspect adds (the running ones). One made
 * through the daemon is internal, has IPv6 and options as asked, and an address range with a gateway, but none where it
 * is internal and in the gateway mode `isolated`, as Docker Engine 28.0 and later make it.
 */
export interface FakeNetwork {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Internal?: boolean;
  EnableIPv6?: boolean;
  Options?: Record<string, string>;
  IPAM?: { Config: { Subnet?: string; Gateway?: string }[] };
}

/** What a list's `filters` asks of something's labels: each "key" there, and each "key=value" so. */
const labelled = (labels: Record<string, string> | null | undefined, wanted: string[] | undefined) =>
  (wanted ?? []).every((w) => {
    const at = w.indexOf("=");
    return at < 0 ? Boolean(labels && w in labels) : labels?.[w.slice(0, at)] === w.slice(at + 1);
  });

export async function fakeDocker() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dk-"));
  const socket = path.join(dir, "docker.sock");
  const images = new Set<string>();
  const containers: FakeContainer[] = [];
  const volumes: { Name: string; Labels: Record<string, string> | null; Driver?: string; Options?: Record<string, string> | null }[] = [];
  const networks: FakeNetwork[] = [];
  /** Images by id, with their labels: the ones a build made. */
  const built: { Id: string; Labels: Record<string, string> }[] = [];
  /**
   * What a container does when it is started, for a test that says: it runs, and has exited when this returns. Docker's
   * own words for a start it refuses, which leaves the container as it was (one that asks for a GPU Docker has no
   * runtime for). What a container that is stopped leaves behind (the memory it held). What becomes of a container
   * once a command is made in it, before the command starts. And what a command run in one writes, and the code it
   * ends with: nothing, and 0, unless a test says. What becomes of a network and a container as the container is
   * connected to it, before Docker answers (another connected it just then). And, with `oldNetworks`, every network is
   * made with a gateway, as a Docker before 28.0 that ignores the gateway mode makes it.
   */
  const runs: {
    onStart?: (c: FakeContainer) => void | Promise<void>;
    refuseStart?: (c: FakeContainer) => string | undefined;
    onStop?: (c: FakeContainer) => void;
    onExecCreate?: (c: FakeContainer) => void;
    onExec?: (e: FakeExec) => { out?: string; err?: string; code?: number };
    onConnect?: (n: FakeNetwork, c: FakeContainer) => void;
    oldNetworks?: boolean;
  } = {};
  const execs: FakeExec[] = [];
  /** The containers made, and those started (by name), in the order they were; and each change to one (`update`), by its name. */
  const created: FakeContainer[] = [];
  const starts: string[] = [];
  const updates: { name: string; changes: Record<string, unknown> }[] = [];
  const pulls: string[] = [];
  /** Each connect asked for, refused or not: the network's name and the container's. */
  const connects: { network: string; container: string }[] = [];
  /** A download that fails, by image, with Docker's own words. */
  const failing = new Map<string, string>();
  /** When a start began, as Docker writes it: each later than the one before, as Docker's own, in nanoseconds, are. */
  let clock = 0;
  const startedAt = () => new Date((clock = Math.max(clock + 1, Date.now()))).toISOString();
  /**
   * While `pull` is set, a download says its first lines and does not end until it settles: an image on its way. While
   * `exec` is, a command writes what it writes and does not end until it settles.
   */
  const hold: { pull?: Promise<void>; exec?: Promise<void> } = {};
  let ids = 0;

  const find = (key: string) => containers.find((c) => c.Id === key || c.Name === key);
  const findNetwork = (key: string) => networks.find((n) => n.Id === key || n.Name === key);
  /** The containers on a network as Docker counts them for its inspect and its remove: the running ones. */
  const onNetwork = (n: FakeNetwork) => containers.filter((c) => c.State === "running" && c.Networks?.[n.Name]);
  const raw = (c: FakeContainer) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image, State: c.State, Status: c.State === "running" ? "Up 2 minutes" : "Exited (0) 1 minute ago", Labels: c.Labels, Ports: c.Ports ?? [] });
  const filtersOf = (url: URL) => JSON.parse(url.searchParams.get("filters") ?? "{}") as Record<string, string[]>;
  /** Docker's frames for a container with no terminal: a header of eight bytes, which stream and how long, then the bytes. */
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://docker");
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const p = decodeURIComponent(url.pathname);
      let m: RegExpExecArray | null;
      if (p === "/_ping") return res.end("OK");
      if (p === "/version") return send(200, { Version: "27.3.1" });
      if ((m = /^\/images\/(.+)\/json$/.exec(p))) return images.has(m[1]) ? send(200, { Id: m[1] }) : send(404, { message: `No such image: ${m[1]}` });
      if (p === "/images/create" && req.method === "POST") {
        const image = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`;
        pulls.push(image);
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`${JSON.stringify({ status: `Pulling from ${image}` })}\n`);
        // A line in two pieces, as the network may split it.
        const line = JSON.stringify({ status: "Downloading", progress: "[=====>   ] 5MB/10MB" });
        res.write(line.slice(0, 10));
        setTimeout(() => {
          res.write(`${line.slice(10)}\n`);
          void Promise.resolve(hold.pull).then(() => {
            const failure = failing.get(image);
            if (failure) res.end(`${JSON.stringify({ error: failure })}\n`);
            else {
              images.add(image);
              res.end(`${JSON.stringify({ status: "Downloaded newer image" })}\n`);
            }
          });
        }, 20);
        return;
      }
      if (p === "/containers/json") {
        const { id: only, label } = filtersOf(url);
        return send(200, containers.filter((c) => (!only || only.includes(c.Id)) && labelled(c.Labels, label)).map(raw));
      }
      if (p === "/containers/create" && req.method === "POST") {
        const name = url.searchParams.get("name")!;
        if (find(name)) return send(409, { message: `Conflict. The container name "/${name}" is already in use` });
        const made: FakeContainer = { Id: `id${++ids}`.padEnd(12, "0"), Name: name, Image: body.Image, State: "created", Labels: body.Labels ?? {}, Tty: Boolean(body.Tty), out: "", err: "", made: body };
        // On the network its network mode names, and on those its endpoints do, of the ones there are here: by its id from its first start.
        const named = [body.HostConfig?.NetworkMode, ...Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {})];
        const on = networks.filter((n) => named.includes(n.Name) || named.includes(n.Id));
        if (on.length) made.Networks = Object.fromEntries(on.map((n) => [n.Name, { NetworkID: "" }]));
        containers.push(made);
        created.push(made);
        return send(201, { Id: made.Id });
      }
      if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        // Docker's create body is the container's Config, with its HostConfig and NetworkingConfig apart.
        const { HostConfig: madeHost, NetworkingConfig: _networking, ...config } = c.made ?? {};
        return send(200, {
          Id: c.Id,
          Name: `/${c.Name}`,
          Config: { ...config, Image: c.Image, Tty: c.Tty, Labels: c.Labels, ...(c.User !== undefined ? { User: c.User } : {}) },
          // Docker counts one it is waiting to start again as running, for its stop and its remove.
          State: { Status: c.State, Running: c.State === "running" || c.State === "restarting", Restarting: c.State === "restarting", ExitCode: c.code ?? 0, Error: c.error ?? "", StartedAt: c.started ?? "0001-01-01T00:00:00Z" },
          RestartCount: c.restarts ?? 0,
          HostConfig: c.HostConfig ?? madeHost ?? {},
          Mounts: c.Mounts ?? [],
          NetworkSettings: { Networks: c.Networks ?? {} },
        });
      }
      if ((m = /^\/containers\/([^/]+)\/exec$/.exec(p)) && req.method === "POST") {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        if (c.State !== "running") return send(409, { message: `container ${c.Id} is not running` });
        const e: FakeExec = { Id: `exec${++ids}`, ContainerID: c.Id, Cmd: body.Cmd, Env: body.Env ?? [], WorkingDir: body.WorkingDir, Tty: Boolean(body.Tty), Running: false, ExitCode: null };
        execs.push(e);
        runs.onExecCreate?.(c);
        return send(201, { Id: e.Id });
      }
      if ((m = /^\/exec\/([^/]+)\/start$/.exec(p)) && req.method === "POST") {
        const e = execs.find((x) => x.Id === m![1]);
        if (!e) return send(404, { message: `No such exec instance: ${m[1]}` });
        if (find(e.ContainerID)?.State !== "running") return send(409, { message: `container ${e.ContainerID} is not running` });
        const { out = "", err = "", code = 0 } = runs.onExec?.(e) ?? {};
        e.Running = true;
        // Docker takes the connection over: a status line and a type, with no length and no chunks, then the output
        // until it closes its side of the connection.
        const socket = req.socket;
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n");
        socket.write(e.Tty ? Buffer.from(out + err) : Buffer.concat([frame(1, out), frame(2, err)]));
        // Its code is there before its output ends, as Docker has it.
        void Promise.resolve(hold.exec).then(() => {
          Object.assign(e, { Running: false, ExitCode: code });
          socket.end();
        });
        return;
      }
      if ((m = /^\/exec\/([^/]+)\/json$/.exec(p))) {
        const e = execs.find((x) => x.Id === m![1]);
        return e ? send(200, { Running: e.Running, ExitCode: e.ExitCode }) : send(404, { message: `No such exec instance: ${m[1]}` });
      }
      if ((m = /^\/containers\/([^/]+)\/(start|stop)$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        const want = m[2] === "start" ? "running" : "exited";
        // One Docker is waiting to start again is running to it: a start leaves it as it is, and a stop ends the wait.
        if (c.State === want || (want === "running" && c.State === "restarting")) return send(304);
        const refused = want === "running" ? runs.refuseStart?.(c) : undefined;
        if (refused) return send(500, { message: refused });
        c.State = want;
        if (want === "exited") runs.onStop?.(c);
        if (want === "running") {
          for (const [name, endpoint] of Object.entries(c.Networks ?? {})) endpoint.NetworkID ||= networks.find((n) => n.Name === name)?.Id;
          starts.push(c.Name);
          c.started = startedAt();
          // A start by request counts Docker's own starts from none again.
          delete c.restarts;
        }
        if (want === "running" && runs.onStart) {
          void Promise.resolve(runs.onStart(c)).then(() => (c.State = "exited"));
        }
        return send(204);
      }
      if ((m = /^\/containers\/([^/]+)\/update$/.exec(p)) && req.method === "POST") {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        // What it was made with, with what is changed in its place; it goes on running, or not, as it was.
        c.HostConfig = { ...(c.HostConfig ?? (c.made?.HostConfig as Record<string, unknown> | undefined) ?? {}), ...body };
        updates.push({ name: c.Name, changes: body });
        return send(200, { Warnings: [] });
      }
      if ((m = /^\/containers\/([^/]+)\/wait$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        const check = () => (c.State === "running" ? setTimeout(check, 5) : send(200, { StatusCode: c.code ?? 0 }));
        return check();
      }
      if ((m = /^\/containers\/([^/]+)\/kill$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        Object.assign(c, { State: "exited", code: 137 });
        return send(204);
      }
      if ((m = /^\/containers\/([^/]+)$/.exec(p)) && req.method === "DELETE") {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        containers.splice(containers.indexOf(c), 1);
        return send(204);
      }
      if ((m = /^\/containers\/([^/]+)\/logs$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        const out = url.searchParams.get("stdout") === "1" ? c.out : "";
        const err = url.searchParams.get("stderr") === "1" ? c.err : "";
        res.writeHead(200, { "content-type": c.Tty ? "application/vnd.docker.raw-stream" : "application/vnd.docker.multiplexed-stream" });
        return res.end(c.Tty ? Buffer.from(out + err) : Buffer.concat([frame(1, out), frame(2, err)]));
      }
      if (p === "/volumes") return send(200, { Volumes: volumes.filter((v) => labelled(v.Labels, filtersOf(url).label)) });
      if (p === "/networks") return send(200, networks.filter((n) => labelled(n.Labels, filtersOf(url).label)));
      if (p === "/networks/create" && req.method === "POST") {
        if (networks.some((n) => n.Name === body.Name)) return send(409, { message: `network with name ${body.Name} already exists` });
        const at = ++ids;
        const isolated = body.Internal === true && body.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated" && !runs.oldNetworks;
        const made: FakeNetwork = {
          Id: `net${at}`.padEnd(12, "0"),
          Name: body.Name,
          Labels: body.Labels ?? {},
          Internal: Boolean(body.Internal),
          EnableIPv6: Boolean(body.EnableIPv6),
          Options: body.Options ?? {},
          IPAM: { Config: [{ Subnet: `10.${at % 256}.0.0/16`, ...(isolated ? {} : { Gateway: `10.${at % 256}.0.1` }) }] },
        };
        networks.push(made);
        return send(201, { Id: made.Id, Warning: "" });
      }
      if ((m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(p)) && req.method === "POST") {
        const n = findNetwork(m[1]);
        if (!n) return send(404, { message: `network ${m[1]} not found` });
        const c = find(body.Container);
        if (!c) return send(404, { message: `No such container: ${body.Container}` });
        if (m[2] === "disconnect") {
          delete c.Networks?.[n.Name];
          return send(200);
        }
        connects.push({ network: n.Name, container: c.Name });
        runs.onConnect?.(n, c);
        const mode = String(((c.HostConfig ?? c.made?.HostConfig) as Record<string, unknown> | undefined)?.NetworkMode ?? "");
        if (mode === "host" || mode.startsWith("container:")) return send(400, { message: "container sharing network namespace with another container or host cannot be connected to any other network" });
        if (c.Networks?.[n.Name]) return send(403, { message: `endpoint with name ${c.Name} already exists in network ${n.Name}` });
        c.Networks = { ...c.Networks, [n.Name]: { NetworkID: n.Id } };
        return send(200);
      }
      if ((m = /^\/networks\/([^/]+)$/.exec(p))) {
        const n = findNetwork(m[1]);
        if (!n) return send(404, { message: `network ${m[1]} not found` });
        if (req.method === "DELETE") {
          const on = onNetwork(n);
          if (on.length) return send(403, { message: `error while removing network: network ${n.Name} has active endpoints (${on.map((c) => `name:"${c.Name}" id:"${c.Id.slice(0, 12)}"`).join(", ")})` });
          networks.splice(networks.indexOf(n), 1);
          return send(204);
        }
        return send(200, { ...n, Containers: Object.fromEntries(onNetwork(n).map((c) => [c.Id, { Name: c.Name }])) });
      }
      if (p === "/images/json") return send(200, built.filter((i) => labelled(i.Labels, filtersOf(url).label)));
      if ((m = /^\/images\/([^/]+)$/.exec(p)) && req.method === "DELETE") {
        const i = built.find((x) => x.Id === m![1]);
        if (!i) return send(404, { message: `No such image: ${m[1]}` });
        built.splice(built.indexOf(i), 1);
        return send(200, [{ Deleted: i.Id }]);
      }
      if (p === "/volumes/create" && req.method === "POST") {
        if (!volumes.some((v) => v.Name === body.Name)) volumes.push({ Name: body.Name, Labels: body.Labels ?? null });
        return send(201, volumes.find((v) => v.Name === body.Name));
      }
      if ((m = /^\/volumes\/([^/]+)$/.exec(p))) {
        const v = volumes.find((x) => x.Name === m![1]);
        if (!v) return send(404, { message: `get ${m[1]}: no such volume` });
        if (req.method === "DELETE") {
          volumes.splice(volumes.indexOf(v), 1);
          return send(204);
        }
        return send(200, v);
      }
      send(404, { message: `page not found: ${req.method} ${p}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, dir, images, containers, volumes, networks, built, runs, execs, created, starts, updates, pulls, connects, failing, hold, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
