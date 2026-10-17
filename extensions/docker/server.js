// src/docker.ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// src/engine.ts
import { existsSync } from "node:fs";
import http from "node:http";
var socketPath = () => process.env.DOCKER_SOCKET || "/var/run/docker.sock";
var socketThere = () => existsSync(socketPath());
var DockerError = class extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
  status;
};
function send(method, path2, body, timeoutMs = 3e4) {
  if (!socketThere()) return Promise.reject(new DockerError(`Docker cannot be reached: there is no socket at ${socketPath()}`));
  return new Promise((resolve, reject) => {
    const payload = body === void 0 ? void 0 : JSON.stringify(body);
    const req = http.request(
      { socketPath: socketPath(), path: path2, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    const deadline = setTimeout(() => req.destroy(new DockerError("Docker did not answer in time")), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(`Docker cannot be reached: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}
async function request(method, path2, body) {
  const { status, bytes } = await send(method, path2, body);
  const text = bytes.toString("utf8");
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status, body: parsed };
}
async function checked(method, path2, body) {
  const { status, body: said } = await request(method, path2, body);
  if (status >= 400) throw new DockerError(said?.message || `Docker answered ${status}`, status);
  return said;
}
async function ping() {
  try {
    return (await send("GET", "/_ping", void 0, 5e3)).status === 200;
  } catch {
    return false;
  }
}
function pull(image, onLine) {
  if (!socketThere()) return Promise.reject(new DockerError(`Docker cannot be reached: there is no socket at ${socketPath()}`));
  const at = image.lastIndexOf(":");
  const [name, tag] = at > image.lastIndexOf("/") ? [image.slice(0, at), image.slice(at + 1)] : [image, "latest"];
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socketPath(), path: `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, method: "POST" }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let message = "";
          try {
            message = JSON.parse(Buffer.concat(chunks).toString("utf8")).message ?? "";
          } catch {
          }
          reject(new DockerError(message || `The download of ${image} was refused (${res.statusCode})`, res.statusCode));
        });
        return;
      }
      let rest = "";
      let failed;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim() || failed) continue;
          try {
            const said = JSON.parse(line);
            if (said.error) failed = new DockerError(said.error);
            else if (said.status) onLine(said.progress ? `${said.status} ${said.progress}` : said.status);
          } catch {
          }
        }
      });
      res.on("end", () => failed ? reject(failed) : resolve());
      res.on("error", reject);
    });
    req.on("error", (e) => reject(new DockerError(`Docker cannot be reached: ${e.message}`)));
    req.end();
  });
}
function demux(bytes, tty) {
  if (tty) return bytes.toString("utf8");
  const parts = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(at + 4);
    parts.push(bytes.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}
async function logs(id, tail, tty) {
  const { status, bytes } = await send("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`);
  if (status >= 400) {
    let message = "";
    try {
      message = JSON.parse(bytes.toString("utf8")).message ?? "";
    } catch {
    }
    throw new DockerError(message || `Docker answered ${status}`, status);
  }
  return demux(bytes, tty);
}

// src/docker.ts
var OWNER_LABEL = "pithagoras.extension";
var TAIL = 200;
var MOST_TAIL = 5e3;
var nameOf = (raw) => (raw.Names?.[0] ?? "").replace(/^\//, "");
var validName = (name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
function dockerFor(dataDir) {
  const file = path.join(dataDir, "adopted.json");
  const adopted = () => {
    try {
      const read = JSON.parse(readFileSync(file, "utf8"));
      return { containers: read.containers ?? {}, volumes: read.volumes ?? {} };
    } catch {
      return { containers: {}, volumes: {} };
    }
  };
  const keep = (next) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 384 });
    renameSync(`${file}.tmp`, file);
  };
  const containerOwner = (id, labels) => labels?.[OWNER_LABEL] ?? adopted().containers[id] ?? "";
  const info = (raw) => ({ name: nameOf(raw), id: raw.Id, image: raw.Image, state: raw.State, status: raw.Status, owner: containerOwner(raw.Id, raw.Labels) });
  async function containers() {
    const all = await checked("GET", "/containers/json?all=1");
    return all.map(info).filter((c) => c.owner);
  }
  async function inspect(name) {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    const { status, body } = await request("GET", `/containers/${encodeURIComponent(name)}/json`);
    if (status === 404) return void 0;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body;
  }
  async function get(name) {
    const found = await inspect(name);
    if (!found) return void 0;
    const all = await checked("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ id: [found.Id] }))}`);
    const raw = all.find((c) => c.Id === found.Id);
    return raw ? info(raw) : { name: found.Name.replace(/^\//, ""), id: found.Id, image: found.Config?.Image ?? "", state: found.State?.Status ?? "", status: "", owner: containerOwner(found.Id, found.Config?.Labels) };
  }
  async function own(who, name) {
    const found = await inspect(name);
    if (!found) return void 0;
    const owner = containerOwner(found.Id, found.Config?.Labels);
    if (owner !== who) throw new DockerError(owner ? `${name} is ${owner}'s container, not ${who}'s` : `${name} is no extension's container: take it over first (adopt)`, 403);
    return found;
  }
  async function act(id, verb) {
    if (verb === "remove") {
      await request("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`).catch(() => {
      });
      const { status: status2, body: body2 } = await request("DELETE", `/containers/${encodeURIComponent(id)}?force=true`);
      if (status2 >= 400 && status2 !== 404) throw new DockerError(body2?.message || `Docker answered ${status2}`, status2);
      const was = adopted();
      if (id in was.containers) {
        delete was.containers[id];
        keep(was);
      }
      return;
    }
    const { status, body } = await request("POST", `/containers/${encodeURIComponent(id)}/${verb}${verb === "stop" ? "?t=10" : ""}`);
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
  }
  const pulling = /* @__PURE__ */ new Map();
  async function ensure(image, onProgress) {
    const { status } = await request("GET", `/images/${encodeURIComponent(image)}/json`);
    if (status === 200) return;
    let going = pulling.get(image);
    if (!going) {
      const listeners = /* @__PURE__ */ new Set();
      const tell = (state) => {
        current.last = state;
        for (const listener of listeners) listener(state);
      };
      const current = { listeners, last: { active: true, line: "starting" }, done: Promise.resolve() };
      current.done = pull(image, (line) => tell({ active: true, line })).then(
        () => tell({ active: false, line: "done" }),
        (e) => {
          tell({ active: false, line: "", error: e.message });
          throw e;
        }
      ).finally(() => pulling.delete(image));
      pulling.set(image, going = current);
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
  const volumeOwner = (volume2) => volume2.Labels?.[OWNER_LABEL] ?? adopted().volumes[volume2.Name] ?? "";
  async function volumes() {
    const { Volumes } = await checked("GET", "/volumes");
    return (Volumes ?? []).map((v) => ({ name: v.Name, owner: volumeOwner(v) })).filter((v) => v.owner);
  }
  async function volume(name) {
    if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
    const { status, body } = await request("GET", `/volumes/${encodeURIComponent(name)}`);
    if (status === 404) return void 0;
    if (status >= 400) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    return body;
  }
  async function ownVolume(who, name) {
    const found = await volume(name);
    if (!found) return void 0;
    const owner = volumeOwner(found);
    if (owner !== who) throw new DockerError(owner ? `${name} is ${owner}'s volume, not ${who}'s` : `${name} is no extension's volume: take it over first (adopt)`, 403);
    return found;
  }
  async function removeVolume(name) {
    const { status, body } = await request("DELETE", `/volumes/${encodeURIComponent(name)}`);
    if (status >= 400 && status !== 404) throw new DockerError(body?.message || `Docker answered ${status}`, status);
    const was = adopted();
    if (name in was.volumes) {
      delete was.volumes[name];
      keep(was);
    }
  }
  function forExtension(who) {
    return {
      available: async () => socketThere() && await ping(),
      images: {
        present: async (image) => (await request("GET", `/images/${encodeURIComponent(image)}/json`)).status === 200,
        ensure
      },
      containers: {
        list: async () => (await containers()).filter((c) => c.owner === who),
        get,
        async create(name, spec) {
          if (!validName(name)) throw new DockerError(`"${name}" is not a name Docker takes`);
          if (await own(who, name)) await act(name, "remove");
          const labels = { ...spec.Labels ?? {}, [OWNER_LABEL]: who };
          await checked("POST", `/containers/create?name=${encodeURIComponent(name)}`, { ...spec, Labels: labels });
          return await get(name);
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
          return await get(name);
        }
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
        }
      }
    };
  }
  const person = {
    async overview() {
      if (!socketThere()) return { available: false, socket: false };
      if (!await ping()) return { available: false, socket: true };
      const version = await checked("GET", "/version").catch(() => ({ Version: void 0 }));
      return { available: true, version: version.Version ?? "", containers: await containers(), volumes: await volumes() };
    },
    /** A container of an extension's, for the person to act on: one that is no extension's is not shown, and not theirs to act on here. */
    async container(name) {
      const found = await inspect(name);
      if (!found || !containerOwner(found.Id, found.Config?.Labels)) throw new DockerError(`There is no container ${name} of an extension's`, 404);
      return found;
    },
    start: async (name) => act((await person.container(name)).Id, "start"),
    stop: async (name) => act((await person.container(name)).Id, "stop"),
    remove: async (name) => act((await person.container(name)).Id, "remove"),
    async logs(name, tail = TAIL) {
      const found = await person.container(name);
      return logs(found.Id, Math.min(Math.max(1, Math.floor(tail)), MOST_TAIL), Boolean(found.Config?.Tty));
    },
    async removeVolume(name) {
      const found = await volume(name);
      if (!found || !volumeOwner(found)) throw new DockerError(`There is no volume ${name} of an extension's`, 404);
      await removeVolume(name);
    }
  };
  return { forExtension, person };
}

// src/server.ts
function fail(res, e) {
  const status = e instanceof DockerError ? e.status === 403 || e.status === 404 || e.status === 409 ? e.status : 502 : 500;
  res.status(status).json({ error: e.message });
}
function docker(portal) {
  const { forExtension, person } = dockerFor(portal.dataDir());
  portal.provide((consumer) => forExtension(consumer.name));
  const route = (work) => (req, res) => void work(req, res).catch((e) => fail(res, e));
  portal.router.get("/overview", route(async (_req, res) => res.json(await person.overview())));
  for (const verb of ["start", "stop"]) {
    portal.router.post(`/containers/:name/${verb}`, route(async (req, res) => {
      await person[verb](req.params.name);
      res.json({ ok: true });
    }));
  }
  portal.router.delete("/containers/:name", route(async (req, res) => {
    await person.remove(req.params.name);
    res.json({ ok: true });
  }));
  portal.router.get("/containers/:name/logs", route(async (req, res) => {
    const tail = Number(req.query.tail);
    res.json({ text: await person.logs(req.params.name, Number.isFinite(tail) && tail > 0 ? tail : void 0) });
  }));
  portal.router.delete("/volumes/:name", route(async (req, res) => {
    await person.removeVolume(req.params.name);
    res.json({ ok: true });
  }));
}
export {
  docker as default
};
