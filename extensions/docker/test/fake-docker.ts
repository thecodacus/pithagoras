import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A Docker daemon for the tests, on a socket of its own: the endpoints the extension uses, answered as Docker answers
 * them, from what it holds. `containers` and `volumes` may be filled by a test, as if made with the docker command.
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
}

export async function fakeDocker() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dk-"));
  const socket = path.join(dir, "docker.sock");
  const images = new Set<string>();
  const containers: FakeContainer[] = [];
  const volumes: { Name: string; Labels: Record<string, string> | null }[] = [];
  const pulls: string[] = [];
  /** A download that fails, by image, with Docker's own words. */
  const failing = new Map<string, string>();
  let ids = 0;

  const find = (key: string) => containers.find((c) => c.Id === key || c.Name === key);
  const raw = (c: FakeContainer) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image, State: c.State, Status: c.State === "running" ? "Up 2 minutes" : "Exited (0) 1 minute ago", Labels: c.Labels });
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
          const failure = failing.get(image);
          if (failure) res.end(`${JSON.stringify({ error: failure })}\n`);
          else {
            images.add(image);
            res.end(`${JSON.stringify({ status: "Downloaded newer image" })}\n`);
          }
        }, 20);
        return;
      }
      if (p === "/containers/json") {
        const filters = url.searchParams.get("filters");
        const only = filters ? (JSON.parse(filters).id as string[]) : undefined;
        return send(200, containers.filter((c) => !only || only.includes(c.Id)).map(raw));
      }
      if (p === "/containers/create" && req.method === "POST") {
        const name = url.searchParams.get("name")!;
        if (find(name)) return send(409, { message: `Conflict. The container name "/${name}" is already in use` });
        const made: FakeContainer = { Id: `id${++ids}`.padEnd(12, "0"), Name: name, Image: body.Image, State: "created", Labels: body.Labels ?? {}, Tty: Boolean(body.Tty), out: "", err: "" };
        containers.push(made);
        return send(201, { Id: made.Id });
      }
      if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
        const c = find(m[1]);
        return c ? send(200, { Id: c.Id, Name: `/${c.Name}`, Config: { Image: c.Image, Tty: c.Tty, Labels: c.Labels }, State: { Status: c.State, Running: c.State === "running" } }) : send(404, { message: `No such container: ${m[1]}` });
      }
      if ((m = /^\/containers\/([^/]+)\/(start|stop)$/.exec(p))) {
        const c = find(m[1]);
        if (!c) return send(404, { message: `No such container: ${m[1]}` });
        const want = m[2] === "start" ? "running" : "exited";
        if (c.State === want) return send(304);
        c.State = want;
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
        res.writeHead(200, { "content-type": c.Tty ? "application/vnd.docker.raw-stream" : "application/vnd.docker.multiplexed-stream" });
        return res.end(c.Tty ? Buffer.from(c.out + c.err) : Buffer.concat([frame(1, c.out), frame(2, c.err)]));
      }
      if (p === "/volumes") return send(200, { Volumes: volumes });
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
  return { socket, dir, images, containers, volumes, pulls, failing, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
